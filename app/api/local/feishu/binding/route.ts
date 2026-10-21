import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { bindCollectorChat, getCollectorBinding, ignoreCollectorCandidate, unbindCollectorChat } from '@/db/repository';

async function owner() {
  const identity = await dashboardOwnerIdentity();
  return identity ? { id: identity.id } : null;
}

export async function GET() {
  if (!(await owner())) return jsonError('需要本机所有者身份', 401, 'LOCAL_OWNER_REQUIRED');
  return Response.json({ ok: true, binding: await getCollectorBinding() });
}

export async function POST(request: Request) {
  const identity = await owner();
  if (!identity) return jsonError('需要本机所有者身份', 401, 'LOCAL_OWNER_REQUIRED');
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action;
  try {
    if (action === 'bind') {
      const chatId = typeof body?.chatId === 'string' ? body.chatId : '';
      const chatName = typeof body?.chatName === 'string' ? body.chatName : '';
      if (!chatId) return jsonError('缺少待绑定群 ID', 400, 'BINDING_CHAT_REQUIRED');
      return Response.json({ ok: true, binding: await bindCollectorChat(chatId, chatName, identity.id) });
    }
    if (action === 'ignore') return Response.json({ ok: true, binding: await ignoreCollectorCandidate(identity.id) });
    return jsonError('不支持的绑定操作', 400, 'BINDING_ACTION_INVALID');
  } catch (error) {
    const code = error instanceof Error && error.message === 'BINDING_CANDIDATE_NOT_FOUND' ? error.message : 'BINDING_FAILED';
    return jsonError('绑定状态已变化，请刷新后重试', 409, code);
  }
}

export async function DELETE() {
  const identity = await owner();
  if (!identity) return jsonError('需要本机所有者身份', 401, 'LOCAL_OWNER_REQUIRED');
  return Response.json({ ok: true, binding: await unbindCollectorChat(identity.id) });
}

