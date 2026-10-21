import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { consumeOAuthState, exchangeAuthorizationCode, FeishuApiError, recordFeishuOAuthFailure } from '@/lib/feishu';

export async function GET(request: Request) {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('需要先登录站点再完成飞书授权', 401, 'SITE_LOGIN_REQUIRED');
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');
  const providerDescription = url.searchParams.get('error_description');
  const providerCode = url.searchParams.get('error_code') || providerError;
  const providerLogId = url.searchParams.get('ttLogId') || url.searchParams.get('tt_log_id') || url.searchParams.get('log_id');
  const oauthMode = url.searchParams.get('mode') || 'provider_callback';
  const code = url.searchParams.get('code');
  if (!state) return jsonError('缺少 OAuth state', 400, 'MISSING_OAUTH_STATE');

  try {
    const redirectUri = await consumeOAuthState(identity.id, state);
    if (providerError) {
      await recordFeishuOAuthFailure(identity.email, {
        code: providerCode || 'FEISHU_PROVIDER_ERROR',
        message: providerDescription || providerError,
        ttLogId: providerLogId,
        mode: oauthMode,
      });
      return backToDashboard(request, {
        feishu_error: providerDescription || providerError,
        feishu_error_code: providerCode || providerError,
        ...(providerLogId ? { feishu_tt_log_id: providerLogId } : {}),
      });
    }
    if (!code) return jsonError('飞书回调缺少授权码', 400, 'MISSING_AUTHORIZATION_CODE');
    await exchangeAuthorizationCode(identity.id, code, redirectUri);
    return backToDashboard(request, { feishu: 'connected' });
  } catch (error) {
    if (error instanceof FeishuApiError) {
      return backToDashboard(request, { feishu_error: error.message, feishu_error_code: String(error.code) });
    }
    return backToDashboard(request, { feishu_error: '飞书授权回调处理失败', feishu_error_code: 'FEISHU_CALLBACK_FAILED' });
  }
}

function backToDashboard(request: Request, params: Record<string, string>) {
  const url = new URL('/', request.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}

