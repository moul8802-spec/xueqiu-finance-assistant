import { env } from 'cloudflare:workers';
import { dashboardActor, jsonError } from '@/app/api/_auth';
import { processInboundMessage } from '@/db/repository';

export async function POST(request: Request) {
  const actor = await dashboardActor();
  if (!actor || env.SIMULATION_MODE !== 'true') return jsonError('模拟入口未开启', 403);
  const body = await request.json().catch(() => null) as { text?: unknown; chatId?: unknown; chatName?: unknown } | null;
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
    return jsonError('请输入 1 至 4000 个字符的模拟消息', 400);
  }
  const nonce = crypto.randomUUID();
  const result = await processInboundMessage({
    eventId: `sim-event-${nonce}`,
    messageId: `sim-message-${nonce}`,
    chatId: typeof body.chatId === 'string' ? body.chatId : 'simulated-finance-group',
    chatName: typeof body.chatName === 'string' ? body.chatName : '模拟财经群',
    senderId: actor,
    text: body.text,
    simulated: true,
  });
  return Response.json({ ok: true, result });
}
