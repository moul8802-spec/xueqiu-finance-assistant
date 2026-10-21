import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { ReviewDashboard } from '@/app/review-dashboard';
import { env } from 'cloudflare:workers';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Production stays sign-in gated. Local simulation mode is intentionally
  // usable without the Sites authentication dispatcher so the full workflow
  // can be tested before deployment.
  if (env.SIMULATION_MODE !== 'true') {
    const user = await requireChatGPTUser('/');
    if (!env.SITE_OWNER_USER_ID || user.userId !== env.SITE_OWNER_USER_ID) {
      return <main className="grid min-h-dvh place-items-center bg-background px-6 text-center"><div><h1 className="text-xl font-semibold">此站点仅限所有者访问</h1><p className="mt-2 text-sm text-muted-foreground">请使用已授权的站点所有者账号登录。</p></div></main>;
    }
  }
  return <ReviewDashboard />;
}
