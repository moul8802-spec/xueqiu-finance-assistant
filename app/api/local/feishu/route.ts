import { env } from 'cloudflare:workers';
import { jsonError } from '@/app/api/_auth';
import { getCollectorBinding, processInboundMessage, recordCollectorCandidate, recordCollectorConnection, recordCollectorFailure, recordCollectorSuccess, recordCollectorRawEvent, recordCollectorBridgeStatus } from '@/db/repository';

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
  if (body.type === 'candidate') {
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    if (!chatId || !messageId) return jsonError('待绑定事件缺少群或消息标识', 400, 'LOCAL_CANDIDATE_INVALID');
    const binding = await recordCollectorCandidate(chatId, typeof body.chatName === 'string' ? body.chatName : '', messageId, typeof body.eventTimestamp === 'number' ? body.eventTimestamp : Date.now());
    return Response.json({ ok: true, binding });
  }
  if (body.type !== 'message') { await recordCollectorBridgeStatus(200); console.log('[feishu-bridge] ignored event HTTP 200 type=' + String(body.type)); return Response.json({ ok: true, bridgeStatus: 200, ignored: 'unsupported_local_event' }); }
  const eventId = typeof body.eventId === 'string' ? body.eventId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!eventId || !messageId || !chatId || !text) { await recordCollectorBridgeStatus(400, 'LOCAL_MESSAGE_INVALID'); console.log('[feishu-bridge] message HTTP 400 code=LOCAL_MESSAGE_INVALID'); return jsonError('本地飞书消息缺少必要字段', 400, 'LOCAL_MESSAGE_INVALID'); }
  try {
    const result = await processInboundMessage({
      eventId, messageId, chatId, text,
      senderId: typeof body.senderId === 'string' ? body.senderId : undefined,
      senderName: typeof body.senderName === 'string' ? body.senderName : undefined,
      forwardedFromName: typeof body.forwardedFromName === 'string' ? body.forwardedFromName : undefined,
      forwardedFromTime: typeof body.forwardedFromTime === 'number' ? body.forwardedFromTime : undefined,
      forwardedFromMessageId: typeof body.forwardedFromMessageId === 'string' ? body.forwardedFromMessageId : undefined,
      forwardedSourceChatId: typeof body.forwardedSourceChatId === 'string' ? body.forwardedSourceChatId : undefined,
      forwardedMessageCount: typeof body.forwardedMessageCount === 'number' ? body.forwardedMessageCount : undefined,
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

export async function GET(request: Request) {
  const bridgeToken = env.FEISHU_WS_BRIDGE_TOKEN;
  const supplied = request.headers.get('x-feishu-local-token');
  if (!bridgeToken || !supplied || supplied !== bridgeToken) return jsonError('本地飞书桥接令牌无效', 401, 'LOCAL_BRIDGE_UNAUTHORIZED');
  return Response.json({ ok: true, binding: await getCollectorBinding() });
}

