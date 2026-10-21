import { env } from 'cloudflare:workers';
import { jsonError } from '@/app/api/_auth';
import { processInboundMessage } from '@/db/repository';

type FeishuPayload = {
  type?: string;
  token?: string;
  challenge?: string;
  header?: { event_id?: string; event_type?: string; token?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string;
    };
  };
};

export async function POST(request: Request) {
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > 64_000) return jsonError('请求体过大', 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 64_000) return jsonError('请求体过大', 413);
  let body: FeishuPayload | null = null;
  try {
    body = JSON.parse(rawBody) as FeishuPayload;
  } catch {
    body = null;
  }
  if (!body) return jsonError('无效的 JSON', 400);

  const expectedToken = env.FEISHU_VERIFICATION_TOKEN;
  if (!expectedToken) return jsonError('飞书回调尚未配置', 503);

  if (body.type === 'url_verification') {
    if (body.token !== expectedToken || !body.challenge) return jsonError('验证失败', 403);
    return Response.json({ challenge: body.challenge });
  }

  if (body.header?.token !== expectedToken) return jsonError('验证失败', 403);
  if (body.header?.event_type !== 'im.message.receive_v1') {
    return Response.json({ ok: true, ignored: 'unsupported_event' });
  }

  const message = body.event?.message;
  if (!message?.message_id || !message.chat_id || !body.header.event_id) {
    return jsonError('缺少消息标识', 400);
  }
  if (message.message_type !== 'text') {
    return Response.json({ ok: true, ignored: 'non_text_message' });
  }
  const parsedContent = parseTextContent(message.content);
  if (!parsedContent) return Response.json({ ok: true, ignored: 'empty_text' });

  const result = await processInboundMessage({
    eventId: body.header.event_id,
    messageId: message.message_id,
    chatId: message.chat_id,
    senderId: body.event?.sender?.sender_id?.open_id,
    text: parsedContent,
  });
  return Response.json({ ok: true, result });
}

function parseTextContent(value?: string) {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}
