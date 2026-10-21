import { env } from 'cloudflare:workers';
import { jsonError } from '@/app/api/_auth';
import { processInboundMessage, recordCollectorFailure, recordCollectorSuccess } from '@/db/repository';

type FeishuPayload = {
  type?: string;
  token?: string;
  challenge?: string;
  header?: { event_id?: string; event_type?: string; token?: string; create_time?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
    message?: { message_id?: string; chat_id?: string; message_type?: string; content?: string; create_time?: string };
  };
};

export async function POST(request: Request) {
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > 64_000) return jsonError('请求体过大', 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 64_000) return jsonError('请求体过大', 413);
  let body: FeishuPayload | null = null;
  try { body = JSON.parse(rawBody) as FeishuPayload; } catch { body = null; }
  if (!body) return jsonError('无效的 JSON', 400);
  const expectedToken = env.FEISHU_VERIFICATION_TOKEN;
  if (!expectedToken) return jsonError('飞书回调尚未配置', 503);
  if (body.type === 'url_verification') {
    if (body.token !== expectedToken || !body.challenge) return jsonError('验证失败', 403);
    return Response.json({ challenge: body.challenge });
  }
  if (body.header?.token !== expectedToken) return jsonError('验证失败', 403);
  if (body.header?.event_type !== 'im.message.receive_v1') return Response.json({ ok: true, ignored: 'unsupported_event' });
  const message = body.event?.message;
  if (!message?.message_id || !message.chat_id || !body.header.event_id) return jsonError('缺少消息标识', 400);
  const parsed = parseMessageContent(message.message_type, message.content);
  if (!parsed.text) return Response.json({ ok: true, ignored: 'unsupported_or_empty_message' });
  const eventTimestamp = Number(message.create_time || body.header.create_time || Date.now());
  const senderId = body.event?.sender?.sender_id?.open_id || body.event?.sender?.sender_id?.user_id;
  try {
    const result = await processInboundMessage({
      eventId: body.header.event_id, messageId: message.message_id, chatId: message.chat_id,
      senderId, text: parsed.text, sourceUrl: parsed.sourceUrl,
      eventTimestamp: Number.isFinite(eventTimestamp) ? eventTimestamp : Date.now(),
      actorId: env.SITE_OWNER_USER_ID, source: 'feishu_group_event',
    });
    await recordCollectorSuccess(body.header.event_id, Number.isFinite(eventTimestamp) ? eventTimestamp : Date.now());
    return Response.json({ ok: true, result });
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message.slice(0, 200) : 'COLLECTOR_ERROR';
    await recordCollectorFailure(safeMessage, body.header.event_id).catch(() => undefined);
    return jsonError('消息处理失败', 500, { code: 'COLLECTOR_PROCESSING_FAILED', reason: safeMessage });
  }
}

function parseMessageContent(type?: string, value?: string) {
  if (!value) return { text: '', sourceUrl: undefined as string | undefined };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { text: '', sourceUrl: undefined }; }
  if (!['text', 'post', 'interactive'].includes(type || '')) return { text: extractText(parsed).trim(), sourceUrl: extractUrl(parsed) };
  return { text: extractText(parsed).trim(), sourceUrl: extractUrl(parsed) };
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return Object.entries(record).filter(([key]) => !['href', 'url', 'images', 'img_key'].includes(key)).map(([, item]) => extractText(item)).filter(Boolean).join(' ');
}

function extractUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) for (const item of value) { const url = extractUrl(item); if (url) return url; }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['href', 'url']) if (typeof record[key] === 'string' && /^https?:\/\//u.test(record[key] as string)) return record[key] as string;
  for (const item of Object.values(record)) { const url = extractUrl(item); if (url) return url; }
  return undefined;
}
