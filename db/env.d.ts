declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FEISHU_VERIFICATION_TOKEN?: string;
    FEISHU_ALLOWED_CHAT_IDS?: string;
  FEISHU_ALLOWED_CHAT_NAMES?: string;
  FEISHU_WS_ENABLED?: string;
  FEISHU_WS_BRIDGE_TOKEN?: string;
  FEISHU_LOCAL_OWNER_ID?: string;
    FEISHU_APP_ID?: string;
    FEISHU_APP_SECRET?: string;
    FEISHU_OAUTH_REDIRECT_URI?: string;
    FEISHU_TOKEN_ENCRYPTION_KEY?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    AI_PROVIDER?: string;
    AI_API_KEY?: string;
    AI_MODEL?: string;
    AI_BASE_URL?: string;
    SIMULATION_MODE?: string;
    SITE_OWNER_USER_ID?: string;
  }
}
