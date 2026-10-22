import * as Lark from '@larksuiteoapi/node-sdk';

const appId = String(process.env.FEISHU_APP_ID || '').trim();
const appSecret = String(process.env.FEISHU_APP_SECRET || '').trim();
const bridgeUrl = String(process.env.FEISHU_WS_BRIDGE_URL || '').trim();
const bridgeToken = String(process.env.FEISHU_WS_BRIDGE_TOKEN || '').trim();
const allowlist = new Set(String(process.env.FEISHU_ALLOWED_CHAT_IDS || '').split(',').map((item) => item.trim()).filter(Boolean));
const chatNames = new Map(String(process.env.FEISHU_ALLOWED_CHAT_NAMES || '').split(',').map((item) => item.trim()).filter(Boolean).map((name, index) => [Array.from(allowlist)[index], name]));

if (!appId || !appSecret) fail('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
if (!bridgeUrl || !bridgeToken) fail('缺少本地桥接地址或 FEISHU_WS_BRIDGE_TOKEN');

const apiClient = new Lark.Client({ appId, appSecret });
const chatInfoCache = new Map();

async function postBridge(payload) {
  try {
    const response = await fetch(bridgeUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feishu-local-token': bridgeToken }, body: JSON.stringify(payload) });
    if (!response.ok) console.error(`本地桥接返回 HTTP ${response.status}`);
  } catch (error) {
    console.error(`本地桥接失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getBridgeBinding() {
  try {
    const response = await fetch(bridgeUrl, { headers: { 'x-feishu-local-token': bridgeToken } });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.binding || null;
  } catch (error) {
    console.error(`本地绑定状态读取失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function fail(message) {
  console.error(`飞书长连接未启动：${message}`);
  process.exit(2);
}

function value(record, ...keys) {
  let current = record;
  for (const key of keys) current = current && typeof current === 'object' ? current[key] : undefined;
  return current;
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  const record = value;
  const preferred = ['text', 'content', 'markdown', 'plain_text', 'title', 'description', 'value', 'label', 'elements', 'body', 'header', 'fields', 'i18n'];
  const keys = preferred.filter((key) => key in record);
  const source = keys.length ? keys.map((key) => [key, record[key]]) : Object.entries(record);
  return source.filter(([key]) => !['href', 'url', 'images', 'img_key', 'tag', 'type', 'schema', 'template', 'template_id', 'language', 'style', 'margin', 'width', 'height'].includes(key)).map(([, item]) => extractText(item)).filter(Boolean).join(' ');
}

function extractUrl(value) {
  if (Array.isArray(value)) for (const item of value) { const url = extractUrl(item); if (url) return url; }
  if (!value || typeof value !== 'object') return undefined;
  for (const key of ['href', 'url']) if (typeof value[key] === 'string' && /^https?:\/\//u.test(value[key])) return value[key];
  for (const item of Object.values(value)) { const url = extractUrl(item); if (url) return url; }
  return undefined;
}

function parseContent(type, rawContent) {
  let content = rawContent;
  if (typeof content === 'string') { try { content = JSON.parse(content); } catch { return { text: '', sourceUrl: undefined }; } }
  return { text: extractText(content).replace(/\s+/gu, ' ').trim(), sourceUrl: extractUrl(content), type };
}

function timestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function sourceName(item) {
  return String(item?.sender?.name || item?.sender?.display_name || item?.sender?.id || item?.sender?.open_id || '').trim() || '原消息来源（飞书未提供名称）';
}

function sourceRecord(item) {
  const type = String(item?.msg_type || item?.message_type || 'text');
  const parsed = parseContent(type, item?.body?.content ?? item?.content);
  return {
    ...parsed,
    messageId: String(item?.message_id || ''),
    chatId: String(item?.chat_id || ''),
    name: sourceName(item),
    senderName: String(item?.sender?.name || item?.sender?.display_name || '').trim(),
    time: timestamp(item?.create_time),
  };
}

async function fetchForwardedItems(messageId) {
  if (!messageId) return [];
  try {
    const response = await apiClient.im.v1.message.get({ path: { message_id: messageId }, params: { card_msg_content_type: 'user_card_content' } });
    return Array.isArray(response?.data?.items) ? response.data.items : [];
  } catch (error) {
    console.error(`飞书转发消息展开失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function combineForwardedRecords(records, fallback) {
  const usable = records.filter((item) => item.text);
  if (!usable.length) return fallback;
  const body = usable.map((item, index) => `${usable.length > 1 ? `【转发消息 ${index + 1}】\n` : ''}${item.text}`).join('\n\n');
  const sources = Array.from(new Map(usable.map((item) => [item.messageId || `${item.name}-${item.time}`, item])).values());
  const sourceText = sources.map((item) => `来源群：${item.chatName || item.name}${item.senderName ? `｜发送者：${item.senderName}` : ''}${item.time ? `｜时间：${new Date(item.time).toLocaleString('zh-CN', { hour12: false })}` : ''}${item.messageId ? `｜消息ID：${item.messageId}` : ''}`).join('\n');
  return {
    text: `${body}\n\n【转发来源】\n${sourceText}`.trim(),
    sourceUrl: usable.map((item) => item.sourceUrl).find(Boolean),
    type: fallback.type,
    forwardedFromName: sources.map((item) => item.chatName || item.name).join('、'),
    forwardedFromTime: sources.map((item) => item.time).filter(Boolean).sort((a, b) => a - b)[0],
    forwardedFromMessageId: sources.map((item) => item.messageId).filter(Boolean).join(','),
    forwardedSourceChatId: sources.map((item) => item.chatId).find(Boolean),
    forwardedMessageCount: sources.length,
  };
}

async function parseMessage(message) {
  const type = String(message?.message_type || message?.msg_type || 'text');
  const parsed = parseContent(type, message?.content);
  if (!['forward', 'merge_forward'].includes(type)) return parsed;

  // A single forward carries the original message_id in content. A merge-forward
  // is expanded by querying the received wrapper message; the official API
  // returns the wrapper followed by its child messages in data.items[].
  let referencedIds = [];
  try {
    const raw = typeof message?.content === 'string' ? JSON.parse(message.content) : message?.content;
    referencedIds = [raw?.message_id, raw?.messageId, raw?.id].filter((value) => typeof value === 'string' && value.trim());
  } catch { /* keep empty; the API lookup below may still expand merge_forward */ }
  const items = type === 'merge_forward'
    ? await fetchForwardedItems(String(message?.message_id || ''))
    : (referencedIds.length ? await fetchForwardedItems(referencedIds[0]) : []);
  const records = items
    .filter((item) => String(item?.message_id || '') !== String(message?.message_id || '') || type !== 'merge_forward')
    .map(sourceRecord);
  await Promise.all(records.map(async (record) => {
    if (record.chatId) record.chatName = await resolveChatName(record.chatId, {});
  }));
  return combineForwardedRecords(records, parsed);
}

async function resolveChatName(chatId, event) {
  const eventName = value(event, 'message', 'chat_name') || value(event, 'chat_name');
  if (typeof eventName === 'string' && eventName.trim()) return eventName.trim();
  if (chatInfoCache.has(chatId)) return chatInfoCache.get(chatId);
  try {
    const response = await apiClient.im.v1.chat.get({ path: { chat_id: chatId } });
    const name = String(response?.data?.name || '').trim() || `飞书群 ${chatId.slice(0, 8)}`;
    chatInfoCache.set(chatId, name);
    return name;
  } catch {
    const fallback = `飞书群 ${chatId.slice(0, 8)}`;
    chatInfoCache.set(chatId, fallback);
    return fallback;
  }
}

async function onMessage(data) {
  const event = data?.event || data;
  const message = event?.message || {};
  const chatId = String(message.chat_id || '');
  if (!chatId) return;
  const binding = allowlist.size ? null : await getBridgeBinding();
  if (allowlist.size && !allowlist.has(chatId)) return;
  if (!allowlist.size && binding?.status === 'bound' && binding.boundChatId !== chatId) return;
  const chatName = chatNames.get(chatId) || await resolveChatName(chatId, event);
  if (!allowlist.size && binding?.status !== 'bound') {
    await postBridge({
      type: 'candidate', chatId, chatName,
      messageId: String(message.message_id || ''),
      eventTimestamp: Number(message.create_time || event?.create_time || Date.now()),
    });
    return;
  }
  const parsed = await parseMessage(message);
  if (!parsed.text) return;
  const sender = event?.sender?.sender_id || event?.sender || {};
  const timestamp = Number(message.create_time || event?.create_time || Date.now());
  await postBridge({
    type: 'message', eventId: String(data?.header?.event_id || data?.event_id || message.message_id),
    messageId: String(message.message_id || ''), chatId, chatName, text: parsed.text,
    sourceUrl: parsed.sourceUrl, senderId: String(sender.open_id || sender.user_id || sender.union_id || ''),
    senderName: String(sender.name || sender.display_name || ''),
    forwardedFromName: parsed.forwardedFromName,
    forwardedFromTime: parsed.forwardedFromTime,
    forwardedFromMessageId: parsed.forwardedFromMessageId,
    forwardedSourceChatId: parsed.forwardedSourceChatId,
    forwardedMessageCount: parsed.forwardedMessageCount,
    eventTimestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  });
}

let started = false;
async function start() {
  if (started) return;
  started = true;
  await postBridge({ type: 'connection', state: 'starting' });
  const client = new Lark.WSClient({
    appId, appSecret, autoReconnect: true, loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => { const state = allowlist.size ? 'connected' : 'waiting_for_binding'; console.log('飞书 WebSocket 已连接'); void postBridge({ type: 'connection', state }); },
    onReconnecting: () => { console.warn('飞书 WebSocket 断开，正在重连'); void postBridge({ type: 'connection', state: 'reconnecting' }); },
    onReconnected: () => { const state = allowlist.size ? 'connected' : 'waiting_for_binding'; console.log('飞书 WebSocket 已重连'); void postBridge({ type: 'connection', state }); },
    onError: (error) => { console.error(`飞书 WebSocket 错误：${error.message}`); void postBridge({ type: 'connection', state: 'error', error: error.message }); },
  });
  const eventDispatcher = new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': onMessage });
  try {
    await client.start({ eventDispatcher });
  } catch (error) {
    started = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`飞书 WebSocket 启动失败：${message}`);
    await postBridge({ type: 'connection', state: 'error', error: message });
    setTimeout(() => void start(), 10000);
  }
}

void start();

