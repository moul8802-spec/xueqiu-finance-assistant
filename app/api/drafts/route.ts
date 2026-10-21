import { dashboardActor, jsonError } from '@/app/api/_auth';
import { listDrafts } from '@/db/repository';

export async function GET(request: Request) {
  const actor = await dashboardActor();
  if (!actor) return jsonError('需要登录后访问审核队列', 401);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  if (!['pending', 'copied', 'skipped', 'published'].includes(status)) {
    return jsonError('无效的草稿状态', 400);
  }
  return Response.json({ ok: true, drafts: await listDrafts(status) });
}
