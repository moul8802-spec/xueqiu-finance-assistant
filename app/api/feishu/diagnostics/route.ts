import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { diagnoseFeishuAppToken, FeishuApiError } from '@/lib/feishu';

export async function POST() {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要登录后运行飞书诊断', 401, 'SITE_LOGIN_REQUIRED');
  try {
    return Response.json({ ok: true, diagnostic: await diagnoseFeishuAppToken(identity.email) });
  } catch (error) {
    if (error instanceof FeishuApiError) return jsonError(error.message, error.status, error.code, error.details);
    return jsonError('飞书服务端诊断失败', 500, 'FEISHU_DIAGNOSTIC_FAILED');
  }
}

