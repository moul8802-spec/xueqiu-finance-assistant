import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { createDraftFromImportedMessages } from '@/db/repository';
import { AiApiError } from '@/lib/ai';

export async function POST(request: Request) {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后导入消息', 401, 'SITE_LOGIN_REQUIRED');
  const body = await request.json().catch(() => null) as { sourceLabel?: unknown; text?: unknown } | null;
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return jsonError('请粘贴至少一条消息', 400, 'IMPORT_TEXT_REQUIRED');
  }
  if (body.text.length > 30_000) return jsonError('单次导入内容不能超过 30000 字', 400, 'IMPORT_TEXT_TOO_LONG');
  if (body.sourceLabel != null && typeof body.sourceLabel !== 'string') {
    return jsonError('来源名称格式不正确', 400, 'IMPORT_SOURCE_INVALID');
  }
  try {
    const result = await createDraftFromImportedMessages(identity.id, identity.email, {
      sourceLabel: typeof body.sourceLabel === 'string' ? body.sourceLabel : undefined,
      text: body.text,
    });
    return Response.json({ ok: true, result });
  } catch (error) {
    if (error instanceof AiApiError) return jsonError(error.message, error.status, error.code, error.details);
    if (error instanceof Error && error.message === 'IMPORT_TOO_MANY_MESSAGES') {
      return jsonError('单次最多导入 50 条非空消息', 400, 'IMPORT_TOO_MANY_MESSAGES');
    }
    if (error instanceof Error && error.message === 'IMPORT_TEXT_REQUIRED') {
      return jsonError('请粘贴至少一条消息', 400, 'IMPORT_TEXT_REQUIRED');
    }
    return jsonError('消息导入失败', 500, 'IMPORT_FAILED');
  }
}

