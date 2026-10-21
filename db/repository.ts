import { env } from 'cloudflare:workers';
import { organizeFinancialMessages, type AiMessageInput } from '@/lib/ai';
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
  senderName?: string;
  source?: string;
  sourceUrl?: string;
  eventTimestamp?: number;
  actorId?: string;
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
  { category: 'A股盘面', topic: 'a-share', words: ['A股', '上证', '深证', '创业板', '成交额', '北向', '指数', '涨停'] },
  { category: '政策监管', topic: 'policy', words: ['政策', '监管', '央行', '证监会', '降准', '利率', '逆回购', '货币', '流动性', '社融'] },
  { category: '公司公告', topic: 'company', words: ['回购', '增持', '减持', '业绩', '营收', '净利润', '公告', '分红', '问询函'] },
  { category: '科技产业', topic: 'technology', words: ['芯片', '人工智能', 'AI', '半导体', '算力', '机器人', '新能源', '科技'] },
  { category: '资金面', topic: 'funds', words: ['资金', '融资', '融券', '主力', '北向', '流入', '流出', '成交'] },
  { category: '解禁减持', topic: 'unlock', words: ['解禁', '减持', '增持', '股东减持', '限售股'] },
  { category: '海外市场', topic: 'overseas', words: ['美股', '港股', '纳指', '标普', '道指', '海外', '汇率', '美联储'] },
  { category: '宏观', topic: 'macro', words: ['CPI', 'PPI', 'GDP', '通胀', '就业', '宏观经济', '出口', '进口'] },
] as const;

let databaseReady: Promise<void> | null = null;

export async function ensureDatabase() {
  if (databaseReady) return databaseReady;
  databaseReady = (async () => {
  const db = env.DB;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_chat_id ON sources(chat_id)'),
    db.prepare("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT, sender_name TEXT, source TEXT NOT NULL DEFAULT 'feishu', original_content TEXT, sanitized_content TEXT NOT NULL, content_hash TEXT NOT NULL, source_url TEXT, event_timestamp INTEGER, processed_at INTEGER, status TEXT NOT NULL, duplicate_of TEXT, received_at INTEGER NOT NULL)"),
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
    db.prepare("CREATE TABLE IF NOT EXISTS collector_state (id TEXT PRIMARY KEY, last_received_at INTEGER, last_success_at INTEGER, last_error TEXT, connection_state TEXT NOT NULL DEFAULT 'disabled', consecutive_failures INTEGER NOT NULL DEFAULT 0, last_event_id TEXT, updated_at INTEGER NOT NULL)"),
  ]);
  for (const statement of [
    "ALTER TABLE messages ADD COLUMN sender_name TEXT",
    "ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'feishu'",
    "ALTER TABLE messages ADD COLUMN original_content TEXT",
    "ALTER TABLE messages ADD COLUMN source_url TEXT",
    "ALTER TABLE messages ADD COLUMN event_timestamp INTEGER",
    "ALTER TABLE messages ADD COLUMN processed_at INTEGER",
  ]) {
    try { await db.prepare(statement).run(); } catch { /* column already exists */ }
  }
  try { await db.prepare("ALTER TABLE drafts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'").run(); } catch { /* already present */ }
  try { await db.prepare("ALTER TABLE collector_state ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'disabled'").run(); } catch { /* already present */ }
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

  if ((env.AI_API_KEY || env.OPENAI_API_KEY) && (env.AI_MODEL || env.OPENAI_MODEL)) {
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
  const selected = input.actorId
    ? await env.DB.prepare('SELECT chat_id, name FROM feishu_selected_chats WHERE actor_id = ? AND chat_id = ?')
      .bind(input.actorId, input.chatId).first<{ chat_id: string; name: string }>()
    : null;
  const allowed = input.simulated || (selected ? true : allowedChatIds().includes(input.chatId));
  if (!allowed) {
    await log('source_rejected', 'feishu', 'message', input.messageId, { chatId: input.chatId, actorId: input.actorId ?? null });
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
  const source = input.source || 'feishu_group_event';
  const messageInsert = (status: string, duplicateOf: string | null = null) => env.DB.prepare(
    'INSERT INTO messages (id, event_id, message_id, chat_id, sender_id, sender_name, source, original_content, sanitized_content, content_hash, source_url, event_timestamp, processed_at, status, duplicate_of, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    messageRowId, input.eventId, input.messageId, input.chatId, input.senderId ?? null, input.senderName ?? null,
    source, input.text, text, contentHash, input.sourceUrl ?? null, input.eventTimestamp ?? now, now, status, duplicateOf, now,
  );

  if (recentDuplicate) {
    await messageInsert('duplicate', recentDuplicate.id).run();
    await log('message_duplicate', input.simulated ? 'simulator' : 'feishu', 'message', messageRowId, { reason: 'same_content_24h', duplicateOf: recentDuplicate.id });
    return { outcome: 'duplicate' as const, messageId: messageRowId };
  }

  const sourceLabel = input.chatName || selected?.name || configuredChatName(input.chatId) || `飞书群 ${maskId(input.chatId)}`;
  let category: AiOrganizationCategory = '其他';
  let topic = 'other';
  let title = '';
  let body = '';
  let organizationMode: DraftMetadata['organizationMode'] = 'rules';
  let selectedByClassifier = false;
  const organizationFlags = [...flags];

  if (env.AI_API_KEY || env.OPENAI_API_KEY) {
    try {
      const organization = await organizeFinancialMessages([{ messageId: input.messageId, text, createTime: input.eventTimestamp ?? now }]);
      selectedByClassifier = organization.selectedMessageIds.includes(input.messageId);
      category = organization.category;
      topic = `ai-${category}`;
      title = organization.title;
      body = organization.body;
      organizationMode = 'ai';
      if (!selectedByClassifier) organizationFlags.push('AI判断为低价值或缺少明确事实');
    } catch (error) {
      organizationFlags.push('AI处理失败，已回退规则模式，需人工核验');
      await log('ai_organization_failed', 'feishu', 'message', messageRowId, { code: error instanceof Error ? error.name : 'AI_ERROR' });
    }
  }

  if (organizationMode !== 'ai') {
    const match = matchFinanceTopic(text);
    if (match) {
      selectedByClassifier = true;
      category = match.category;
      topic = match.topic;
      title = makeTitle(text, category);
      body = makeDraftBody(text, sourceLabel);
    }
  }

  if (!selectedByClassifier || !title || !body) {
    await messageInsert('filtered').run();
    await log('message_filtered', input.simulated ? 'simulator' : 'feishu', 'message', messageRowId, {
      reason: organizationMode === 'ai' ? 'ai_classifier_rejected' : 'not_financial', source,
    });
    return { outcome: 'filtered' as const, messageId: messageRowId, organizationMode };
  }

  await messageInsert('queued').run();
  const mergeCandidate = await env.DB.prepare("SELECT * FROM drafts WHERE status = 'pending' AND source_chat_id = ? AND topic_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(input.chatId, topic, now - 30 * 60 * 1000).first<Record<string, unknown>>();

  const finalBody = `${body.replace(/\n*来源：[\s\S]*$/u, '').trim()}\n\n以上内容由${organizationMode === 'ai' ? 'AI' : '规则'}根据飞书采集群消息整理，关键数字、主体与时间请在发布前人工核验。\n\n来源：${sourceLabel}`;
  if (mergeCandidate) {
    const draft = mapDraft(mergeCandidate);
    const mergedBody = mergeDraftBody(draft.body, text, sourceLabel);
    const ids = [...draft.sourceMessageIds, input.messageId];
    const combinedFlags = Array.from(new Set([...draft.reviewFlags, ...organizationFlags]));
    await env.DB.prepare('UPDATE drafts SET body = ?, source_message_ids = ?, review_flags = ?, updated_at = ? WHERE id = ?')
      .bind(mergedBody, JSON.stringify(ids), JSON.stringify(combinedFlags), now, draft.id).run();
    await log('message_merged', input.simulated ? 'simulator' : 'feishu', 'draft', draft.id, { messageId: input.messageId, organizationMode });
    return { outcome: 'merged' as const, draftId: draft.id, organizationMode };
  }

  const draftId = crypto.randomUUID();
  const metadata: DraftMetadata = {
    originalText: text,
    keyPoints: [text],
    factCheckFlags: ['待人工核验：时间、数字、主体与来源', ...(organizationMode === 'ai' ? ['AI提炼仅供辅助，未完成事实核验'] : ['规则模式：未调用AI'])],
    organizationMode,
  };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO drafts (id, title, body, status, category, topic_key, source_chat_id, source_label, source_message_ids, review_flags, metadata_json, created_at, updated_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .bind(draftId, title, finalBody, 'pending', category, topic, input.chatId, sourceLabel, JSON.stringify([input.messageId]), JSON.stringify(organizationFlags), JSON.stringify({ ...metadata, sourceUrl: input.sourceUrl ?? null, senderName: input.senderName ?? null, eventTimestamp: input.eventTimestamp ?? now }), now, now),
    env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('draft_created', input.simulated ? 'simulator' : 'feishu', 'draft', draftId, JSON.stringify({ messageId: input.messageId, category, source, organizationMode }), now),
  ]);
  return { outcome: 'created' as const, draftId, organizationMode };
}

export async function regenerateDraft(id: string, actor: string): Promise<DraftRecord | null> {
  await ensureDatabase();
  if (!(env.AI_API_KEY || env.OPENAI_API_KEY) || !(env.AI_MODEL || env.OPENAI_MODEL)) throw new Error('AI_NOT_CONFIGURED');
  const row = await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const draft = mapDraft(row);
  const ids = draft.sourceMessageIds;
  const messages: AiMessageInput[] = [];
  for (const messageId of ids) {
    const message = await env.DB.prepare('SELECT message_id, sanitized_content, event_timestamp, received_at FROM messages WHERE message_id = ?').bind(messageId).first<Record<string, unknown>>();
    if (message) messages.push({ messageId: String(message.message_id), text: String(message.sanitized_content), createTime: Number(message.event_timestamp || message.received_at || Date.now()) });
  }
  if (!messages.length) throw new Error('DRAFT_SOURCE_NOT_FOUND');
  const organization = await organizeFinancialMessages(messages);
  if (!organization.title || !organization.body || !organization.selectedMessageIds.length) throw new Error('AI_FILTERED_MESSAGE');
  const metadata = { ...draft.metadata, keyPoints: messages.map((message) => message.text), organizationMode: 'ai' as const, factCheckFlags: ['待人工核验：时间、数字、主体与来源', 'AI提炼仅供辅助，未完成事实核验'] };
  const now = Date.now();
  const body = `${organization.body}\n\n以上内容由 AI 根据飞书采集群消息整理，关键数字、主体与时间请在发布前人工核验。\n\n来源：${draft.sourceLabel}`;
  await env.DB.batch([
    env.DB.prepare('UPDATE drafts SET title = ?, body = ?, category = ?, topic_key = ?, metadata_json = ?, updated_at = ? WHERE id = ?').bind(organization.title, body, organization.category, `ai-${organization.category}`, JSON.stringify(metadata), now, id),
    env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind('draft_regenerated', actor, 'draft', id, JSON.stringify({ mode: 'ai', messageCount: messages.length }), now),
  ]);
  const updated = await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return updated ? mapDraft(updated) : null;
}

export type InboundMessageRecord = {
  id: string;
  eventId: string;
  messageId: string;
  chatId: string;
  senderId: string | null;
  senderName: string | null;
  source: string;
  originalText: string | null;
  sanitizedText: string;
  sourceUrl: string | null;
  eventTimestamp: number | null;
  status: string;
  duplicateOf: string | null;
  receivedAt: number;
  processedAt: number | null;
};

export async function listInboundMessages(status?: string): Promise<InboundMessageRecord[]> {
  await ensureDatabase();
  const query = status
    ? env.DB.prepare('SELECT * FROM messages WHERE status = ? ORDER BY received_at DESC LIMIT 100').bind(status)
    : env.DB.prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT 100');
  const result = await query.all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: String(row.id), eventId: String(row.event_id), messageId: String(row.message_id), chatId: String(row.chat_id),
    senderId: row.sender_id == null ? null : String(row.sender_id), senderName: row.sender_name == null ? null : String(row.sender_name),
    source: String(row.source || 'feishu'), originalText: row.original_content == null ? null : String(row.original_content),
    sanitizedText: String(row.sanitized_content), sourceUrl: row.source_url == null ? null : String(row.source_url),
    eventTimestamp: row.event_timestamp == null ? null : Number(row.event_timestamp), status: String(row.status),
    duplicateOf: row.duplicate_of == null ? null : String(row.duplicate_of), receivedAt: Number(row.received_at),
    processedAt: row.processed_at == null ? null : Number(row.processed_at),
  }));
}

export async function getSystemStatus() {
  await ensureDatabase();
  const [pending, duplicates, messages, collector] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM drafts WHERE status = 'pending'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE status = 'duplicate' AND received_at > ?").bind(startOfToday()).first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE received_at > ?').bind(startOfToday()).first<{ count: number }>(),
    env.DB.prepare('SELECT * FROM collector_state WHERE id = ?').bind('feishu').first<Record<string, unknown>>(),
  ]);
  return {
    mode: env.SIMULATION_MODE === 'true' ? 'simulation' : 'live',
    configured: Boolean(env.FEISHU_VERIFICATION_TOKEN && (allowedChatIds().length || env.SITE_OWNER_USER_ID)),
    allowedChats: allowedChatIds().length,
    pending: pending?.count ?? 0,
    duplicatesToday: duplicates?.count ?? 0,
    messagesToday: messages?.count ?? 0,
    listener: {
      enabled: Boolean(env.FEISHU_WS_ENABLED === 'true' || env.FEISHU_VERIFICATION_TOKEN),
      connectionState: collector?.connection_state ? String(collector.connection_state) : (env.FEISHU_WS_ENABLED === 'true' ? 'starting' : 'disabled'),
      lastReceivedAt: collector?.last_received_at == null ? null : Number(collector.last_received_at),
      lastSuccessAt: collector?.last_success_at == null ? null : Number(collector.last_success_at),
      lastError: collector?.last_error ? String(collector.last_error) : null,
      consecutiveFailures: Number(collector?.consecutive_failures ?? 0),
    },
  };
}

export async function recordCollectorSuccess(eventId: string, receivedAt = Date.now()) {
  await ensureDatabase();
  await env.DB.prepare(`INSERT INTO collector_state (id, last_received_at, last_success_at, last_error, connection_state, consecutive_failures, last_event_id, updated_at)
    VALUES ('feishu', ?, ?, NULL, 'connected', 0, ?, ?) ON CONFLICT(id) DO UPDATE SET last_received_at=excluded.last_received_at,
    last_success_at=excluded.last_success_at, last_error=NULL, connection_state='connected', consecutive_failures=0, last_event_id=excluded.last_event_id, updated_at=excluded.updated_at`)
    .bind(receivedAt, Date.now(), eventId, Date.now()).run();
}

export async function recordCollectorConnection(state: string, errorMessage?: string) {
  await ensureDatabase();
  const safeState = ['starting', 'connected', 'reconnecting', 'disconnected', 'error', 'disabled'].includes(state) ? state : 'error';
  await env.DB.prepare(`INSERT INTO collector_state (id, connection_state, last_error, consecutive_failures, updated_at)
    VALUES ('feishu', ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET connection_state=excluded.connection_state,
    last_error=excluded.last_error, updated_at=excluded.updated_at`).bind(safeState, errorMessage ? errorMessage.slice(0, 500) : null, Date.now()).run();
}

export async function recordCollectorFailure(message: string, eventId?: string) {
  await ensureDatabase();
  await env.DB.prepare(`INSERT INTO collector_state (id, last_error, consecutive_failures, last_event_id, updated_at)
    VALUES ('feishu', ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,
    consecutive_failures=collector_state.consecutive_failures + 1, last_event_id=COALESCE(excluded.last_event_id, collector_state.last_event_id), updated_at=excluded.updated_at`)
    .bind(message.slice(0, 500), eventId ?? null, Date.now()).run();
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

type AiOrganizationCategory = 'A股盘面' | '政策监管' | '公司公告' | '科技产业' | '资金面' | '解禁减持' | '海外市场' | '宏观' | '其他';

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
