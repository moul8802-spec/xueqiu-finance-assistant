import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { FeishuApiError, getRecentFeishuMessages, getSelectedChat } from '@/lib/feishu';
import { sanitizeText } from '@/db/repository';

export async function GET() {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后读取群消息', 401, 'SITE_LOGIN_REQUIRED');
  try {
    const chat = await getSelectedChat(identity.id);
    if (!chat) return jsonError('请先选择财经群', 400, 'CHAT_NOT_SELECTED');
    const messages = await getRecentFeishuMessages(identity.id, chat.chatId);
    return Response.json({
      ok: true,
      chat,
      messages: messages.map((message) => ({
        ...message,
        text: message.text ? sanitizeText(message.text).text : null,
      })),
      note: chat.external ? '这是跨组织群；实际可读范围由飞书应用类型、对外共享配置和群设置决定。' : null,
    });
  } catch (error) {
    if (error instanceof FeishuApiError) return jsonError(error.message, error.status, error.code, error.details);
    return jsonError('读取最近消息失败', 500, 'FEISHU_MESSAGE_FAILED');
  }
}

