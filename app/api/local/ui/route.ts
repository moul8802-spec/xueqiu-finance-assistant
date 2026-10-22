import { env } from 'cloudflare:workers';
import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { getUiCollectorStatus, processInboundMessage, recordUiCollectorStatus, setUiCollectorMonitoring } from '@/db/repository';

function authorized(request: Request) {
  const expected = env.FEISHU_UI_BRIDGE_TOKEN;
  const supplied = request.headers.get('x-feishu-ui-token');
  return Boolean(expected && supplied && supplied === expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) return jsonError('本地 UI 桥接令牌无效', 401, 'LOCAL_UI_UNAUTHORIZED');
  return Response.json({ ok: true, ui: await getUiCollectorStatus() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (body?.type === 'control') {
    if (!(await dashboardOwnerIdentity())) return jsonError('需要本机所有者权限', 401, 'OWNER_REQUIRED');
    const action = body.action === 'pause' ? 'pause' : body.action === 'start' ? 'start' : '';
    if (!action) return jsonError('控制动作无效', 400, 'UI_CONTROL_INVALID');
    const ui = await setUiCollectorMonitoring(action === 'start');
    return Response.json({ ok: true, ui });
  }
  if (!authorized(request)) return jsonError('本地 UI 桥接令牌无效', 401, 'LOCAL_UI_UNAUTHORIZED');
  if (!body || typeof body.type !== 'string') return jsonError('本地 UI 事件格式无效', 400, 'LOCAL_UI_EVENT_INVALID');

  if (body.type === 'diagnostic') {
    const ui = await recordUiCollectorStatus({
      state: typeof body.state === 'string' ? body.state : 'error',
      pid: typeof body.pid === 'number' ? body.pid : null,
      windowTitle: typeof body.windowTitle === 'string' ? body.windowTitle : '',
      currentChat: typeof body.currentChat === 'string' ? body.currentChat : '',
      messageCount: typeof body.messageCount === 'number' ? body.messageCount : 0,
      lastSummary: typeof body.lastSummary === 'string' ? body.lastSummary : '',
      lastError: typeof body.error === 'string' ? body.error : '',
    });
    return Response.json({ ok: true, ui });
  }

  if (body.type !== 'message') return jsonError('不支持的本地 UI 事件', 400, 'LOCAL_UI_TYPE_INVALID');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const chatName = typeof body.chatName === 'string' ? body.chatName.trim() : '';
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
  if (!text || !chatId || !fingerprint) return jsonError('本地 UI 消息缺少必要字段', 400, 'LOCAL_UI_MESSAGE_INVALID');
  const messageId = 'ui:' + fingerprint;
  try {
    const result = await processInboundMessage({
      eventId: messageId,
      messageId,
      chatId,
      chatName: chatName || '当前飞书群',
      senderName: typeof body.senderName === 'string' ? body.senderName : undefined,
      text,
      eventTimestamp: typeof body.eventTimestamp === 'number' ? body.eventTimestamp : Date.now(),
      actorId: env.FEISHU_LOCAL_OWNER_ID,
      source: 'feishu_ui',
    });
    await recordUiCollectorStatus({
      state: 'monitoring',
      currentChat: chatName,
      lastSummary: text.slice(0, 120),
      lastError: result.outcome === 'rejected' ? '消息被本地来源策略拒绝' : '',
      lastCapturedAt: typeof body.eventTimestamp === 'number' ? body.eventTimestamp : Date.now(),
    });
    return Response.json({ ok: true, bridgeStatus: 200, result });
  } catch {
    await recordUiCollectorStatus({ state: 'error', lastError: 'UI_MESSAGE_PROCESSING_FAILED' }).catch(() => undefined);
    return jsonError('本地 UI 消息处理失败', 500, 'UI_MESSAGE_PROCESSING_FAILED');
  }
}
