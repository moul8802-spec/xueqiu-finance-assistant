import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { FeishuApiError, listFeishuChats, saveSelectedChat } from '@/lib/feishu';

export async function GET() {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后读取群聊', 401, 'SITE_LOGIN_REQUIRED');
  try {
    return Response.json({ ok: true, chats: await listFeishuChats(identity.id) });
  } catch (error) {
    return handleError(error, '读取飞书群聊失败');
  }
}

export async function POST(request: Request) {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后选择群聊', 401, 'SITE_LOGIN_REQUIRED');
  const body = await request.json().catch(() => null) as { chatId?: unknown } | null;
  if (!body || typeof body.chatId !== 'string' || !body.chatId) return jsonError('请选择群聊', 400, 'CHAT_ID_REQUIRED');
  try {
    const chats = await listFeishuChats(identity.id);
    const chat = chats.find((item) => item.chatId === body.chatId);
    if (!chat) return jsonError('该群不在当前飞书账号可见列表中', 404, 'CHAT_NOT_VISIBLE');
    return Response.json({ ok: true, selectedChat: await saveSelectedChat(identity.id, chat) });
  } catch (error) {
    return handleError(error, '保存财经群白名单失败');
  }
}

function handleError(error: unknown, fallback: string) {
  if (error instanceof FeishuApiError) return jsonError(error.message, error.status, error.code, error.details);
  return jsonError(fallback, 500, 'FEISHU_CHAT_FAILED');
}

