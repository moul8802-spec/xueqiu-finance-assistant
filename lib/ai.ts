import { env } from 'cloudflare:workers';

export type AiMessageInput = { messageId: string; text: string; createTime: number };
export type AiOrganization = {
  selectedMessageIds: string[];
  category: 'A股盘面' | '政策监管' | '公司公告' | '科技产业' | '资金面' | '解禁减持' | '海外市场' | '宏观' | '其他';
  title: string;
  body: string;
};

export class AiApiError extends Error {
  constructor(message: string, public readonly code: string | number, public readonly status: number, public readonly details?: unknown) {
    super(message);
  }
}

export async function organizeFinancialMessages(messages: AiMessageInput[]): Promise<AiOrganization> {
  const provider = String(env.AI_PROVIDER || (env.AI_API_KEY ? 'deepseek' : 'openai')).toLowerCase();
  const apiKey = env.AI_API_KEY || env.OPENAI_API_KEY;
  const model = env.AI_MODEL || env.OPENAI_MODEL;
  if (!apiKey || !model) {
    throw new AiApiError('AI 整理尚未配置 AI_API_KEY/AI_MODEL（或兼容的 OPENAI_API_KEY/OPENAI_MODEL）', 'AI_NOT_CONFIGURED', 503);
  }
  const baseUrl = (env.AI_BASE_URL || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com')).replace(/\/$/u, '');
  const instructions = [
    '你是财经信息编辑。只选择具有明确财经事实或市场信息的消息。',
    '不得补充输入中没有的数字、结论或来源。忽略闲聊、广告、投资荐股和无法核验的传言。',
    '正文用口语化、简洁的中文整理，不要机构研报腔、不要 AI 套话、不要以“朋友们”开头；服务端会追加真实来源。',
    '提取关键事实、数字、公司名和时间；不确定内容必须在正文或标题中保留“待核验”提示。',
    '如果没有合格财经信息，selected_message_ids 返回空数组，title 和 body 返回空字符串。',
  ].join('\n');
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      selected_message_ids: { type: 'array', items: { type: 'string' } },
      category: { type: 'string', enum: ['A股盘面', '政策监管', '公司公告', '科技产业', '资金面', '解禁减持', '海外市场', '宏观', '其他'] },
      title: { type: 'string' }, body: { type: 'string' },
    }, required: ['selected_message_ids', 'category', 'title', 'body'],
  };
  const response = await fetch(provider === 'deepseek' ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(provider === 'deepseek'
      ? { model, temperature: 0.2, messages: [{ role: 'system', content: `${instructions}\n只返回 JSON，不要 Markdown 代码围栏。JSON schema：${JSON.stringify(schema)}` }, { role: 'user', content: JSON.stringify(messages) }] }
      : { model, instructions, input: JSON.stringify(messages), text: { format: { type: 'json_schema', name: 'financial_draft', strict: true, schema } } }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    const error = record(payload?.error);
    throw new AiApiError(
      primitiveString(error.message, `OpenAI API 返回 HTTP ${response.status}`),
      primitiveString(error.code, primitiveString(error.type, `HTTP_${response.status}`)),
      response.status || 502,
      { type: error.type, code: error.code },
    );
  }
  const outputText = provider === 'deepseek' ? extractChatCompletionText(payload) : extractOutputText(payload);
  if (!outputText) throw new AiApiError('AI 未返回可解析的整理结果', 'AI_EMPTY_RESPONSE', 502);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(outputText) as Record<string, unknown>;
  } catch {
    throw new AiApiError('AI 返回内容不是有效 JSON', 'AI_INVALID_JSON', 502);
  }
  const allowedIds = new Set(messages.map((message) => message.messageId));
  const selected = Array.isArray(parsed.selected_message_ids)
    ? parsed.selected_message_ids.map(String).filter((id) => allowedIds.has(id))
    : [];
  const categories = new Set(['A股盘面', '政策监管', '公司公告', '科技产业', '资金面', '解禁减持', '海外市场', '宏观', '其他']);
  return {
    selectedMessageIds: Array.from(new Set(selected)),
    category: (categories.has(String(parsed.category)) ? String(parsed.category) : '其他') as AiOrganization['category'],
    title: primitiveString(parsed.title).trim().slice(0, 120),
    body: primitiveString(parsed.body).trim().slice(0, 4000),
  };
}

function extractChatCompletionText(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = record(record(choices[0]).message);
  return primitiveString(message.content).replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim();
}

function extractOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(record(item).content) ? record(item).content as unknown[] : [];
    for (const part of content) {
      const value = record(part);
      if (value.type === 'output_text' && typeof value.text === 'string') return value.text;
    }
  }
  return '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function primitiveString(value: unknown, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
