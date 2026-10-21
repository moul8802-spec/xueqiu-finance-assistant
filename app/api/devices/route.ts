import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { createDevicePairing, listDevicePairings } from '@/db/repository';

export async function GET() {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('只有站点所有者可以查看设备', 401, 'SITE_OWNER_REQUIRED');
  return Response.json({ ok: true, pairings: await listDevicePairings(identity.id) });
}

export async function POST(request: Request) {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('只有站点所有者可以配对设备', 401, 'SITE_OWNER_REQUIRED');
  const body = await request.json().catch(() => null) as { label?: unknown; platform?: unknown } | null;
  if (!body || (body.platform !== 'ios' && body.platform !== 'windows')) return jsonError('请选择 iPhone 或 Windows 设备', 400, 'DEVICE_PLATFORM_INVALID');
  if (body.label != null && (typeof body.label !== 'string' || body.label.length > 80)) return jsonError('设备名称格式不正确', 400, 'DEVICE_LABEL_INVALID');
  try {
    const pairing = await createDevicePairing(identity.id, typeof body.label === 'string' ? body.label : '', body.platform);
    return Response.json({ ok: true, pairing });
  } catch (error) {
    console.error('[device-pairing] failed', error);
    return jsonError('设备配对暂时失败，请重试', 503, 'DEVICE_PAIRING_UNAVAILABLE');
  }
}
