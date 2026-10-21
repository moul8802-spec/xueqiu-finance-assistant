import { dashboardActor, jsonError } from '@/app/api/_auth';
import { listInboundMessages } from '@/db/repository';

export async function GET(request: Request) {
  const actor = await dashboardActor();
  if (!actor) return jsonError('需要登录后查看采集消息', 401);
  const status = new URL(request.url).searchParams.get('status') || undefined;
  return Response.json({ ok: true, messages: await listInboundMessages(status) });
}
