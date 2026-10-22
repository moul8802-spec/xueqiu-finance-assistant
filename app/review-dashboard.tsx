'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, ChevronRight, CircleDot, Clipboard, ExternalLink, FileText,
  Inbox, MoreHorizontal, RefreshCw, ShieldCheck, Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FeishuConnectionPanel } from '@/app/feishu-connection-panel';
import { ManualImportPanel } from '@/app/manual-import-panel';
import { DevicePairingPanel } from '@/app/device-pairing-panel';

type Draft = {
  id: string; title: string; body: string; status: string; category: string;
  sourceLabel: string; sourceMessageIds: string[]; reviewFlags: string[];
  metadata?: { originalText?: string; keyPoints?: string[]; factCheckFlags?: string[]; organizationMode?: string };
  createdAt: number; updatedAt: number;
};

type SystemStatus = {
  mode: string; configured: boolean; allowedChats: number; pending: number;
  duplicatesToday: number; messagesToday: number; listener?: { enabled: boolean; connectionState?: string; lastReceivedAt: number | null; lastSuccessAt: number | null; lastRawEventAt?: number | null; lastEventId?: string | null; lastBridgeStatus?: number | null; lastError: string | null; consecutiveFailures: number };
  binding?: { status: 'unbound' | 'pending' | 'bound'; boundChatId: string | null; boundChatName: string | null; pendingChatId: string | null; pendingChatName: string | null; pendingMessageId: string | null; pendingReceivedAt: number | null };
};

type InboundMessage = { id: string; messageId: string; senderName: string | null; source: string; originalText: string | null; sanitizedText: string; sourceUrl: string | null; status: string; receivedAt: number; };
type AuditLog = { id: number; action: string; actor: string; entityType: string; entityId: string; details: Record<string, unknown>; createdAt: number };
type QueueView = 'new' | 'pending' | 'copied' | 'published' | 'skipped' | 'logs';

const VIEW_LABELS: Record<QueueView, string> = {
  new: '新消息', pending: '待审核', copied: '待发布', published: '已发布', skipped: '已忽略', logs: '运行日志',
};
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || 'dev-local';

export function ReviewDashboard() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [messages, setMessages] = useState<InboundMessage[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [view, setView] = useState<QueueView>('pending');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () => drafts.find((draft) => draft.id === selectedId) ?? drafts[0] ?? null,
    [drafts, selectedId],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [draftResponse, statusResponse] = await Promise.all([
        view === 'new' ? fetch('/api/messages?status=queued', { cache: 'no-store' }) : view === 'logs' ? fetch('/api/audit?limit=80', { cache: 'no-store' }) : fetch(`/api/drafts?status=${view}`, { cache: 'no-store' }),
        fetch('/api/status', { cache: 'no-store' }),
      ]);
      if (!draftResponse.ok || !statusResponse.ok) throw new Error('load_failed');
      const draftData = await draftResponse.json() as { drafts?: Draft[]; messages?: InboundMessage[]; logs?: AuditLog[] };
      const statusData = await statusResponse.json() as { status: SystemStatus };
      setDrafts(draftData.drafts ?? []); setMessages(draftData.messages ?? []); setLogs(draftData.logs ?? []);
      setStatus(statusData.status);
      setSelectedId((current) => current && (draftData.drafts ?? []).some((item) => item.id === current) ? current : draftData.drafts?.[0]?.id ?? null);
    } catch {
      setNotice('队列暂时无法读取，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadData());
    return () => window.cancelAnimationFrame(frame);
  }, [loadData]);
  useEffect(() => {
    const timer = window.setInterval(() => void loadData(), 15000);
    return () => window.clearInterval(timer);
  }, [loadData]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function savePatch(patch: { body?: string; status?: string }) {
    if (!selected) return false;
    const response = await fetch(`/api/drafts/${selected.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!response.ok) { setNotice('保存失败，请重试'); return false; }
    const data = await response.json() as { draft: Draft };
    if (patch.status && patch.status !== view) {
      setDrafts((items) => items.filter((item) => item.id !== selected.id));
      setSelectedId(null);
      if (view === 'pending') {
        setStatus((current) => current ? { ...current, pending: Math.max(0, current.pending - 1) } : current);
      }
    } else {
      setDrafts((items) => items.map((item) => item.id === selected.id ? data.draft : item));
    }
    return true;
  }

  async function copyDraft(openXueqiu = false) {
    if (!selected) return;
    if (openXueqiu) window.open('https://xueqiu.com/', '_blank', 'noopener,noreferrer');
    await navigator.clipboard.writeText(selected.body);
    await savePatch({ body: selected.body, status: view === 'pending' ? 'copied' : view });
    setNotice(openXueqiu ? '已复制，请在雪球中确认发布' : '内容已复制');
  }

  async function regenerate() {
    if (!selected) return;
    const response = await fetch(`/api/drafts/${selected.id}/regenerate`, { method: 'POST' });
    if (!response.ok) { setNotice('重新生成失败：请检查 AI 配置或来源消息'); return; }
    const data = await response.json() as { draft: Draft };
    setDrafts((items) => items.map((item) => item.id === selected.id ? data.draft : item));
    setNotice('已重新生成草稿');
  }

  async function changeBinding(action: 'bind' | 'ignore', candidate?: { chatId: string; chatName: string }) {
    const response = await fetch('/api/local/feishu/binding', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, chatId: candidate?.chatId, chatName: candidate?.chatName }),
    });
    if (!response.ok) { setNotice('绑定操作失败，请刷新后重试'); return; }
    setNotice(action === 'bind' ? '已绑定财经采集群' : '已忽略本次发现的群');
    await loadData();
  }

  async function unbind() {
    const response = await fetch('/api/local/feishu/binding', { method: 'DELETE' });
    if (!response.ok) { setNotice('解除绑定失败，请刷新后重试'); return; }
    setNotice('已解除绑定，等待下一条群消息');
    await loadData();
  }

  function switchView(next: QueueView) {
    setView(next);
    setDrafts([]);
    setSelectedId(null);
  }

  async function createDemoDraft() {
    const demoId = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}-${crypto.randomUUID().slice(0, 4)}`;
    const response = await fetch('/api/simulate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatName: '宏观资讯', text: `央行今日开展2690亿元7天期逆回购操作，中标利率维持不变。联系人手机号13800138000。演示编号 ${demoId}` }),
    });
    if (!response.ok) { setNotice('模拟入口未开启'); return; }
    const data = await response.json() as { result?: { outcome?: string } };
    setNotice(data.result?.outcome === 'duplicate' ? '重复演示消息已自动拦截' : '演示消息已进入审核队列');
    await loadData();
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      {notice && <output className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">{notice}</output>}
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Sparkles className="size-4" /></div>
            <div><p className="text-[15px] font-semibold tracking-tight">雪球财经助手 v2.0</p><p className="text-[11px] text-muted-foreground">飞书采集群自动接收 · AI整理 · 人工审核</p></div>
          </div>
          <Button variant="ghost" size="icon" aria-label="更多选项"><MoreHorizontal /></Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 pb-28 pt-5 sm:px-6 lg:grid-cols-[250px_minmax(0,1fr)] lg:pb-10 lg:pt-8">
        <aside className="hidden lg:block">
          <div className="sticky top-24 space-y-6">
            <nav className="space-y-1" aria-label="工作台导航">
              <button className={`nav-item ${view === 'new' ? 'nav-item-active' : ''}`} type="button" onClick={() => switchView('new')}><Inbox />新消息<span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{messages.length}</span></button>
              <button className={`nav-item ${view === 'pending' ? 'nav-item-active' : ''}`} type="button" onClick={() => switchView('pending')}><Inbox />待审核<span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{status?.pending ?? 0}</span></button>
              <button className={`nav-item ${view === 'copied' ? 'nav-item-active' : ''}`} type="button" onClick={() => switchView('copied')}><FileText />待确认</button>
              <button className={`nav-item ${view === 'published' ? 'nav-item-active' : ''}`} type="button" onClick={() => switchView('published')}><CheckCircle2 />已发布</button>
              <button className={`nav-item ${view === 'skipped' ? 'nav-item-active' : ''}`} type="button" onClick={() => switchView('skipped')}><FileText />已忽略</button>
              <button className={`nav-item ${view === 'logs' ? 'nav-item-active' : ''}`} type="button" onClick={() => switchView('logs')}><FileText />运行日志</button>
            </nav>
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-emerald-700" />接入状态</div>
              <div className="space-y-2.5 text-xs text-muted-foreground">
                <StatusRow label="飞书长连接" value={connectionLabel(status?.listener?.connectionState)} />
                <StatusRow label="采集群绑定" value={bindingLabel(status?.binding?.status)} />
                <StatusRow label="当前群" value={status?.binding?.boundChatName || '未绑定'} />
                <StatusRow label="群白名单" value={`${status?.allowedChats ?? 0} 个`} />
                <StatusRow label="今日去重" value={`${status?.duplicatesToday ?? 0} 条`} />
                <StatusRow label="最近接收" value={status?.listener?.lastReceivedAt ? formatTime(status.listener.lastReceivedAt) : '尚无'} />
                <StatusRow label="最近错误" value={status?.listener?.lastError || '无'} />
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0">
          <details className="mb-5 rounded-2xl border border-border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium text-muted-foreground">备用入口（手动导入 / 设备上传）</summary>
            <div className="mt-4 space-y-4"><ManualImportPanel onDraftCreated={loadData} /><DevicePairingPanel /></div>
          </details>
          <FeishuConnectionPanel onDraftCreated={loadData} />
          <CollectorBindingPanel binding={status?.binding} onAction={changeBinding} onUnbind={unbind} />
          <div className="mb-5 flex items-end justify-between gap-3">
            <div>
              <div className={`mb-1 flex items-center gap-2 text-xs font-medium ${['connected', 'waiting_for_binding'].includes(status?.listener?.connectionState || '') ? 'text-emerald-700' : 'text-amber-700'}`}><CircleDot className="size-3 fill-current" />{['connected', 'waiting_for_binding'].includes(status?.listener?.connectionState || '') ? '飞书长连接已连接' : status?.listener?.connectionState === 'reconnecting' ? '飞书长连接重连中' : '等待飞书长连接'}{status?.listener?.connectionState === 'waiting_for_binding' ? ` · ${bindingLabel(status?.binding?.status)}` : ''}</div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{VIEW_LABELS[view]}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{loading ? '正在读取草稿…' : `${drafts.length} 条${VIEW_LABELS[view]}草稿`}</p>
            </div>
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={() => void loadData()}><RefreshCw />刷新</Button>
          </div>

          <div className="mb-4 flex gap-2 overflow-x-auto lg:hidden" aria-label="草稿状态">
            {(['new', 'pending', 'copied', 'published', 'skipped', 'logs'] as QueueView[]).map((item) => <Button key={item} type="button" size="sm" variant={view === item ? 'default' : 'outline'} onClick={() => switchView(item)}>{VIEW_LABELS[item]}{item === 'pending' ? ` ${status?.pending ?? 0}` : ''}</Button>)}
          </div>

          {view === 'new' && <div className="space-y-3">{messages.map((message) => <article key={message.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm"><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">{message.status}</Badge><span>{message.source}</span><span>{formatTime(message.receivedAt)}</span>{message.senderName && <span>发送者：{message.senderName}</span>}</div><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{message.sanitizedText}</p>{message.sourceUrl && <a className="mt-2 block truncate text-xs text-primary underline" href={message.sourceUrl} target="_blank" rel="noreferrer">{message.sourceUrl}</a>}<p className="mt-2 text-[11px] text-muted-foreground">消息 ID：{message.messageId}</p></article>)}{!loading && !messages.length && <EmptyState text="暂无新消息，飞书采集群的新消息会自动出现在这里" />}</div>}
          {view === 'logs' && <div className="space-y-2">{logs.map((log) => <article key={log.id} className="rounded-xl border border-border bg-card p-3 text-xs"><div className="flex justify-between gap-3"><span className="font-medium">{log.action}</span><span className="text-muted-foreground">{formatTime(log.createdAt)}</span></div><p className="mt-1 text-muted-foreground">{log.entityType} / {log.entityId} · {log.actor}</p></article>)}{!loading && !logs.length && <EmptyState text="暂无运行日志" />}</div>}

          {view !== 'new' && view !== 'logs' && drafts.length > 0 && <div className="mb-4 flex gap-2 overflow-x-auto pb-1" aria-label="审核队列">
            {drafts.map((draft, index) => <QueuePill key={draft.id} active={draft.id === selected?.id} index={String(index + 1).padStart(2, '0')} title={draft.title} onClick={() => setSelectedId(draft.id)} />)}
          </div>}

          {view !== 'new' && view !== 'logs' && selected ? <article className="overflow-hidden rounded-[22px] border border-border bg-card shadow-[0_16px_50px_-32px_rgba(41,37,36,0.35)]">
            <div className="border-b border-border px-4 py-4 sm:px-6">
              <div className="flex flex-wrap items-center gap-2"><Badge className="bg-amber-100 text-amber-950 hover:bg-amber-100">{VIEW_LABELS[view]}</Badge><Badge variant="outline">{selected.category}</Badge><span className="ml-auto text-xs text-muted-foreground">{formatTime(selected.createdAt)} 生成</span></div>
              <h2 className="mt-3 text-lg font-semibold leading-snug sm:text-xl">{selected.title}</h2>
              <div className="mt-3 flex w-full items-center gap-3 rounded-xl bg-muted/70 px-3 py-2.5 text-left">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#3370ff]/10 text-[#3370ff]"><FileText className="size-4" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">来源：{selected.sourceLabel}</span><span className="block truncate text-xs text-muted-foreground">合并 {selected.sourceMessageIds.length} 条消息 · {selected.reviewFlags.length ? `已脱敏 ${selected.reviewFlags.length} 项` : '未检出敏感信息'}</span></span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </div>
            </div>
            <div className="px-4 py-5 sm:px-6">
              <div className="mb-2 flex items-center justify-between"><label className="text-sm font-medium" htmlFor="draft">雪球动态草稿</label><span className="text-xs tabular-nums text-muted-foreground">{selected.body.length} 字</span></div>
              <Textarea id="draft" value={selected.body} onChange={(event) => setDrafts((items) => items.map((item) => item.id === selected.id ? { ...item, body: event.target.value } : item))} onBlur={() => void savePatch({ body: selected.body })} className="min-h-64 resize-none rounded-xl border-border bg-background p-4 text-[15px] leading-7 shadow-inner sm:min-h-56" />
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"><ShieldCheck className="size-4 shrink-0" />{selected.metadata?.organizationMode === 'ai' ? 'AI 整理完成，发布前请核验事实' : '规则模式整理，未调用 AI；发布前请核对数字与来源'}</div>
              {selected.metadata && <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
                <details className="rounded-xl border border-border bg-muted/30 p-3 sm:col-span-3"><summary className="cursor-pointer font-medium">原文对照（已脱敏）</summary><p className="mt-2 whitespace-pre-wrap leading-5 text-muted-foreground">{selected.metadata.originalText || '暂无原文记录'}</p></details>
                <div className="rounded-xl border border-border p-3"><p className="font-medium">重要信息提炼</p><ul className="mt-2 space-y-1 text-muted-foreground">{(selected.metadata.keyPoints ?? []).map((point) => <li key={point}>• {point}</li>)}</ul></div>
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 sm:col-span-2"><p className="font-medium text-amber-950">财经事实核验标记</p><ul className="mt-2 space-y-1 text-amber-900">{(selected.metadata.factCheckFlags ?? ['待人工核验']).map((flag) => <li key={flag}>• {flag}</li>)}</ul></div>
              </div>}
            </div>
            <div className="hidden border-t border-border bg-muted/30 px-6 py-4 sm:flex sm:items-center sm:justify-between">
              {view === 'pending' ? <Button variant="ghost" onClick={() => void savePatch({ status: 'skipped' })}>暂不处理</Button> : <span />}
              <div className="flex gap-2"><Button variant="outline" onClick={() => void regenerate()}><RefreshCw />重新生成</Button><Button variant="outline" onClick={() => void copyDraft()}><Clipboard />复制内容</Button>{view === 'copied' ? <Button onClick={() => void savePatch({ status: 'published' })}><CheckCircle2 />标记已发布</Button> : view === 'pending' ? <Button onClick={() => void copyDraft(true)} className="bg-[#e6b10e] text-[#241c05] hover:bg-[#d3a20d]">复制并打开雪球<ExternalLink /></Button> : null}</div>
            </div>
          </article> : view !== 'new' && view !== 'logs' && !loading && <div className="rounded-[22px] border border-dashed border-border bg-card px-6 py-16 text-center">
            <CheckCircle2 className="mx-auto size-10 text-emerald-700" /><h2 className="mt-4 text-lg font-semibold">审核队列已清空</h2><p className="mt-1 text-sm text-muted-foreground">新消息通过筛选后会出现在这里</p>
            {status?.mode === 'simulation' && <Button className="mt-5" onClick={() => void createDemoDraft()}><Sparkles />生成演示草稿</Button>}
          </div>}
          <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">助手只生成草稿，不会代替你发布或保存雪球账号凭证</p>
          <p className="mt-2 text-right text-[10px] tabular-nums text-muted-foreground/70" data-testid="build-version">构建版本：{BUILD_ID}</p>
        </section>
      </div>

      {selected && view !== 'published' && <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl sm:hidden">
        <div className="mx-auto flex max-w-md gap-2"><Button variant="outline" size="lg" className="h-12 flex-1" onClick={() => void copyDraft()}><Clipboard />复制</Button>{view === 'copied' ? <Button size="lg" className="h-12 flex-[1.8]" onClick={() => void savePatch({ status: 'published' })}><CheckCircle2 />标记已发布</Button> : <Button size="lg" className="h-12 flex-[1.8] bg-[#e6b10e] text-[#241c05] hover:bg-[#d3a20d]" onClick={() => void copyDraft(true)}>复制并打开雪球<ExternalLink /></Button>}</div>
      </div>}
    </main>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span>{label}</span><span className="font-medium text-foreground">{value}</span></div>;
}

function QueuePill({ active, index, title, onClick }: { active: boolean; index: string; title: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex max-w-56 min-w-fit items-center gap-2 rounded-full border px-3 py-2 text-sm transition ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}><span className="font-mono text-[10px] opacity-70">{index}</span><span className="truncate">{title}</span></button>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">{text}</div>;
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);
}

function connectionLabel(state?: string) {
  return ({ connected: '已连接', waiting_for_binding: '已连接', starting: '启动中', reconnecting: '重连中', disconnected: '未连接', error: '错误', disabled: '未配置' } as Record<string, string>)[state || 'disabled'] || '未连接';
}

function bindingLabel(state?: NonNullable<SystemStatus['binding']>['status']) {
  return ({ bound: '已绑定', pending: '等待确认', unbound: '等待绑定' } as Record<string, string>)[state || 'unbound'] || '等待绑定';
}

function CollectorBindingPanel({ binding, onAction, onUnbind }: { binding?: SystemStatus['binding']; onAction: (action: 'bind' | 'ignore', candidate?: { chatId: string; chatName: string }) => Promise<void>; onUnbind: () => Promise<void> }) {
  if (!binding) return null;
  const id = binding.status === 'pending' ? binding.pendingChatId : binding.boundChatId;
  const name = binding.status === 'pending' ? binding.pendingChatName : binding.boundChatName;
  return <section className="mb-5 rounded-2xl border border-[#3370ff]/20 bg-[#3370ff]/[0.04] p-4 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold">飞书采集群绑定</p><p className="mt-1 text-xs text-muted-foreground">仅本机所有者可操作；群 ID 只在本地审核页显示，不写入网页日志。</p></div><Badge variant="outline">{binding.status === 'bound' ? '已绑定' : binding.status === 'pending' ? '发现待确认' : '等待首次消息'}</Badge></div>
    {binding.status === 'pending' && <div className="mt-4 rounded-xl border border-border bg-card p-3 text-sm"><p className="font-medium">发现群：{name || '未命名群'}</p><p className="mt-1 break-all text-xs text-muted-foreground">群 ID（仅本地显示）：{id}</p><p className="mt-1 text-xs text-muted-foreground">消息 ID：{binding.pendingMessageId || '未知'} · 请确认这是你创建并可控的财经采集群。</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => void onAction('bind', { chatId: id || '', chatName: name || '' })}>绑定为财经采集群</Button><Button size="sm" variant="outline" onClick={() => void onAction('ignore')}>忽略</Button></div></div>}
    {binding.status === 'bound' && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm"><div><p className="font-medium text-emerald-950">当前采集群：{name || '未命名群'}</p><p className="mt-1 break-all text-xs text-emerald-900/70">群 ID（仅本地显示）：{id}</p></div><Button size="sm" variant="outline" onClick={() => void onUnbind()}>解除绑定 / 重新绑定</Button></div>}
    {binding.status === 'unbound' && <p className="mt-3 text-sm text-muted-foreground">等待首次绑定：请让机器人在目标群收到一条消息，页面会显示群名和群 ID，再由你确认绑定。</p>}
  </section>;
}

