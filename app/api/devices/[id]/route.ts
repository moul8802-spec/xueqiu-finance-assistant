import { dashboardOwnerIdentity, jsonError } from '@/app/api/_auth';
import { revokeDevicePairing } from '@/db/repository';

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await dashboardOwnerIdentity();
  if (!identity) return jsonError('只有站点所有者可以撤销设备', 401, 'SITE_OWNER_REQUIRED');
  const { id } = await context.params;
  const revoked = await revokeDevicePairing(identity.id, id);
  if (!revoked) return jsonError('设备不存在或已不属于当前账户', 404, 'DEVICE_NOT_FOUND');
  return Response.json({ ok: true });
}
