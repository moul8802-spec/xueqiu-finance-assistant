declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FEISHU_VERIFICATION_TOKEN?: string;
    FEISHU_ALLOWED_CHAT_IDS?: string;
    FEISHU_ALLOWED_CHAT_NAMES?: string;
    FEISHU_APP_ID?: string;
    FEISHU_APP_SECRET?: string;
    FEISHU_OAUTH_REDIRECT_URI?: string;
    FEISHU_TOKEN_ENCRYPTION_KEY?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    SIMULATION_MODE?: string;
    SITE_OWNER_USER_ID?: string;
  }
}
