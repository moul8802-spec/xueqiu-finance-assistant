import { dashboardActor, jsonError } from '@/app/api/_auth';
import { updateDraft, type DraftStatus } from '@/db/repository';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await dashboardActor();
  if (!actor) return jsonError('需要登录后操作草稿', 401);
  const body = await request.json().catch(() => null) as { body?: unknown; status?: unknown } | null;
  if (!body) return jsonError('请求内容无效', 400);
  const patch: { body?: string; status?: DraftStatus } = {};
  if (typeof body.body === 'string') {
    if (!body.body.trim() || body.body.length > 5000) return jsonError('草稿应为 1 至 5000 个字符', 400);
    patch.body = body.body;
  }
  if (typeof body.status === 'string') {
    if (!['pending', 'copied', 'skipped', 'published'].includes(body.status)) return jsonError('无效的草稿状态', 400);
    patch.status = body.status as DraftStatus;
  }
  if (!Object.keys(patch).length) return jsonError('没有可更新的字段', 400);
  const { id } = await context.params;
  const draft = await updateDraft(id, patch, actor);
  return draft ? Response.json({ ok: true, draft }) : jsonError('草稿不存在', 404);
}
