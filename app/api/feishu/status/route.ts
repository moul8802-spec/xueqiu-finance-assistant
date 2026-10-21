import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { feishuConnectionStatus, FeishuApiError } from '@/lib/feishu';

export async function GET() {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后查看飞书连接', 401, 'SITE_LOGIN_REQUIRED');
  try {
    return Response.json({ ok: true, status: await feishuConnectionStatus(identity.id) });
  } catch (error) {
    if (error instanceof FeishuApiError) return jsonError(error.message, error.status, error.code, error.details);
    return jsonError('飞书连接状态读取失败', 500, 'FEISHU_STATUS_FAILED');
  }
}

