import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';

export async function dashboardActor() {
  const identity = await dashboardOwnerIdentity();
  return identity?.email ?? null;
}

export async function dashboardIdentity() {
  const user = await getChatGPTUser();
  if (user) return { id: user.userId, email: user.email, displayName: user.displayName };
  if (env.LOCAL_DESKTOP_MODE === 'true' && env.FEISHU_LOCAL_OWNER_ID) {
    return { id: env.FEISHU_LOCAL_OWNER_ID, email: 'local-owner', displayName: '本机所有者' };
  }
  if (env.SIMULATION_MODE === 'true') {
    return { id: 'local-simulator', email: 'local-simulator', displayName: '本地测试用户' };
  }
  return null;
}

/**
 * The site may be publicly reachable, but the dashboard and every read API
 * remain owner-only. The local simulator is explicitly permitted only while
 * SIMULATION_MODE is enabled, and never on the deployed public site.
 */
export async function dashboardOwnerIdentity() {
  const identity = await dashboardIdentity();
  if (!identity) return null;
  if (identity.id === 'local-simulator' && env.SIMULATION_MODE === 'true') return identity;
  if (identity.id === env.FEISHU_LOCAL_OWNER_ID && env.LOCAL_DESKTOP_MODE === 'true') return identity;
  if (!env.SITE_OWNER_USER_ID || identity.id !== env.SITE_OWNER_USER_ID) return null;
  return identity;
}

export function jsonError(message: string, status: number, code?: string | number, details?: unknown) {
  return Response.json({ ok: false, error: message, code, details }, { status });
}


