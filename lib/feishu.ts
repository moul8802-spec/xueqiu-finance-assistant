import { env } from 'cloudflare:workers';
import { ensureDatabase } from '@/db/repository';
import { openSecret, sealSecret, sha256Hex } from '@/lib/secrets';

export const FEISHU_REQUIRED_SCOPES = [
  'im:chat:readonly',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
] as const;

const OAUTH_SCOPES = [...FEISHU_REQUIRED_SCOPES, 'offline_access'];
const MINIMAL_OAUTH_SCOPES = ['offline_access'];
const AUTHORIZE_ENDPOINT = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_ENDPOINT = 'https://accounts.feishu.cn/oauth/v3/token';
const API_ORIGIN = 'https://open.feishu.cn';

export type FeishuConnection = {
  actorId: string;
  openId: string | null;
  unionId: string | null;
  tenantKey: string | null;
  name: string | null;
  avatarUrl: string | null;
  scope: string[];
  expiresAt: number;
  refreshExpiresAt: number | null;
};

export type FeishuChat = {
  chatId: string;
  name: string;
  description: string;
  ownerId: string | null;
  external: boolean;
  tenantKey: string | null;
};

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  messageType: string;
  text: string | null;
  senderId: string | null;
  createTime: number;
};

export class FeishuApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | number,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  scope?: string | string[];
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
};

function config() {
  const clientId = env.FEISHU_APP_ID;
  const clientSecret = env.FEISHU_APP_SECRET;
  const redirectUri = env.FEISHU_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri || !env.FEISHU_TOKEN_ENCRYPTION_KEY) {
    throw new FeishuApiError('飞书 OAuth 服务端环境变量尚未配置完整', 'FEISHU_OAUTH_NOT_CONFIGURED', 503);
  }
  return { clientId, clientSecret, redirectUri };
}

function normalizeScopes(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((item) => primitiveString(item)).filter(Boolean)
    : primitiveString(value).split(/[\s,]+/);
  return Array.from(new Set(parts.map((item) => item.trim()).filter(Boolean))).sort();
}

function encodeState(bytes = 24) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function beginFeishuOAuth(actorId: string, mode: 'full' | 'minimal' = 'full') {
  const { clientId, redirectUri } = config();
  await ensureDatabase();
  const state = encodeState();
  const stateHash = await sha256Hex(state);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM feishu_oauth_states WHERE actor_id = ? OR expires_at < ?').bind(actorId, now),
    env.DB.prepare('INSERT INTO feishu_oauth_states (state_hash, actor_id, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(stateHash, actorId, redirectUri, now + 10 * 60 * 1000, now),
  ]);
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', (mode === 'minimal' ? MINIMAL_OAUTH_SCOPES : OAUTH_SCOPES).join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export async function diagnoseFeishuAppToken(actorLabel: string) {
  const { clientId, clientSecret } = config();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = await response.json().catch(() => null) as TokenResponse | null;
  const code = typeof body?.code === 'number'
    ? body.code
    : primitiveString(body?.error, response.ok && body?.access_token ? '0' : `HTTP_${response.status}`);
  const ok = response.ok && Boolean(body?.access_token) && (body?.code == null || body.code === 0);
  const result = {
    checkedAt: Date.now(),
    appToken: {
      ok,
      httpStatus: response.status,
      code,
      message: ok
        ? '应用身份令牌申请成功，App ID、App Secret、应用发布和启用状态有效。'
        : primitiveString(body?.error_description, primitiveString(body?.msg, primitiveString(body?.error, `飞书令牌接口返回 HTTP ${response.status}`))),
      ttLogId: extractTtLogId(response, body),
      expiresIn: ok ? Number(body?.expires_in || 0) : null,
    },
    minimalOAuthPath: '/api/feishu/oauth/start?mode=minimal',
    stopRetry: Number(code) === 21001,
    classification: Number(code) === 21001 ? 'account_security_policy' : ok ? 'app_credentials_ok' : 'app_credentials_or_status_error',
  };
  await ensureDatabase();
  await env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('feishu_app_token_diagnostic', actorLabel, 'feishu', 'oauth', JSON.stringify(result), Date.now()).run();
  return result;
}

export async function recordFeishuOAuthFailure(
  actorLabel: string,
  details: { code: string; message: string; ttLogId: string | null; mode: string },
) {
  await ensureDatabase();
  await env.DB.prepare('INSERT INTO audit_logs (action, actor, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('feishu_oauth_failure', actorLabel, 'feishu', 'oauth', JSON.stringify(details), Date.now()).run();
}

export async function consumeOAuthState(actorId: string, state: string) {
  await ensureDatabase();
  const stateHash = await sha256Hex(state);
  const row = await env.DB.prepare('SELECT actor_id, redirect_uri, expires_at FROM feishu_oauth_states WHERE state_hash = ?')
    .bind(stateHash).first<{ actor_id: string; redirect_uri: string; expires_at: number }>();
  await env.DB.prepare('DELETE FROM feishu_oauth_states WHERE state_hash = ?').bind(stateHash).run();
  if (!row || row.actor_id !== actorId || Number(row.expires_at) < Date.now()) {
    throw new FeishuApiError('OAuth state 无效、已过期或不属于当前用户', 'INVALID_OAUTH_STATE', 400);
  }
  return row.redirect_uri;
}

async function tokenRequest(parameters: Record<string, string>) {
  const { clientId, clientSecret } = config();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
  });
  const body = await response.json().catch(() => null) as TokenResponse | null;
  if (!response.ok || !body?.access_token || (typeof body.code === 'number' && body.code !== 0)) {
    throw new FeishuApiError(
      body?.error_description || body?.msg || body?.error || `飞书令牌接口返回 HTTP ${response.status}`,
      body?.code ?? body?.error ?? `HTTP_${response.status}`,
      response.status || 502,
      safeDetails(body),
    );
  }
  return body;
}

export async function exchangeAuthorizationCode(actorId: string, code: string, redirectUri: string) {
  const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const profile = await apiRequest(token.access_token!, '/open-apis/authen/v1/user_info');
  const data = record(profile.data);
  const now = Date.now();
  await ensureDatabase();
  await env.DB.prepare(`INSERT INTO feishu_connections
    (actor_id, feishu_open_id, feishu_union_id, tenant_key, name, avatar_url, access_token_enc, refresh_token_enc, token_type, scope, expires_at, refresh_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(actor_id) DO UPDATE SET
      feishu_open_id=excluded.feishu_open_id, feishu_union_id=excluded.feishu_union_id,
      tenant_key=excluded.tenant_key, name=excluded.name, avatar_url=excluded.avatar_url,
      access_token_enc=excluded.access_token_enc, refresh_token_enc=excluded.refresh_token_enc,
      token_type=excluded.token_type, scope=excluded.scope, expires_at=excluded.expires_at,
      refresh_expires_at=excluded.refresh_expires_at, updated_at=excluded.updated_at`)
    .bind(
      actorId,
      nullable(data.open_id), nullable(data.union_id), nullable(data.tenant_key), nullable(data.name), nullable(data.avatar_url),
      await sealSecret(token.access_token!),
      token.refresh_token ? await sealSecret(token.refresh_token) : null,
      token.token_type || 'Bearer', normalizeScopes(token.scope).join(' '),
      now + Math.max(1, Number(token.expires_in || 7200)) * 1000,
      token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : null,
      now, now,
    ).run();
  return getFeishuConnection(actorId);
}

export async function getFeishuConnection(actorId: string): Promise<FeishuConnection | null> {
  await ensureDatabase();
  const row = await env.DB.prepare('SELECT * FROM feishu_connections WHERE actor_id = ?').bind(actorId).first<Record<string, unknown>>();
  return row ? mapConnection(row) : null;
}

async function connectionWithToken(actorId: string) {
  await ensureDatabase();
  let row = await env.DB.prepare('SELECT * FROM feishu_connections WHERE actor_id = ?').bind(actorId).first<Record<string, unknown>>();
  if (!row) throw new FeishuApiError('尚未连接飞书账号', 'FEISHU_NOT_CONNECTED', 401);
  if (Number(row.expires_at) <= Date.now() + 60_000) {
    if (!row.refresh_token_enc) throw new FeishuApiError('飞书授权已过期，请重新连接', 'FEISHU_REAUTHORIZE_REQUIRED', 401);
    const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: await openSecret(primitiveString(row.refresh_token_enc)) });
    const now = Date.now();
    await env.DB.prepare(`UPDATE feishu_connections SET access_token_enc = ?, refresh_token_enc = ?, token_type = ?, scope = ?,
      expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE actor_id = ?`)
      .bind(
        await sealSecret(token.access_token!),
        token.refresh_token ? await sealSecret(token.refresh_token) : primitiveString(row.refresh_token_enc),
        token.token_type || row.token_type || 'Bearer',
        normalizeScopes(token.scope).length ? normalizeScopes(token.scope).join(' ') : primitiveString(row.scope),
        now + Math.max(1, Number(token.expires_in || 7200)) * 1000,
        token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : row.refresh_expires_at,
        now, actorId,
      ).run();
    row = await env.DB.prepare('SELECT * FROM feishu_connections WHERE actor_id = ?').bind(actorId).first<Record<string, unknown>>();
  }
  if (!row) throw new FeishuApiError('飞书连接记录不可用', 'FEISHU_CONNECTION_INVALID', 500);
  return { connection: mapConnection(row), accessToken: await openSecret(String(row.access_token_enc)) };
}

function requireScopes(connection: FeishuConnection, required: readonly string[]) {
  const missing = required.filter((scope) => !connection.scope.includes(scope));
  if (missing.length) {
    throw new FeishuApiError(`飞书用户授权缺少权限：${missing.join('、')}`, 'MISSING_FEISHU_SCOPES', 403, { missingScopes: missing });
  }
}

export async function listFeishuChats(actorId: string) {
  const { connection, accessToken } = await connectionWithToken(actorId);
  requireScopes(connection, ['im:chat:readonly']);
  const result = await apiRequest(accessToken, '/open-apis/im/v1/chats?page_size=100');
  const data = record(result.data);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item) => mapChat(record(item))).filter((chat) => chat.chatId);
}

export async function saveSelectedChat(actorId: string, chat: FeishuChat) {
  await ensureDatabase();
  await env.DB.prepare(`INSERT INTO feishu_selected_chats (actor_id, chat_id, name, external, tenant_key, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET chat_id=excluded.chat_id, name=excluded.name,
    external=excluded.external, tenant_key=excluded.tenant_key, updated_at=excluded.updated_at`)
    .bind(actorId, chat.chatId, chat.name, chat.external ? 1 : 0, chat.tenantKey, Date.now()).run();
  return chat;
}

export async function getSelectedChat(actorId: string): Promise<FeishuChat | null> {
  await ensureDatabase();
  const row = await env.DB.prepare('SELECT * FROM feishu_selected_chats WHERE actor_id = ?').bind(actorId).first<Record<string, unknown>>();
  return row ? {
    chatId: String(row.chat_id), name: String(row.name), description: '', ownerId: null,
    external: Boolean(row.external), tenantKey: nullable(row.tenant_key),
  } : null;
}

export async function getRecentFeishuMessages(actorId: string, chatId: string) {
  const selected = await getSelectedChat(actorId);
  if (!selected || selected.chatId !== chatId) {
    throw new FeishuApiError('该群未加入当前用户的财经群白名单', 'CHAT_NOT_ALLOWLISTED', 403);
  }
  const { connection, accessToken } = await connectionWithToken(actorId);
  requireScopes(connection, ['im:message:readonly', 'im:message.group_msg:get_as_user']);
  const query = new URLSearchParams({
    container_id_type: 'chat', container_id: chatId, page_size: '10', sort_type: 'ByCreateTimeDesc',
  });
  const result = await apiRequest(accessToken, `/open-apis/im/v1/messages?${query}`);
  const data = record(result.data);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item) => mapMessage(record(item))).filter((message) => message.messageId);
}

export async function feishuConnectionStatus(actorId: string) {
  const connection = await getFeishuConnection(actorId);
  const selectedChat = await getSelectedChat(actorId);
  const configured = Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_OAUTH_REDIRECT_URI && env.FEISHU_TOKEN_ENCRYPTION_KEY);
  return {
    configured,
    callbackUrl: env.FEISHU_OAUTH_REDIRECT_URI || null,
    connected: Boolean(connection),
    account: connection ? { name: connection.name, openId: maskId(connection.openId), tenantKey: maskId(connection.tenantKey) } : null,
    grantedScopes: connection?.scope ?? [],
    requiredScopes: FEISHU_REQUIRED_SCOPES,
    missingScopes: connection ? FEISHU_REQUIRED_SCOPES.filter((scope) => !connection.scope.includes(scope)) : FEISHU_REQUIRED_SCOPES,
    selectedChat,
    aiConfigured: Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL),
  };
}

async function apiRequest(accessToken: string, path: string) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=utf-8' },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const code = body?.code;
  if (!response.ok || (typeof code === 'number' && code !== 0) || !body) {
    throw new FeishuApiError(
      primitiveString(body?.msg, primitiveString(body?.error_description, primitiveString(body?.error, `飞书接口返回 HTTP ${response.status}`))),
      typeof code === 'number' ? code : primitiveString(body?.error, `HTTP_${response.status}`),
      response.status || 502,
      safeDetails(body),
    );
  }
  return body;
}

function mapConnection(row: Record<string, unknown>): FeishuConnection {
  return {
    actorId: String(row.actor_id), openId: nullable(row.feishu_open_id), unionId: nullable(row.feishu_union_id),
    tenantKey: nullable(row.tenant_key), name: nullable(row.name), avatarUrl: nullable(row.avatar_url),
    scope: normalizeScopes(row.scope), expiresAt: Number(row.expires_at),
    refreshExpiresAt: row.refresh_expires_at == null ? null : Number(row.refresh_expires_at),
  };
}

function mapChat(item: Record<string, unknown>): FeishuChat {
  return {
    chatId: primitiveString(item.chat_id), name: primitiveString(item.name, '未命名群聊'), description: primitiveString(item.description),
    ownerId: nullable(item.owner_id), external: Boolean(item.external), tenantKey: nullable(item.tenant_key),
  };
}

function mapMessage(item: Record<string, unknown>): FeishuMessage {
  const body = record(item.body);
  return {
    messageId: primitiveString(item.message_id), chatId: primitiveString(item.chat_id), messageType: primitiveString(item.msg_type),
    text: parseMessageText(primitiveString(item.msg_type), body.content), senderId: nullable(record(item.sender).id),
    createTime: Number(item.create_time || 0),
  };
}

function parseMessageText(type: string, content: unknown) {
  if (type !== 'text' || typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function primitiveString(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function maskId(value: string | null) {
  if (!value) return null;
  return value.length > 10 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
}

function safeDetails(value: unknown) {
  const body = record(value);
  const details: Record<string, unknown> = {};
  for (const key of ['code', 'msg', 'error', 'error_description']) if (body[key] != null) details[key] = body[key];
  return details;
}

function extractTtLogId(response: Response, body: unknown) {
  const payload = record(body);
  return response.headers.get('x-tt-logid')
    || response.headers.get('x-tt-log-id')
    || response.headers.get('x-lark-logid')
    || primitiveString(payload.ttLogId)
    || primitiveString(payload.tt_log_id)
    || null;
}
