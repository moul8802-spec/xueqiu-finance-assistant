import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { createAiDraftFromFeishuMessages } from '@/db/repository';
import { AiApiError } from '@/lib/ai';
import { FeishuApiError, getRecentFeishuMessages, getSelectedChat } from '@/lib/feishu';

export async function POST() {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后整理消息', 401, 'SITE_LOGIN_REQUIRED');
  try {
    const chat = await getSelectedChat(identity.id);
    if (!chat) return jsonError('请先选择财经群', 400, 'CHAT_NOT_SELECTED');
    const messages = await getRecentFeishuMessages(identity.id, chat.chatId);
    const result = await createAiDraftFromFeishuMessages(identity.id, identity.email, chat, messages);
    return Response.json({ ok: true, result });
  } catch (error) {
    if (error instanceof FeishuApiError || error instanceof AiApiError) {
      return jsonError(error.message, error.status, error.code, error.details);
    }
    if (error instanceof Error && error.message === 'CHAT_NOT_ALLOWLISTED') {
      return jsonError('该群未加入当前用户的财经群白名单', 403, 'CHAT_NOT_ALLOWLISTED');
    }
    return jsonError('AI 整理失败', 500, 'AI_ORGANIZE_FAILED');
  }
}

