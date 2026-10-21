'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, Check, ExternalLink, Link2, LoaderCircle, MessagesSquare, ShieldAlert, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Chat = {
  chatId: string; name: string; description: string; external: boolean; tenantKey: string | null;
};
type Message = {
  messageId: string; messageType: string; text: string | null; senderId: string | null; createTime: number;
};
type ConnectionStatus = {
  configured: boolean;
  callbackUrl: string | null;
  connected: boolean;
  account: { name: string | null; openId: string | null; tenantKey: string | null } | null;
  grantedScopes: string[];
  requiredScopes: string[];
  missingScopes: string[];
  selectedChat: Chat | null;
  aiConfigured: boolean;
};
type ApiFailure = { error?: string; code?: string | number; details?: unknown };
type Diagnostic = {
  checkedAt: number;
  appToken: { ok: boolean; httpStatus: number; code: string | number; message: string; ttLogId: string | null; expiresIn: number | null };
  minimalOAuthPath: string;
  stopRetry: boolean;
  classification: string;
};

export function FeishuConnectionPanel({ onDraftCreated }: { onDraftCreated: () => Promise<void> }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<{ code: string; reason: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch('/api/feishu/status', { cache: 'no-store' });
    const data = await response.json().catch(() => null) as { status?: ConnectionStatus } & ApiFailure | null;
    if (!response.ok || !data?.status) return setError(apiError(data, 'FEISHU_STATUS_FAILED'));
    setStatus(data.status);
    setSelectedId(data.status.selectedChat?.chatId || '');
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const url = new URL(window.location.href);
      const reason = url.searchParams.get('feishu_error');
      const code = url.searchParams.get('feishu_error_code');
      const ttLogId = url.searchParams.get('feishu_tt_log_id');
      if (reason) setError({ code: code || 'FEISHU_OAUTH_FAILED', reason: `${reason}${ttLogId ? `（ttLogId：${ttLogId}）` : ''}` });
      if (url.searchParams.get('feishu') === 'connected') setNotice('飞书账号已连接，正在检查授权权限');
      if (reason || url.searchParams.has('feishu')) {
        url.searchParams.delete('feishu_error');
        url.searchParams.delete('feishu_error_code');
        url.searchParams.delete('feishu_tt_log_id');
        url.searchParams.delete('feishu');
        window.history.replaceState({}, '', url);
      }
      void loadStatus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadStatus]);

  async function loadChats() {
    setBusy('chats'); setError(null); setNotice('');
    try {
      const response = await fetch('/api/feishu/chats', { cache: 'no-store' });
      const data = await response.json().catch(() => null) as { chats?: Chat[] } & ApiFailure | null;
      if (!response.ok || !data?.chats) return setError(apiError(data, 'FEISHU_CHAT_FAILED'));
      setChats(data.chats);
      if (!selectedId && data.chats[0]) setSelectedId(data.chats[0].chatId);
      setNotice(`已从飞书读取 ${data.chats.length} 个当前账号可见群聊`);
    } finally { setBusy(''); }
  }

  async function chooseChat() {
    if (!selectedId) return;
    setBusy('select'); setError(null); setNotice('');
    try {
      const response = await fetch('/api/feishu/chats', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: selectedId }),
      });
      const data = await response.json().catch(() => null) as { selectedChat?: Chat } & ApiFailure | null;
      if (!response.ok || !data?.selectedChat) return setError(apiError(data, 'CHAT_SELECT_FAILED'));
      setStatus((current) => current ? { ...current, selectedChat: data.selectedChat! } : current);
      setMessages([]);
      setNotice(`已将「${data.selectedChat.name}」加入财经群白名单`);
    } finally { setBusy(''); }
  }

  async function readMessages() {
    setBusy('messages'); setError(null); setNotice('');
    try {
      const response = await fetch('/api/feishu/messages', { cache: 'no-store' });
      const data = await response.json().catch(() => null) as { messages?: Message[]; note?: string | null } & ApiFailure | null;
      if (!response.ok || !data?.messages) return setError(apiError(data, 'FEISHU_MESSAGE_FAILED'));
      setMessages(data.messages);
      setNotice(data.note || `已真实读取最近 ${data.messages.length} 条消息；非文本消息不会伪造为文本`);
    } finally { setBusy(''); }
  }

  async function organize() {
    setBusy('organize'); setError(null); setNotice('');
    try {
      const response = await fetch('/api/feishu/organize', { method: 'POST' });
      const data = await response.json().catch(() => null) as { result?: { outcome?: string; selectedCount?: number; duplicateCount?: number } } & ApiFailure | null;
      if (!response.ok || !data?.result) return setError(apiError(data, 'AI_ORGANIZE_FAILED'));
      if (data.result.outcome === 'created') {
        setNotice(`AI 已整理 ${data.result.selectedCount || 0} 条消息并送入人工审核队列`);
        await onDraftCreated();
      } else if (data.result.outcome === 'filtered') {
        setNotice('最近消息中没有符合要求的财经信息，未生成草稿');
      } else {
        setNotice(`没有新消息可整理；已跳过 ${data.result.duplicateCount || 0} 条重复内容`);
      }
    } finally { setBusy(''); }
  }

  async function runDiagnostic() {
    setBusy('diagnostic'); setError(null); setNotice('');
    try {
      const response = await fetch('/api/feishu/diagnostics', { method: 'POST' });
      const data = await response.json().catch(() => null) as { diagnostic?: Diagnostic } & ApiFailure | null;
      if (!response.ok || !data?.diagnostic) return setError(apiError(data, 'FEISHU_DIAGNOSTIC_FAILED'));
      setDiagnostic(data.diagnostic);
      setNotice(data.diagnostic.appToken.ok
        ? '应用身份令牌申请成功；可继续用最小权限授权判断是否为账号安全策略限制'
        : '应用身份令牌申请失败，请先根据错误码检查凭证或应用启用状态');
    } finally { setBusy(''); }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-[22px] border border-[#3370ff]/20 bg-card shadow-[0_16px_50px_-38px_rgba(51,112,255,0.45)]" aria-labelledby="feishu-connect-title">
      <div className="border-b border-border bg-[#3370ff]/[0.045] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-[#3370ff] text-white"><MessagesSquare className="size-4" /></span><h2 id="feishu-connect-title" className="font-semibold">飞书账号与财经群</h2></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">使用你的 user_access_token 读取你有权访问的群聊。App Secret 与令牌不会进入页面。</p>
          </div>
          <Badge variant="outline" className={status?.connected ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : ''}>{status?.connected ? `已连接${status.account?.name ? ` · ${status.account.name}` : ''}` : status?.configured ? '待连接' : '服务端待配置'}</Badge>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4 sm:px-6">
        {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900"><div className="flex items-center gap-2 font-medium"><ShieldAlert className="size-4" />飞书错误码：{error.code}</div><p className="mt-1 break-words text-xs leading-5">原因：{error.reason}</p></div>}
        {notice && <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">{notice}</div>}

        <div className="rounded-xl border border-border bg-muted/35 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-xs font-medium">服务端安全诊断</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">只返回错误码、原因和 ttLogId，不显示 App Secret 或 Token。</p></div>
            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void runDiagnostic()}>{busy === 'diagnostic' ? <LoaderCircle className="animate-spin" /> : <Activity />}测试应用令牌</Button>
          </div>
          {diagnostic && <div className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${diagnostic.appToken.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
            <p className="font-medium">应用令牌：{diagnostic.appToken.ok ? '成功' : '失败'} · HTTP {diagnostic.appToken.httpStatus} · 代码 {diagnostic.appToken.code}</p>
            <p>{diagnostic.appToken.message}</p>
            {diagnostic.appToken.ttLogId && <p className="break-all">ttLogId：{diagnostic.appToken.ttLogId}</p>}
            {diagnostic.appToken.ok && <a className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2')} href={diagnostic.minimalOAuthPath}><ShieldAlert />最小权限 OAuth 测试</a>}
            {diagnostic.stopRetry && <p className="mt-2 font-medium">已确认账号安全策略拒绝，请停止重复部署和重新授权。</p>}
          </div>}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">1. 用户身份授权</p>
            {/* OAuth start is an API redirect, not an app page. */}
            {/* oxlint-disable-next-line next/no-html-link-for-pages */}
            <a href="/api/feishu/oauth/start" className={cn(buttonVariants({ size: 'lg' }), 'mt-3 w-full')}><Link2 />连接我的飞书账号</a>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">2. 群白名单</p>
            <Button type="button" size="lg" variant="outline" className="mt-3 w-full" disabled={!status?.connected || Boolean(busy)} onClick={() => void loadChats()}>{busy === 'chats' ? <LoaderCircle className="animate-spin" /> : <MessagesSquare />}选择财经群</Button>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">3. 真实消息读取</p>
            <Button type="button" size="lg" variant="outline" className="mt-3 w-full" disabled={!status?.selectedChat || Boolean(busy)} onClick={() => void readMessages()}>{busy === 'messages' ? <LoaderCircle className="animate-spin" /> : <ExternalLink />}读取最近10条消息</Button>
          </div>
        </div>

        {status?.connected && <div className="rounded-xl bg-muted/60 p-3">
          <p className="mb-2 text-xs font-medium">用户授权权限检查</p>
          <div className="flex flex-wrap gap-2">{status.requiredScopes.map((scope) => {
            const granted = status.grantedScopes.includes(scope);
            return <Badge key={scope} variant="outline" className={granted ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-800'}>{granted ? <Check /> : <ShieldAlert />}{scope}</Badge>;
          })}</div>
        </div>}

        {chats.length > 0 && <div className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-xs font-medium">当前账号可见群聊
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
              {chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name}{chat.external ? '（跨组织/外部群）' : ''}</option>)}
            </select>
          </label>
          <Button type="button" className="h-10" disabled={!selectedId || Boolean(busy)} onClick={() => void chooseChat()}>{busy === 'select' ? <LoaderCircle className="animate-spin" /> : <Check />}保存为白名单</Button>
        </div>}

        {status?.selectedChat && <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">当前财经群：</span><Badge>{status.selectedChat.name}</Badge>{status.selectedChat.external && <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">跨组织限制以飞书实际返回为准</Badge>}</div>}

        {messages.length > 0 && <div>
          <div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium">飞书实际返回的最近消息</p><Button type="button" disabled={Boolean(busy) || !status?.aiConfigured} onClick={() => void organize()}>{busy === 'organize' ? <LoaderCircle className="animate-spin" /> : <Sparkles />}AI整理到审核队列</Button></div>
          {!status?.aiConfigured && <p className="mb-2 text-xs text-amber-800">AI 服务端密钥/模型未配置，因此不会伪造 AI 整理成功。</p>}
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border bg-muted/30 p-2">{messages.map((message) => <div key={message.messageId} className="rounded-lg bg-card px-3 py-2 text-xs shadow-sm"><div className="flex justify-between gap-2 text-[11px] text-muted-foreground"><span>{message.messageType}</span><span>{formatMessageTime(message.createTime)}</span></div><p className="mt-1 whitespace-pre-wrap break-words leading-5">{message.text || '非文本消息（未伪造内容）'}</p></div>)}</div>
        </div>}

        <div className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground"><Bot className="mt-0.5 size-3.5 shrink-0" />站点仍由 ChatGPT 登录保护，默认仅所有者可访问；雪球发布继续由你复制后手工确认。</div>
      </div>
    </section>
  );
}

function apiError(data: ApiFailure | null, fallbackCode: string) {
  return { code: String(data?.code || fallbackCode), reason: data?.error || '请求失败，请查看服务端配置或飞书返回原因' };
}

function formatMessageTime(value: number) {
  if (!value) return '时间未知';
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(milliseconds);
}
