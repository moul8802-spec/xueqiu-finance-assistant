import { dashboardActor, jsonError } from '@/app/api/_auth';
import { regenerateDraft } from '@/db/repository';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await dashboardActor();
  if (!actor) return jsonError('需要登录后重新生成草稿', 401);
  const { id } = await context.params;
  try {
    const draft = await regenerateDraft(id, actor);
    return draft ? Response.json({ ok: true, draft }) : jsonError('草稿不存在', 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'REGENERATE_FAILED';
    const status = code === 'AI_NOT_CONFIGURED' ? 503 : 422;
    return jsonError('重新生成失败', status, code);
  }
}
