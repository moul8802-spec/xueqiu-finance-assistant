import { env } from 'cloudflare:workers';
import { organizeFinancialMessages } from '@/lib/ai';
import type { FeishuChat, FeishuMessage } from '@/lib/feishu';

export type DraftStatus = 'pending' | 'copied' | 'skipped' | 'published';

export type DraftRecord = {
  id: string;
  title: string;
  body: string;
  status: DraftStatus;
  category: string;
  topicKey: string;
  sourceChatId: string;
  sourceLabel: string;
  sourceMessageIds: string[];
  reviewFlags: string[];
  metadata: DraftMetadata;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
};

export type DraftMetadata = {
  originalText?: string;
  keyPoints?: string[];
  factCheckFlags?: string[];
  organizationMode?: 'ai' | 'rules' | 'feishu' | 'none';
};

export type InboundMessage = {
  eventId: string;
  messageId: string;
  chatId: string;
  chatName?: string;
  senderId?: string;
  text: string;
  simulated?: boolean;
};

export type AuditRecord = {
  id: number;
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: number;
};

export type DevicePairing = {
  id: string;
  label: string;
  platform: 'ios' | 'windows';
  tokenHint: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  expiresAt: number | null;
};

const FINANCE_RULES = [
  { category: '宏观', topic: 'macro', words: ['央行', '利率', '逆回购', '降准', '货币', '流动性', '社融', 'CPI', 'PPI', 'GDP'] },
  { category: '公司', topic: 'company', words: ['回购', '增持', '减持', '业绩', '营收', '净利润', '公告', '分红'] },
  { category: '行业', topic: 'industry', words: ['行业', '产量', '销量', '库存', '出口', '进口', '价格指数'] },
  { category: '市场', topic: 'market', words: ['A股', '港股', '成交额', '北向', '指数', '涨停', '债券', '汇率'] },
] as const;

let databaseReady: Promise<void> | null = null;

export async function ensureDatabase() {
  if (databaseReady) return databaseReady;
  databaseReady = (async () => {
  const db = env.DB;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_chat_id ON sources(chat_id)'),
    db.prepare('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT, sanitized_content TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, duplicate_of TEXT, received_at INTEGER NOT NULL)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_event_id ON messages(event_id)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_hash_received ON messages(content_hash, received_at)'),
    db.prepare("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', category TEXT NOT NULL, topic_key TEXT NOT NULL, source_chat_id TEXT NOT NULL, source_label TEXT NOT NULL, source_message_ids TEXT NOT NULL, review_flags TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reviewed_at INTEGER)"),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_drafts_status_updated ON drafts(status, updated_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_drafts_merge_window ON drafts(source_chat_id, topic_key, created_at)'),
    db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)"),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)'),
    db.prepare("CREATE TABLE IF NOT EXISTS feishu_connections (actor_id TEXT PRIMARY KEY, feishu_open_id TEXT, feishu_union_id TEXT, tenant_key TEXT, name TEXT, avatar_url TEXT, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT, token_type TEXT NOT NULL DEFAULT 'Bearer', scope TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL, refresh_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare('CREATE TABLE IF NOT EXISTS feishu_oauth_states (state_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_feishu_oauth_states_actor ON feishu_oauth_states(actor_id, expires_at)'),
    db.prepare('CREATE TABLE IF NOT EXISTS feishu_selected_chats (actor_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, external INTEGER NOT NULL DEFAULT 0, tenant_key TEXT, updated_at INTEGER NOT NULL)'),
    db.prepare("CREATE TABLE IF NOT EXISTS device_pairings (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL, token_hint TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, expires_at INTEGER)"),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_device_pairings_token_hash ON device_pairings(token_hash)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_device_pairings_actor ON device_pairings(actor_id, created_at)'),
  ]);
  try { await db.prepare("ALTER TABLE drafts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'").run(); } catch { /* already present */ }
  })();
  try {
    await databaseReady;
  } catch (error) {
    databaseReady = null;
    throw error;
  }
}

export async function createAiDraftFromFeishuMessages(
  actorId: string,
  actorLabel: string,
  chat: FeishuChat,
  messages: FeishuMessage[],
) {
  await ensureDatabase();
  const allowlisted = await env.DB.prepare('SELECT chat_id FROM feishu_selected_chats WHERE actor_id = ? AND chat_id = ?')
    .bind(actorId, chat.chatId).first<{ chat_id: string }>();
  if (!allowlisted) throw new Error('CHAT_NOT_ALLOWLISTED');

  const now = Date.now();
  const candidates: Array<{ rowId: string; message: FeishuMessage; text: string; flags: string[]; hash: string }> = [];
  const duplicateRows: D1PreparedStatement[] = [];
  let duplicateCount = 0;
  let unsupportedCount = 0;
  const batchHashes = new Map<string, string>();

  for (const message of messages) {
    if (!message.text) {
      unsupportedCount += 1;
      continue;
    }
    const existingId = await env.DB.prepare('SELECT id FROM messages WHERE event_id = ? OR message_id = ? LIMIT 1')
      .bind(`history:${message.messageId}`, message.messageId).first<{ id: string }>();
    if (existingId) {
      duplicateCount += 1;
      continue;
    }
    const sanitized = sanitizeText(message.text);
    const hash = await sha256(normalizeForDedupe(sanitized.text));
    const recent = await env.DB.prepare('SELECT id FROM messages WHERE content_hash = ? AND received_at > ? LIMIT 1')
      .bind(hash, now - 24 * 60 * 60 * 1000).first<{ id: string }>();
    const withinBatch = batchHashes.get(hash);
    const rowId = crypto.randomUUID();
    if (recent || withinBatch) {
      duplicateRows.push(env.DB.prepare('INSERT INTO messages (id, event_id, message_id, chat_id, sender_id, sanitized_content, content_hash, status, duplicate_of, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(rowId, `history:${message.messageId}`, message.messageId, chat.chatId, message.senderId, sanitized.text, hash, 'duplicate', recent?.id || withinBatch, now));
      duplicateCount += 1;
      continue;
    }
    batchHashes.set(hash, rowId);
    candidates.push({ rowId, message, text: sanitized.text, flags: sanitized.flags, hash });
  }

  if (!candidates.length) {
    if (duplicateRows.length) await env.DB.batch(duplicateRows);
    await log('feishu_history_no_new_messages', actorLabel, 'chat', chat.chatId, { duplicateCount, unsupportedCount });
    return { outcome: 'no_new_messages' as const, duplicateCount, unsupportedCount };
  }

  const organization = await organizeFinancialMessages(candidates.map((candidate) => ({
    messageId: candidate.message.messageId,
    text: candidate.text,
    createTime: candidate.message.createTime,
  })));
  const selectedIds = new Set(organization.selectedMessageIds);
  const selected = candidates.filter((candidate) => selectedIds.has(candidate.message.messageId));
  const messageStatements = candidates.map((candidate) => env.DB.prepare('INSERT INTO messages (id, event_id, message_id, chat_id, sender_id, sanitized_content, content_hash, status, duplicate_of, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .bind(candidate.rowId, `history:${candidate.message.messageId}`, candidate.message.messageId, chat.chatId, candidate.message.senderId, candidate.text, candidate.hash, selectedIds.has(candidate.message.messageId) ? 'queued' : 'filtered', now));

  if (!selected.length || !organization.title || !organization.body) {
    await env.DB.batch([...duplicateRows, ...messageStatements]);
    await log('feishu_history_filtered', actorLabel, 'chat', chat.chatId, { inspected: candidates.length, duplicateCount, unsupportedCount });
    return { outcome: 'filtered' as const, inspected: candidates.length, duplicateCount, unsupportedCount };
  }

  const draftId = crypto.randomUUID();
  const flags = Array.from(new Set(selected.flatMap((candidate) => candidate.flags)));
  const sourceLabel = chat.external ? `${chat.name}（外部群）` : chat.name;
  const body = `${organization.body}\n\n以上信息由 AI 根据飞书群消息整理，关键数字与口径请在发布前人工核对。\n\n来源：${sourceLabel}`;
  const metadata: DraftMetadata = { originalText: selected.map((candidate) => candidate.text).join('\n'), keyPoints: selected.map((candidate) => candidate.text), factCheckFlags: ['待人工核验：时间、数字、主体与来源', 'AI整理结果不等于事实确认'], organizationMode: 'feishu' };
  const draftStatement = env.DB.prepare('INSERT INTO drafts (id, title, body, status, category, topic_key, source_chat_id, source_label, source_message_ids, review_flags, metadata_json, created_at, updated_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
    .bind(draftId, organization.title, body, 'pending', organization.category, `ai-${organization.category}`, chat.chatId, sourceLabel,
      JSON.stringify(selected.map((candidate) => candidate.message.messageId)), JSON.stringify(flags), JSON.stringify(metadata), now, now);
  const auditStatement = env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('ai_draft_created', actorLabel, 'draft', draftId, JSON.stringify({ chatId: chat.chatId, messageCount: selected.length, duplicateCount, external: chat.external }), now);
  await env.DB.batch([...duplicateRows, ...messageStatements, draftStatement, auditStatement]);
  return { outcome: 'created' as const, draftId, selectedCount: selected.length, duplicateCount, unsupportedCount };
}

export async function createDraftFromImportedMessages(
  actorId: string,
  actorLabel: string,
  input: { sourceLabel?: string; text: string; importSource?: string; devicePairingId?: string; clientMessageId?: string },
) {
  await ensureDatabase();
  const rawMessages = splitImportedMessages(input.text);
  if (!rawMessages.length) throw new Error('IMPORT_TEXT_REQUIRED');
  if (rawMessages.length > 50) throw new Error('IMPORT_TOO_MANY_MESSAGES');

  const now = Date.now();
  const sourceLabel = sanitizeText(input.sourceLabel || 'iPhone 飞书消息导入').text.slice(0, 80) || 'iPhone 飞书消息导入';
  const sourceChatId = `manual-import:${(await sha256(actorId)).slice(0, 16)}`;
  const candidates: Array<{ rowId: string; messageId: string; text: string; flags: string[]; hash: string; match: ReturnType<typeof matchFinanceTopic> }> = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const raw of rawMessages) {
    const sanitized = sanitizeText(raw);
    if (!sanitized.text) continue;
    const hash = await sha256(normalizeForDedupe(sanitized.text));
    if (seen.has(hash)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(hash);
    const messageId = `manual:${hash}`;
    const existing = await env.DB.prepare('SELECT id FROM messages WHERE message_id = ? OR content_hash = ? LIMIT 1')
      .bind(messageId, hash).first<{ id: string }>();
    if (existing) {
      duplicateCount += 1;
      continue;
    }
    candidates.push({
      rowId: crypto.randomUUID(),
      messageId,
      text: sanitized.text,
      flags: sanitized.flags,
      hash,
      match: matchFinanceTopic(sanitized.text),
    });
  }

  if (!candidates.length) {
    await log('manual_import_no_new_messages', actorLabel, 'source', sourceChatId, {
      inputCount: rawMessages.length,
      duplicateCount,
      sourceLabel,
    });
    return { outcome: 'no_new_messages' as const, inputCount: rawMessages.length, duplicateCount, selectedCount: 0, organizationMode: 'none' as const };
  }

  let selectedIds: Set<string>;
  let category: AiOrganizationCategory;
  let title: string;
  let body: string;
  let organizationMode: 'ai' | 'rules';

  if (env.OPENAI_API_KEY && env.OPENAI_MODEL) {
    const organization = await organizeFinancialMessages(candidates.map((candidate, index) => ({
      messageId: candidate.messageId,
      text: candidate.text,
      createTime: now + index,
    })));
    selectedIds = new Set(organization.selectedMessageIds);
    category = organization.category;
    title = organization.title;
    body = organization.body;
    organizationMode = 'ai';
  } else {
    const financial = candidates.filter((candidate) => candidate.match);
    selectedIds = new Set(financial.map((candidate) => candidate.messageId));
    category = financial[0]?.match?.category ?? '其他';
    title = financial[0] ? makeTitle(financial[0].text, category) : '';
    body = financial.map((candidate) => `• ${candidate.text}`).join('\n');
    organizationMode = 'rules';
  }

  const selected = candidates.filter((candidate) => selectedIds.has(candidate.messageId));
  const messageStatements = candidates.map((candidate) => env.DB.prepare('INSERT INTO messages (id, event_id, message_id, chat_id, sender_id, sanitized_content, content_hash, status, duplicate_of, received_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)')
    .bind(candidate.rowId, `manual:${candidate.hash}`, candidate.messageId, sourceChatId, candidate.text, candidate.hash, selectedIds.has(candidate.messageId) ? 'queued' : 'filtered', now));

  if (!selected.length || !title || !body) {
    await env.DB.batch(messageStatements);
    await log('manual_import_filtered', actorLabel, 'source', sourceChatId, {
      inputCount: rawMessages.length,
      acceptedCount: candidates.length,
      duplicateCount,
      sourceLabel,
      organizationMode,
    });
    return { outcome: 'filtered' as const, inputCount: rawMessages.length, duplicateCount, selectedCount: 0, organizationMode };
  }

  const draftId = crypto.randomUUID();
  const flags = Array.from(new Set(selected.flatMap((candidate) => candidate.flags)));
  const disclaimer = organizationMode === 'ai'
    ? '以上信息由 AI 根据导入消息整理，关键数字与口径请在发布前人工核对。'
    : '以上信息由系统根据财经关键词结构化整理，关键数字与口径请在发布前人工核对。';
  const draftBody = `${body}\n\n${disclaimer}\n\n来源：${sourceLabel}`;
  const metadata: DraftMetadata = {
    originalText: selected.map((candidate) => candidate.text).join('\n'),
    keyPoints: selected.map((candidate) => candidate.text),
    factCheckFlags: ['待人工核验：时间、数字、主体与来源', organizationMode === 'ai' ? 'AI提炼仅供辅助，未完成事实核验' : '规则模式：未调用AI，未完成事实核验'],
    organizationMode,
  };
  const draftStatement = env.DB.prepare('INSERT INTO drafts (id, title, body, status, category, topic_key, source_chat_id, source_label, source_message_ids, review_flags, metadata_json, created_at, updated_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
    .bind(draftId, title, draftBody, 'pending', category, `manual-${category}`, sourceChatId, sourceLabel,
      JSON.stringify(selected.map((candidate) => candidate.messageId)), JSON.stringify(flags), JSON.stringify(metadata), now, now);
  const auditStatement = env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('manual_import_draft_created', actorLabel, 'draft', draftId, JSON.stringify({
      sourceLabel,
      inputCount: rawMessages.length,
      acceptedCount: candidates.length,
      selectedCount: selected.length,
      duplicateCount,
      redactedCount: flags.length,
      organizationMode,
      importSource: input.importSource ?? 'manual',
      devicePairingId: input.devicePairingId,
      clientMessageId: input.clientMessageId,
    }), now);
  await env.DB.batch([...messageStatements, draftStatement, auditStatement]);
  return {
    outcome: 'created' as const,
    draftId,
    inputCount: rawMessages.length,
    acceptedCount: candidates.length,
    selectedCount: selected.length,
    duplicateCount,
    redactedCount: flags.length,
    organizationMode,
  };
}

export async function listDrafts(status = 'pending'): Promise<DraftRecord[]> {
  await ensureDatabase();
  const result = await env.DB.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY updated_at DESC LIMIT 50')
    .bind(status).all<Record<string, unknown>>();
  return result.results.map(mapDraft);
}

export async function createDevicePairing(actorId: string, label: string, platform: 'ios' | 'windows') {
  await ensureDatabase();
  const safeLabel = sanitizeText(label).text.slice(0, 80) || (platform === 'ios' ? 'iPhone 快捷指令' : 'Windows 剪贴板');
  const token = randomDeviceToken();
  const tokenHash = await sha256(`device-token:${token}`);
  const now = Date.now();
  const expiresAt = now + 180 * 24 * 60 * 60 * 1000;
  const id = crypto.randomUUID();
  const tokenHint = `${token.slice(0, 6)}…${token.slice(-4)}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO device_pairings (id, actor_id, label, platform, token_hash, token_hint, created_at, last_used_at, revoked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)')
      .bind(id, actorId, safeLabel, platform, tokenHash, tokenHint, now, expiresAt),
    env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('device_pairing_created', actorId, 'device_pairing', id, JSON.stringify({ label: safeLabel, platform, tokenHint, expiresAt }), now),
  ]);
  return { id, label: safeLabel, platform, token, tokenHint, createdAt: now, expiresAt };
}

export async function listDevicePairings(actorId: string): Promise<DevicePairing[]> {
  await ensureDatabase();
  const result = await env.DB.prepare('SELECT id, label, platform, token_hint, created_at, last_used_at, revoked_at, expires_at FROM device_pairings WHERE actor_id = ? ORDER BY created_at DESC')
    .bind(actorId).all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: String(row.id), label: String(row.label), platform: String(row.platform) as 'ios' | 'windows', tokenHint: String(row.token_hint),
    createdAt: Number(row.created_at), lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at), expiresAt: row.expires_at == null ? null : Number(row.expires_at),
  }));
}

export async function revokeDevicePairing(actorId: string, id: string) {
  await ensureDatabase();
  const now = Date.now();
  const current = await env.DB.prepare('SELECT id FROM device_pairings WHERE id = ? AND actor_id = ?').bind(id, actorId).first<{ id: string }>();
  if (!current) return false;
  await env.DB.batch([
    env.DB.prepare('UPDATE device_pairings SET revoked_at = ? WHERE id = ? AND actor_id = ? AND revoked_at IS NULL').bind(now, id, actorId),
    env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('device_pairing_revoked', actorId, 'device_pairing', id, '{}', now),
  ]);
  return true;
}

export async function authorizeDeviceToken(token: string) {
  await ensureDatabase();
  const tokenHash = await sha256(`device-token:${token}`);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT id, actor_id, label, platform, expires_at FROM device_pairings WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1')
    .bind(tokenHash, now).first<Record<string, unknown>>();
  if (!row) return null;
  await env.DB.prepare('UPDATE device_pairings SET last_used_at = ? WHERE id = ?').bind(now, String(row.id)).run();
  return { id: String(row.id), actorId: String(row.actor_id), label: String(row.label), platform: String(row.platform) as 'ios' | 'windows' };
}

export async function listAuditLogs(limit = 50): Promise<AuditRecord[]> {
  await ensureDatabase();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
    .bind(safeLimit).all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: Number(row.id),
    action: String(row.action),
    actor: String(row.actor),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    details: safeJsonObject(row.details_json),
    createdAt: Number(row.created_at),
  }));
}

export async function updateDraft(
  id: string,
  patch: { body?: string; status?: DraftStatus },
  actor: string,
): Promise<DraftRecord | null> {
  await ensureDatabase();
  const current = await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!current) return null;
  const now = Date.now();
  const body = patch.body?.trim() || String(current.body);
  const status = patch.status ?? String(current.status);
  const reviewedAt = status === 'pending' ? null : now;
  await env.DB.batch([
    env.DB.prepare('UPDATE drafts SET body = ?, status = ?, updated_at = ?, reviewed_at = ? WHERE id = ?')
      .bind(body, status, now, reviewedAt, id),
    env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('draft_updated', actor, 'draft', id, JSON.stringify({ fields: Object.keys(patch), status }), now),
  ]);
  const updated = await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return updated ? mapDraft(updated) : null;
}

export async function processInboundMessage(input: InboundMessage) {
  await ensureDatabase();
  const now = Date.now();
  const allowed = allowedChatIds();
  if (!input.simulated && (allowed.length === 0 || !allowed.includes(input.chatId))) {
    await log('source_rejected', 'feishu', 'message', input.messageId, { chatId: input.chatId });
    return { outcome: 'rejected' as const, reason: 'chat_not_allowed' };
  }

  const existing = await env.DB.prepare('SELECT id FROM messages WHERE event_id = ? OR message_id = ? LIMIT 1')
    .bind(input.eventId, input.messageId).first<{ id: string }>();
  if (existing) {
    await log('message_duplicate', input.simulated ? 'simulator' : 'feishu', 'message', existing.id, { reason: 'repeated_identifier' });
    return { outcome: 'duplicate' as const, messageId: existing.id };
  }

  const { text, flags } = sanitizeText(input.text);
  const contentHash = await sha256(normalizeForDedupe(text));
  const recentDuplicate = await env.DB.prepare('SELECT id FROM messages WHERE content_hash = ? AND received_at > ? LIMIT 1')
    .bind(contentHash, now - 24 * 60 * 60 * 1000).first<{ id: string }>();
  const messageRowId = crypto.randomUUID();

  if (recentDuplicate) {
    await env.DB.prepare('INSERT INTO messages (id, event_id, message_id, chat_id, sender_id, sanitized_content, content_hash, status, duplicate_of, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(messageRowId, input.eventId, input.messageId, input.chatId, input.senderId ?? null, text, contentHash, 'duplicate', recentDuplicate.id, now).run();
    await log('message_duplicate', input.simulated ? 'simulator' : 'feishu', 'message', messageRowId, { reason: 'same_content_24h', duplicateOf: recentDuplicate.id });
    return { outcome: 'duplicate' as const, messageId: messageRowId };
  }

  const match = matchFinanceTopic(text);
  const messageStatus = match ? 'queued' : 'filtered';
  await env.DB.prepare('INSERT INTO messages (id, event_id, message_id, chat_id, sender_id, sanitized_content, content_hash, status, duplicate_of, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .bind(messageRowId, input.eventId, input.messageId, input.chatId, input.senderId ?? null, text, contentHash, messageStatus, now).run();

  if (!match) {
    await log('message_filtered', input.simulated ? 'simulator' : 'feishu', 'message', messageRowId, { reason: 'not_financial' });
    return { outcome: 'filtered' as const, messageId: messageRowId };
  }

  const sourceLabel = input.chatName || configuredChatName(input.chatId) || `飞书群 ${maskId(input.chatId)}`;
  const mergeCandidate = await env.DB.prepare("SELECT * FROM drafts WHERE status = 'pending' AND source_chat_id = ? AND topic_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(input.chatId, match.topic, now - 30 * 60 * 1000).first<Record<string, unknown>>();

  if (mergeCandidate) {
    const draft = mapDraft(mergeCandidate);
    const body = mergeDraftBody(draft.body, text, sourceLabel);
    const ids = [...draft.sourceMessageIds, input.messageId];
    const combinedFlags = Array.from(new Set([...draft.reviewFlags, ...flags]));
    await env.DB.prepare('UPDATE drafts SET body = ?, source_message_ids = ?, review_flags = ?, updated_at = ? WHERE id = ?')
      .bind(body, JSON.stringify(ids), JSON.stringify(combinedFlags), now, draft.id).run();
    await log('message_merged', input.simulated ? 'simulator' : 'feishu', 'draft', draft.id, { messageId: input.messageId });
    return { outcome: 'merged' as const, draftId: draft.id };
  }

  const draftId = crypto.randomUUID();
  const title = makeTitle(text, match.category);
  const body = makeDraftBody(text, sourceLabel);
  const metadata: DraftMetadata = { originalText: text, keyPoints: [text], factCheckFlags: ['待人工核验：时间、数字、主体与来源'], organizationMode: 'feishu' };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO drafts (id, title, body, status, category, topic_key, source_chat_id, source_label, source_message_ids, review_flags, metadata_json, created_at, updated_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .bind(draftId, title, body, 'pending', match.category, match.topic, input.chatId, sourceLabel, JSON.stringify([input.messageId]), JSON.stringify(flags), JSON.stringify(metadata), now, now),
    env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('draft_created', input.simulated ? 'simulator' : 'feishu', 'draft', draftId, JSON.stringify({ messageId: input.messageId, category: match.category }), now),
  ]);
  return { outcome: 'created' as const, draftId };
}

export async function getSystemStatus() {
  await ensureDatabase();
  const [pending, duplicates, messages] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM drafts WHERE status = 'pending'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE status = 'duplicate' AND received_at > ?").bind(startOfToday()).first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE received_at > ?').bind(startOfToday()).first<{ count: number }>(),
  ]);
  return {
    mode: env.SIMULATION_MODE === 'true' ? 'simulation' : 'live',
    configured: Boolean(env.FEISHU_VERIFICATION_TOKEN && allowedChatIds().length),
    allowedChats: allowedChatIds().length,
    pending: pending?.count ?? 0,
    duplicatesToday: duplicates?.count ?? 0,
    messagesToday: messages?.count ?? 0,
  };
}

function mapDraft(row: Record<string, unknown>): DraftRecord {
  return {
    id: String(row.id), title: String(row.title), body: String(row.body), status: String(row.status) as DraftStatus,
    category: String(row.category), topicKey: String(row.topic_key), sourceChatId: String(row.source_chat_id),
    sourceLabel: String(row.source_label), sourceMessageIds: safeJsonArray(row.source_message_ids),
    reviewFlags: safeJsonArray(row.review_flags), metadata: safeJsonObject(row.metadata_json), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
  };
}

function allowedChatIds() {
  return (env.FEISHU_ALLOWED_CHAT_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function configuredChatName(chatId: string) {
  const ids = allowedChatIds();
  const names = (env.FEISHU_ALLOWED_CHAT_NAMES ?? '').split(',').map((value) => value.trim());
  const index = ids.indexOf(chatId);
  return index >= 0 ? names[index] : undefined;
}

function matchFinanceTopic(text: string) {
  return FINANCE_RULES.find((rule) => rule.words.some((word) => text.includes(word))) ?? null;
}

type AiOrganizationCategory = '宏观' | '公司' | '行业' | '市场' | '其他';

function splitImportedMessages(raw: string) {
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d{1,3}[.、)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 51);
}

export function sanitizeText(raw: string) {
  const flags: string[] = [];
  let text = raw.replace(/\s+/g, ' ').trim().slice(0, 4000);
  const rules: Array<[RegExp, string, string]> = [
    [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]', 'phone_redacted'],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]', 'email_redacted'],
    [/(?<!\d)\d{17}[\dXx](?!\d)/g, '[证件号已隐藏]', 'id_redacted'],
    [/(?:token|secret|password|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '[敏感凭证已隐藏]', 'credential_redacted'],
  ];
  for (const [pattern, replacement, flag] of rules) {
    if (pattern.test(text)) flags.push(flag);
    text = text.replace(pattern, replacement);
  }
  return { text, flags };
}

function makeTitle(text: string, category: string) {
  const cleaned = text.replace(/[。！？].*$/, '').trim();
  return (cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned) || `${category}信息待核对`;
}

function makeDraftBody(text: string, sourceLabel: string) {
  const normalized = text.replace(/\s*([。！？])\s*/g, '$1').trim();
  const first = /[。！？]$/.test(normalized) ? normalized : `${normalized}。`;
  return `${first}\n\n以上信息来自公开群消息整理，关键数字与口径请在发布前核对。\n\n来源：${sourceLabel}`;
}

function mergeDraftBody(body: string, text: string, sourceLabel: string) {
  const withoutSource = body.replace(/\n\n来源：[\s\S]*$/, '');
  const normalized = /[。！？]$/.test(text) ? text : `${text}。`;
  return `${withoutSource}\n\n补充信息：${normalized}\n\n来源：${sourceLabel}（合并多条消息）`;
}

function normalizeForDedupe(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomDeviceToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function maskId(value: string) {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

async function log(action: string, actor: string, entityType: string, entityId: string, details: object) {
  await env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(action, actor, entityType, entityId, JSON.stringify(details), Date.now()).run();
}
