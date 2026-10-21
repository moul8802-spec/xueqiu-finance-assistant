import { dashboardActor, jsonError } from '@/app/api/_auth';
import { listAuditLogs } from '@/db/repository';

export async function GET(request: Request) {
  const actor = await dashboardActor();
  if (!actor) return jsonError('需要登录后查看操作日志', 401);
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit') || 50);
  return Response.json({ ok: true, logs: await listAuditLogs(Number.isFinite(requestedLimit) ? requestedLimit : 50) });
}
