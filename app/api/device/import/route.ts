import { jsonError } from '@/app/api/_auth';
import { authorizeDeviceToken, createDraftFromImportedMessages } from '@/db/repository';
import { AiApiError } from '@/lib/ai';

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return jsonError('设备入口必须通过 HTTPS 使用', 400, 'HTTPS_REQUIRED');
  }
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : request.headers.get('x-device-token')?.trim() ?? '';
  if (!token || token.length < 32) return jsonError('缺少或无效的设备令牌', 401, 'DEVICE_TOKEN_INVALID');
  const pairing = await authorizeDeviceToken(token);
  if (!pairing) return jsonError('缺少或无效的设备令牌', 401, 'DEVICE_TOKEN_INVALID');
  const body = await request.json().catch(() => null) as { sourceLabel?: unknown; text?: unknown; confirmed?: unknown; clientMessageId?: unknown } | null;
  if (!body || body.confirmed !== true) return jsonError('导入前必须由设备端确认本次提交', 400, 'DEVICE_CONFIRMATION_REQUIRED');
  if (typeof body.text !== 'string' || !body.text.trim()) return jsonError('请提供要导入的消息文本', 400, 'IMPORT_TEXT_REQUIRED');
  if (body.text.length > 30_000) return jsonError('单次导入内容不能超过 30000 字', 400, 'IMPORT_TEXT_TOO_LONG');
  if (body.sourceLabel != null && typeof body.sourceLabel !== 'string') return jsonError('来源名称格式不正确', 400, 'IMPORT_SOURCE_INVALID');
  if (body.clientMessageId != null && (typeof body.clientMessageId !== 'string' || body.clientMessageId.length > 120)) return jsonError('客户端消息编号格式不正确', 400, 'CLIENT_MESSAGE_ID_INVALID');
  try {
    const result = await createDraftFromImportedMessages(pairing.actorId, pairing.label, {
      sourceLabel: typeof body.sourceLabel === 'string' ? body.sourceLabel : `${pairing.platform === 'ios' ? 'iPhone' : 'Windows'} 主动导入`,
      text: body.text,
      importSource: 'device',
      devicePairingId: pairing.id,
      clientMessageId: typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined,
    });
    return Response.json({ ok: true, result: { outcome: result.outcome, draftId: 'draftId' in result ? result.draftId : undefined, inputCount: result.inputCount, selectedCount: result.selectedCount, duplicateCount: result.duplicateCount, organizationMode: result.organizationMode } });
  } catch (error) {
    if (error instanceof AiApiError) return jsonError(error.message, error.status, error.code, error.details);
    if (error instanceof Error && ['IMPORT_TOO_MANY_MESSAGES', 'IMPORT_TEXT_REQUIRED'].includes(error.message)) return jsonError(error.message === 'IMPORT_TOO_MANY_MESSAGES' ? '单次最多导入 50 条非空消息' : '请提供要导入的消息文本', 400, error.message);
    return jsonError('设备消息导入失败', 500, 'DEVICE_IMPORT_FAILED');
  }
}

export async function GET() {
  return jsonError('设备入口仅接受 POST 上传', 405, 'METHOD_NOT_ALLOWED');
}
