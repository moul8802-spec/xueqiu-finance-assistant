import { dashboardActor, jsonError } from '@/app/api/_auth';
import { getSystemStatus } from '@/db/repository';

export async function GET() {
  const actor = await dashboardActor();
  if (!actor) return jsonError('需要登录后查看状态', 401);
  return Response.json({ ok: true, status: await getSystemStatus() });
}
