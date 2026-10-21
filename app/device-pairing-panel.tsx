'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Smartphone, Monitor, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Pairing = { id: string; label: string; platform: 'ios' | 'windows'; tokenHint: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null; expiresAt: number | null };

export function DevicePairingPanel() {
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/devices', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json() as { pairings: Pairing[] };
    setPairings(data.pairings);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function create(platform: 'ios' | 'windows') {
    setLoading(true); setNotice('');
    try {
      const response = await fetch('/api/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, platform }) });
      const data = await response.json() as { pairing?: { token: string }; error?: string };
      if (!response.ok || !data.pairing) throw new Error(data.error || '配对失败');
      setToken(data.pairing.token); setLabel(''); setNotice('设备已配对。令牌只显示这一次，请立即复制并保存到设备端。'); await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '配对失败'); }
    finally { setLoading(false); }
  }

  async function copy(value: string, message = '已复制') {
    await navigator.clipboard.writeText(value); setNotice(message);
  }

  async function revoke(id: string) {
    if (!window.confirm('撤销后该设备将无法继续上传，确定吗？')) return;
    const response = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
    if (response.ok) { setNotice('设备令牌已撤销'); await load(); }
  }

  const endpoint = typeof window === 'undefined' ? '/api/device/import' : `${window.location.origin}/api/device/import`;
  return <section className="mb-5 rounded-[22px] border border-border bg-card p-4 shadow-sm sm:p-5">
    <div className="flex items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><KeyRound className="size-4" /></div><div><h2 className="font-semibold">设备消息上传</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">公开的只有这个 HTTPS 写入入口。设备令牌不能读取草稿、来源或历史，也可以随时撤销。</p></div></div>
    <div className="mt-4 flex flex-col gap-2 sm:flex-row"><input aria-label="设备名称" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：我的 iPhone" className="h-10 flex-1 rounded-xl border border-border bg-background px-3 text-sm" /><Button disabled={loading} variant="outline" onClick={() => void create('ios')}><Smartphone />配对 iPhone</Button><Button disabled={loading} variant="outline" onClick={() => void create('windows')}><Monitor />配对 Windows</Button></div>
    <div className="mt-3 rounded-xl bg-muted/60 p-3 text-xs"><p className="font-medium">设备上传地址（不会包含消息正文）</p><div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-[11px]">{endpoint}</code><Button size="icon" variant="ghost" aria-label="复制上传地址" onClick={() => void copy(endpoint)}><Copy className="size-4" /></Button></div></div>
    {token && <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"><p className="font-semibold">新令牌（仅显示一次）</p><p className="mt-1 break-all font-mono text-[11px]">{token}</p><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void copy(token, '令牌已复制')}><Copy />复制令牌</Button><Button size="sm" variant="ghost" onClick={() => setToken('')}>我已保存</Button></div></div>}
    {notice && <output className="mt-3 block text-xs text-muted-foreground">{notice}</output>}
    <div className="mt-4 space-y-2">{pairings.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs"><span className="font-medium">{item.platform === 'ios' ? 'iPhone' : 'Windows'} · {item.label}</span><code className="text-muted-foreground">{item.tokenHint}</code><span className={`ml-auto ${item.revokedAt ? 'text-red-700' : 'text-emerald-700'}`}>{item.revokedAt ? '已撤销' : '可用'}</span>{!item.revokedAt && <Button size="icon" variant="ghost" aria-label={`撤销 ${item.label}`} onClick={() => void revoke(item.id)}><Trash2 className="size-4" /></Button>}</div>)}</div>
    <p className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground"><ShieldCheck className="size-3" />每次快捷指令或 Windows 上传前，设备端必须显示并确认本次提交。</p>
  </section>;
}
