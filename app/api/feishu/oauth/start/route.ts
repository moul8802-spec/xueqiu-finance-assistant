import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { beginFeishuOAuth, FeishuApiError } from '@/lib/feishu';

export async function GET(request: Request) {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要先登录站点', 401, 'SITE_LOGIN_REQUIRED');
  try {
    const mode = new URL(request.url).searchParams.get('mode') === 'minimal' ? 'minimal' : 'full';
    return Response.redirect(await beginFeishuOAuth(identity.id, mode), 302);
  } catch (error) {
    return feishuError(error);
  }
}

function feishuError(error: unknown) {
  if (error instanceof FeishuApiError) return jsonError(error.message, error.status, error.code, error.details);
  return jsonError('无法开始飞书授权', 500, 'FEISHU_OAUTH_START_FAILED');
}

