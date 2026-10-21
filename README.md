# 飞书 → 雪球发布助手

「雪球财经助手 v2.0 · 飞书采集版」是一个独立的站点审核工具：Windows 程序使用飞书官方 Node SDK WebSocket 长连接，以 App ID / App Secret 连接飞书，选择自己创建并可控的“财经采集群”，自动接收 `im.message.receive_v1`，按消息 ID + 内容指纹去重、脱敏、分类和整理，生成带来源的雪球动态草稿。用户必须在手机网页/PWA 中检查并编辑，然后复制内容、打开雪球并自行确认发布。

旧版“飞书消息导入”仍保留作为 v1.2 备用入口，但不再是主流程；RSS 也只作为可选辅助源。不会读取受限群，不使用隐藏接口、客户端缓存或 OCR 批量抓取。

本项目不会调用非官方雪球发帖接口，不保存雪球 Cookie，也不会模拟点击或绕过平台风控。

## 本地运行

1. 将 `.dev.vars.example` 复制为 `.dev.vars`。
2. 如只测试原有审核流程，可将 `SIMULATION_MODE` 设为 `true`；OAuth 读取仍只接受真实飞书返回，不显示模拟群聊或模拟消息。
3. 运行 `npm install`，再运行 `npm run dev`。
4. 打开终端显示的本地地址；在 iPhone Safari 中可用“添加到主屏幕”安装为 PWA。

## 飞书配置

1. 在飞书开放平台创建“企业自建应用”，记录 App ID / App Secret，并发布可用版本。
2. 在安全设置中把 OAuth 重定向 URL 精确配置为：`https://feishu-xueqiu-assistant.goodsnipe129.chatgpt.site/api/feishu/oauth/callback`。
3. 申请并通过以下权限：`im:chat:readonly`、`im:message:readonly`、`im:message.group_msg:get_as_user`。用户授权时还会请求 `offline_access`，用于在服务端刷新用户令牌。
4. 在 Sites 服务端运行时变量中配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_OAUTH_REDIRECT_URI`、`FEISHU_TOKEN_ENCRYPTION_KEY`、`SITE_OWNER_USER_ID`。App Secret、令牌加密密钥和用户令牌不得写入前端、Git 或日志。
5. AI 整理优先使用 `AI_PROVIDER=deepseek`、`AI_API_KEY`、`AI_MODEL=deepseek-chat`、`AI_BASE_URL=https://api.deepseek.com`；也兼容 OpenAI 变量。缺失时页面明确显示规则模式。
6. Windows 首次启动会在 `%LOCALAPPDATA%\\雪球财经助手\\.dev.vars` 创建本机配置模板。只需填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；`FEISHU_ALLOWED_CHAT_IDS` 可保持为空。长连接启动后，机器人收到第一条群消息，审核页会显示群名、群 ID 和“绑定为财经采集群”按钮，确认后自动保存绑定，不需要手动寻找群 ID。App Secret 只保存在本机配置，不会显示在页面或日志。无需公网回调 URL、Sites 或 `FEISHU_VERIFICATION_TOKEN`。

页面中的“测试应用令牌”只在服务端验证 App ID / App Secret 能否取得应用身份令牌，返回值仅包含 HTTP 状态、飞书错误码、错误原因和 `ttLogId`，不会返回或记录令牌。应用令牌通过后，可再使用最小权限 OAuth（仅 `offline_access`）区分应用配置问题与用户账号安全策略拒绝。

飞书不同租户的数据相互隔离。页面会标记外部群，但最终是否能读取，仍由飞书应用类型、对外共享能力、机器人是否在群内、群的复制/保密设置以及当前用户权限决定。接口失败时页面原样展示飞书错误码与原因，不会替换成模拟数据。

## 部署

项目使用 Sites + D1。整个站点保持“仅所有者”访问，审核页和 OAuth API 通过 ChatGPT 登录保护。D1 保存 AES-GCM 加密后的飞书令牌、所选群白名单、脱敏后的消息、草稿状态和操作日志；不保存飞书原始消息或雪球凭证。

- **OAuth 主动读取**：站点可继续保持仅所有者可访问；用户浏览器登录站点后往返飞书授权回调。把回调 URL 加入飞书后台后即可使用。
- **公网事件回调**：`/api/feishu/events` 仅作为旧版兼容接口保留，不是 v2.0 主入口；Windows 长连接不依赖它。
- 不要在公开站点上保留 `SIMULATION_MODE=true`，否则模拟接口会失去登录保护。

## 测试入口

模拟模式下可在空队列点击“生成演示草稿”，或向 `/api/simulate` 发送 JSON：

```json
{"text":"央行今日开展2690亿元7天期逆回购操作，中标利率维持不变。","chatName":"宏观资讯"}
```

可验证：官方 WebSocket 事件订阅、断线重连、24 小时内容去重、同群同主题归并、手机号/邮箱/证件号/凭证样式脱敏、财经分类、AI/规则模式草稿、草稿编辑、复制状态更新与运行日志。最后一次真实端到端链路必须在配置真实 App ID / Secret、应用机器人能力和 `im.message.receive_v1` 权限后，由用户向自有采集群发送测试消息验证。

自动化端到端测试还会导入 10 条消息（其中 1 条重复），验证批内去重、历史去重、来源记录、敏感信息脱敏和草稿生成。生产环境缺少 `OPENAI_API_KEY` 时，手工导入会明确使用规则整理；配置后才调用 AI，不会把规则整理显示成 AI 成功。

## 安全与数据说明

- OAuth `state` 只保存 SHA-256 摘要，10 分钟过期且使用一次即删除。
- `user_access_token` / `refresh_token` 用 `FEISHU_TOKEN_ENCRYPTION_KEY` 经 AES-GCM 加密后存入 D1，API 与页面从不返回令牌。
- 页面展示消息前先脱敏；AI 只接收脱敏后的候选文本。
- AI 草稿强制追加真实来源群标记和人工核验提示，仍需人工审核后复制到雪球。

## Windows 免 Python 版本

仓库中的 `.github/workflows/windows-build.yml` 会在 GitHub Windows Runner 上安装构建用 Python、执行 `npm ci` 和 `npm run build`，再用 PyInstaller 将启动器、Node.js 运行时、网页资源和依赖打成 `雪球财经助手.exe`。最终用户不需要安装 Python 或 Node.js。启动器把本地状态保存到 `%LOCALAPPDATA%\\雪球财经助手\\state`，默认端口被占用时自动选择后续可用端口。

桌面包仍遵守现有边界：只处理用户主动复制并确认上传的消息；不实现受限飞书群自动采集，也不调用雪球自动发帖接口。审核后复制草稿并打开雪球，由用户自行确认发布。

