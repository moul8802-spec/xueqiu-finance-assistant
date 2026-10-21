import { env } from 'cloudflare:workers';
import { jsonError } from '@/app/api/_auth';
import { processInboundMessage, recordCollectorConnection, recordCollectorFailure, recordCollectorSuccess } from '@/db/repository';

/** Local-only bridge used by the Windows launcher. It is not a public Feishu webhook. */
export async function POST(request: Request) {
  const bridgeToken = env.FEISHU_WS_BRIDGE_TOKEN;
  const supplied = request.headers.get('x-feishu-local-token');
  if (!bridgeToken || !supplied || supplied !== bridgeToken) return jsonError('本地飞书桥接令牌无效', 401, 'LOCAL_BRIDGE_UNAUTHORIZED');
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.type !== 'string') return jsonError('本地飞书事件格式无效', 400, 'LOCAL_EVENT_INVALID');
  if (body.type === 'connection') {
    await recordCollectorConnection(String(body.state || 'error'), typeof body.error === 'string' ? body.error : undefined);
    return Response.json({ ok: true });
  }
  if (body.type !== 'message') return Response.json({ ok: true, ignored: 'unsupported_local_event' });
  const eventId = typeof body.eventId === 'string' ? body.eventId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!eventId || !messageId || !chatId || !text) return jsonError('本地飞书消息缺少必要字段', 400, 'LOCAL_MESSAGE_INVALID');
  try {
    const result = await processInboundMessage({
      eventId, messageId, chatId, text,
      senderId: typeof body.senderId === 'string' ? body.senderId : undefined,
      senderName: typeof body.senderName === 'string' ? body.senderName : undefined,
      sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : undefined,
      eventTimestamp: typeof body.eventTimestamp === 'number' ? body.eventTimestamp : Date.now(),
      actorId: env.FEISHU_LOCAL_OWNER_ID,
      chatName: typeof body.chatName === 'string' ? body.chatName : undefined,
      source: 'feishu_websocket',
    });
    if (result.outcome === 'rejected') {
      await recordCollectorFailure('收到未列入白名单的群消息', eventId);
    } else {
      await recordCollectorSuccess(eventId, typeof body.eventTimestamp === 'number' ? body.eventTimestamp : Date.now());
    }
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LOCAL_MESSAGE_PROCESSING_FAILED';
    await recordCollectorFailure(message, eventId).catch(() => undefined);
    return jsonError('本地飞书消息处理失败', 500, 'LOCAL_MESSAGE_PROCESSING_FAILED');
  }
}
