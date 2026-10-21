import { env } from 'cloudflare:workers';

export type AiMessageInput = { messageId: string; text: string; createTime: number };
export type AiOrganization = {
  selectedMessageIds: string[];
  category: '宏观' | '公司' | '行业' | '市场' | '其他';
  title: string;
  body: string;
};

export class AiApiError extends Error {
  constructor(message: string, public readonly code: string | number, public readonly status: number, public readonly details?: unknown) {
    super(message);
  }
}

export async function organizeFinancialMessages(messages: AiMessageInput[]): Promise<AiOrganization> {
  if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) {
    throw new AiApiError('AI 整理尚未配置 OPENAI_API_KEY 与 OPENAI_MODEL', 'AI_NOT_CONFIGURED', 503);
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      instructions: [
        '你是财经信息编辑。只选择具有明确财经事实或市场信息的消息。',
        '不得补充输入中没有的数字、结论或来源。忽略闲聊、广告、投资荐股和无法核验的传言。',
        '正文用中性、简洁的中文整理；不写来源行，服务端会追加真实群聊来源。',
        '如果没有合格财经信息，selected_message_ids 返回空数组，title 和 body 返回空字符串。',
      ].join('\n'),
      input: JSON.stringify(messages),
      text: {
        format: {
          type: 'json_schema',
          name: 'financial_draft',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              selected_message_ids: { type: 'array', items: { type: 'string' } },
              category: { type: 'string', enum: ['宏观', '公司', '行业', '市场', '其他'] },
              title: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['selected_message_ids', 'category', 'title', 'body'],
          },
        },
      },
    }),
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
  const outputText = extractOutputText(payload);
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
  const categories = new Set(['宏观', '公司', '行业', '市场', '其他']);
  return {
    selectedMessageIds: Array.from(new Set(selected)),
    category: (categories.has(String(parsed.category)) ? String(parsed.category) : '其他') as AiOrganization['category'],
    title: primitiveString(parsed.title).trim().slice(0, 120),
    body: primitiveString(parsed.body).trim().slice(0, 4000),
  };
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
