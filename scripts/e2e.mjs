const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const marker = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const token = process.env.FEISHU_TEST_TOKEN || 'local-test-token';
const allowedChatId = process.env.FEISHU_TEST_CHAT_ID || 'simulated-finance-group';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, data };
}

async function requestWithRetry(path, options = {}, attempts = 3) {
  let result;
  for (let index = 0; index < attempts; index += 1) {
    result = await request(path, options);
    if (result.response.status !== 503 || index === attempts - 1) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return result;
}

function eventPayload({ eventId, messageId, chatId = allowedChatId, text }) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', token },
    event: {
      sender: { sender_id: { open_id: `ou-test-${marker}` } },
      message: { message_id: messageId, chat_id: chatId, message_type: 'text', content: JSON.stringify({ text }) },
    },
  };
}

async function postEvent(payload) {
  return request('/api/feishu/events', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}

const checks = [];
function passed(name) { checks.push(name); }

const home = await request('/');
check(home.response.status === 200 && String(home.data).includes('雪球发布助手'), '移动端首页不可访问');
passed('移动端首页可访问');

const feishuStatus = await request('/api/feishu/status');
check(feishuStatus.response.ok && feishuStatus.data.status.configured === false, '未配置 OAuth 时状态不正确');
check(feishuStatus.data.status.missingScopes.includes('im:chat:readonly') && feishuStatus.data.status.missingScopes.includes('im:message.group_msg:get_as_user'), '权限检查未列出必需权限');
passed('OAuth 未配置状态与必需权限明确可见');

const oauthStart = await request('/api/feishu/oauth/start', { redirect: 'manual' });
check(oauthStart.response.status === 503 && oauthStart.data.code === 'FEISHU_OAUTH_NOT_CONFIGURED', 'OAuth 服务端缺少密钥时未明确失败');
passed('OAuth 密钥缺失时不会伪造连接成功');

const oauthCallback = await request('/api/feishu/oauth/callback');
check(oauthCallback.response.status === 400 && oauthCallback.data.code === 'MISSING_OAUTH_STATE', 'OAuth 回调未校验 state');
passed('OAuth 回调强制校验 state');

const importedLines = [
  `央行今日开展逆回购操作 ${marker}，联系人 13800138000。`,
  `A股主要指数午后回升 ${marker}。`,
  `某上市公司公告前三季度净利润增长 ${marker}。`,
  `人民币汇率盘中保持稳定 ${marker}。`,
  `行业数据显示出口同比改善 ${marker}。`,
  `港股成交额较昨日放大 ${marker}。`,
  `企业宣布新的股份回购计划 ${marker}。`,
  `债券市场收益率小幅波动 ${marker}。`,
  `CPI 数据 ${marker} 将在本周公布，password=demo-${marker}。`,
  `央行今日开展逆回购操作 ${marker}，联系人 13800138000。`,
];
const imported = await request('/api/import', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sourceLabel: 'iPhone 测试财经群', text: importedLines.join('\n') }),
});
check(imported.response.ok && imported.data.result.outcome === 'created', '10 条消息导入未生成草稿');
check(imported.data.result.inputCount === 10 && imported.data.result.duplicateCount === 1, '批量导入计数或批内去重不正确');
check(imported.data.result.organizationMode === 'rules', '未配置 AI 时没有明确使用安全规则回退');
const importedDrafts = await request('/api/drafts?status=pending');
const importedDraft = importedDrafts.data.drafts.find((item) => item.id === imported.data.result.draftId);
check(importedDraft && importedDraft.sourceLabel === 'iPhone 测试财经群', '导入草稿缺少来源记录');
check(importedDraft.body.includes('[手机号已隐藏]') && importedDraft.body.includes('[敏感凭证已隐藏]'), '导入消息未完成脱敏');
passed('手机端批量导入 10 条、批内去重、脱敏与来源记录');

const deviceNoToken = await request('/api/device/import', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirmed: true, text: `央行逆回购设备无令牌 ${marker}` }),
});
check(deviceNoToken.response.status === 401 && deviceNoToken.data.code === 'DEVICE_TOKEN_INVALID', '无令牌设备上传未被服务端拒绝');
passed('设备上传无令牌被服务端拒绝');

const pairingResponse = await requestWithRetry('/api/devices', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: `e2e-${marker}`, platform: 'ios' }),
});
check(pairingResponse.response.ok && pairingResponse.data.pairing.token, '设备配对未发放一次性令牌');
const deviceToken = pairingResponse.data.pairing.token;
const deviceLines = Array.from({ length: 9 }, (_, index) => `A股市场设备测试消息 ${marker}-${index}，净利润与成交额信息。`);
deviceLines.push(deviceLines[0]);
const deviceImport = await request('/api/device/import', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
  body: JSON.stringify({ sourceLabel: 'iPhone 快捷指令测试', text: deviceLines.join('\n'), confirmed: true, clientMessageId: crypto.randomUUID() }),
});
check(deviceImport.response.ok && deviceImport.data.result.outcome === 'created' && deviceImport.data.result.duplicateCount === 1, '设备令牌导入 10 条消息未按预期去重');
passed('设备令牌上传 10 条消息、去重与草稿生成');

const pairings = await request('/api/devices');
check(pairings.response.ok && pairings.data.pairings.some((item) => item.id === pairingResponse.data.pairing.id && !item.token), '设备列表泄露了长期令牌');
const revoked = await request(`/api/devices/${pairingResponse.data.pairing.id}`, { method: 'DELETE' });
check(revoked.response.ok, '设备令牌撤销失败');
const afterRevoke = await request('/api/device/import', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
  body: JSON.stringify({ sourceLabel: '撤销测试', text: `央行撤销令牌测试 ${marker}`, confirmed: true }),
});
check(afterRevoke.response.status === 401 && afterRevoke.data.code === 'DEVICE_TOKEN_INVALID', '撤销后的令牌仍可上传');
passed('令牌撤销后服务端拒绝上传');

const chatsWithoutConnection = await request('/api/feishu/chats');
check(chatsWithoutConnection.response.status === 401 && chatsWithoutConnection.data.code === 'FEISHU_NOT_CONNECTED' && !chatsWithoutConnection.data.chats, '未连接时返回了群聊数据');
passed('未连接时不返回模拟群聊');

const messagesWithoutChat = await request('/api/feishu/messages');
check(messagesWithoutChat.response.status === 400 && messagesWithoutChat.data.code === 'CHAT_NOT_SELECTED' && !messagesWithoutChat.data.messages, '未选择群时返回了消息数据');
passed('未选择真实群时不返回模拟消息');

const wrongChallenge = await postEvent({ type: 'url_verification', token: 'wrong', challenge: 'bad' });
check(wrongChallenge.response.status === 403, '错误 Verification Token 未被拒绝');
passed('错误回调令牌被拒绝');

const challenge = await postEvent({ type: 'url_verification', token, challenge: `challenge-${marker}` });
check(challenge.response.ok && challenge.data.challenge === `challenge-${marker}`, '飞书 URL 验证失败');
passed('飞书 URL 验证通过');

const rejected = await postEvent(eventPayload({
  eventId: `evt-reject-${marker}`, messageId: `msg-reject-${marker}`, chatId: `not-allowed-${marker}`,
  text: '央行发布新的利率安排。',
}));
check(rejected.response.ok && rejected.data.result.outcome === 'rejected', '群白名单未拒绝非授权群');
passed('来源群白名单生效');

const filtered = await postEvent(eventPayload({
  eventId: `evt-filter-${marker}`, messageId: `msg-filter-${marker}`, text: `团队下午茶改到三点 ${marker}`,
}));
check(filtered.response.ok && filtered.data.result.outcome === 'filtered', '非财经消息未被筛除');
passed('非财经内容被筛除');

const financeText = `央行今日开展逆回购操作 ${marker}，联系人 13800138000，邮箱 test@example.com，token=abc123。`;
const first = await postEvent(eventPayload({
  eventId: `evt-finance-${marker}`, messageId: `msg-finance-${marker}`, text: financeText,
}));
check(first.response.ok && ['created', 'merged'].includes(first.data.result.outcome), '财经消息未生成或归并草稿');
const draftId = first.data.result.draftId;
passed('财经消息生成有来源草稿');

const pending = await request('/api/drafts?status=pending');
const draft = pending.data.drafts.find((item) => item.id === draftId);
check(draft, '生成的草稿未进入待审核队列');
check(draft.body.includes('[手机号已隐藏]') && draft.body.includes('[邮箱已隐藏]') && draft.body.includes('[敏感凭证已隐藏]'), '敏感信息未完整脱敏');
check(draft.body.includes('来源：模拟财经群'), '草稿缺少来源标记');
passed('手机号、邮箱、凭证已脱敏');

const repeatedId = await postEvent(eventPayload({
  eventId: `evt-finance-${marker}`, messageId: `msg-finance-${marker}`, text: financeText,
}));
check(repeatedId.response.ok && repeatedId.data.result.outcome === 'duplicate', '重复事件 ID 未去重');
passed('重复事件 ID 去重');

const repeatedContent = await postEvent(eventPayload({
  eventId: `evt-content-${marker}`, messageId: `msg-content-${marker}`, text: financeText,
}));
check(repeatedContent.response.ok && repeatedContent.data.result.outcome === 'duplicate', '24 小时相同内容未去重');
passed('24 小时相同内容去重');

const merged = await postEvent(eventPayload({
  eventId: `evt-merge-${marker}`, messageId: `msg-merge-${marker}`,
  text: `央行补充说明本次逆回购中标利率保持稳定 ${marker}。`,
}));
check(merged.response.ok && merged.data.result.outcome === 'merged' && merged.data.result.draftId === draftId, '同主题消息未在 30 分钟窗口归并');
passed('30 分钟同主题归并');

const editedBody = `${draft.body}\n\n人工核验标记：${marker}`;
const edited = await request(`/api/drafts/${draftId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: editedBody }),
});
check(edited.response.ok && edited.data.draft.body.endsWith(marker), '草稿编辑保存失败');
passed('审核编辑保存');

const copied = await request(`/api/drafts/${draftId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'copied' }),
});
check(copied.response.ok && copied.data.draft.status === 'copied', '复制状态更新失败');
const copiedQueue = await request('/api/drafts?status=copied');
check(copiedQueue.data.drafts.some((item) => item.id === draftId), '草稿未进入待确认队列');
passed('复制后进入待确认队列');

const published = await request(`/api/drafts/${draftId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'published' }),
});
check(published.response.ok && published.data.draft.status === 'published', '发布确认状态更新失败');
passed('人工发布确认可记录');

const audit = await request('/api/audit?limit=100');
check(audit.response.ok && audit.data.logs.some((item) => item.entityId === draftId && item.action === 'draft_updated'), '操作日志缺少草稿更新记录');
check(audit.data.logs.some((item) => item.action === 'message_duplicate'), '操作日志缺少去重记录');
check(audit.data.logs.some((item) => item.action === 'manual_import_draft_created' && item.entityId === imported.data.result.draftId), '操作日志缺少手动导入记录');
passed('操作日志完整可查');

console.log(JSON.stringify({ ok: true, baseUrl, draftId, checks }, null, 2));
