'use client';

import { useEffect, useMemo, useState } from 'react';
import { ClipboardPaste, FileInput, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type ImportResult = {
  outcome: 'created' | 'filtered' | 'no_new_messages';
  inputCount: number;
  acceptedCount?: number;
  selectedCount: number;
  duplicateCount: number;
  redactedCount?: number;
  organizationMode: 'ai' | 'rules' | 'none';
};

type ApiFailure = { error?: string; code?: string | number };

export function ManualImportPanel({ onDraftCreated }: { onDraftCreated: () => Promise<void> }) {
  const [sourceLabel, setSourceLabel] = useState(() => {
    if (typeof window === 'undefined') return 'iPhone 飞书消息导入';
    return new URL(window.location.href).searchParams.get('source') === 'ios-share' ? 'iPhone 分享导入' : 'iPhone 飞书消息导入';
  });
  const [text, setText] = useState(() => {
    if (typeof window === 'undefined') return '';
    const params = new URL(window.location.href).searchParams;
    return [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join('\n');
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const messageCount = useMemo(() => splitPreview(text).length, [text]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const hasShareParams = ['title', 'text', 'url', 'source'].some((key) => url.searchParams.has(key));
    if (!hasShareParams) return;
    for (const key of ['title', 'text', 'url', 'source']) url.searchParams.delete(key);
    window.history.replaceState({}, '', url);
  }, []);

  async function pasteFromClipboard() {
    setError(''); setNotice('');
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) return setError('剪贴板中没有可导入的文本');
      setText(value);
      setNotice('已从剪贴板读取文本，请检查来源和分条结果');
    } catch {
      setError('浏览器未允许读取剪贴板，请长按输入框后选择“粘贴”');
    }
  }

  async function importMessages() {
    if (!text.trim()) return setError('请先粘贴消息文本');
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceLabel, text }),
      });
      const data = await response.json().catch(() => null) as { result?: ImportResult } & ApiFailure | null;
      if (!response.ok || !data?.result) {
        return setError(`${data?.code ? `${data.code}：` : ''}${data?.error || '消息导入失败'}`);
      }
      const result = data.result;
      if (result.outcome === 'created') {
        const mode = result.organizationMode === 'ai' ? 'AI' : '安全规则';
        setNotice(`已导入 ${result.inputCount} 条，去重 ${result.duplicateCount} 条，${mode}整理 ${result.selectedCount} 条并进入审核队列`);
        setText('');
        await onDraftCreated();
      } else if (result.outcome === 'filtered') {
        setNotice(`已检查 ${result.inputCount} 条，没有符合要求的财经信息；去重 ${result.duplicateCount} 条`);
      } else {
        setNotice(`没有新消息可导入；已跳过 ${result.duplicateCount} 条重复内容`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-[22px] border border-amber-300/60 bg-card shadow-[0_16px_50px_-38px_rgba(180,130,30,0.4)]" aria-labelledby="manual-import-title">
      <div className="border-b border-border bg-amber-50/70 px-4 py-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-amber-500 text-white"><FileInput className="size-4" /></span><h2 id="manual-import-title" className="font-semibold">飞书消息导入</h2></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">OAuth 暂不可用时，在 iPhone 复制群消息后粘贴到这里。每个非空行按一条消息处理。</p>
          </div>
          <span className="shrink-0 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-900">备用入口</span>
        </div>
      </div>

      <div className="space-y-3 px-4 py-4 sm:px-6">
        {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-900">{error}</div>}
        {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900">{notice}</div>}
        <label htmlFor="manual-import-source" className="block text-xs font-medium">来源记录
          <Input id="manual-import-source" value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} maxLength={80} className="mt-1.5" placeholder="例如：飞书群「财经早报」" />
        </label>
        <label htmlFor="manual-import-text" className="block text-xs font-medium">消息文本
          <Textarea id="manual-import-text" value={text} onChange={(event) => setText(event.target.value)} className="mt-1.5 min-h-48 resize-y text-[15px] leading-6" placeholder={'粘贴多条消息，每条占一行\n1. 央行今日开展逆回购操作…\n2. 某公司发布业绩公告…'} />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{messageCount} 条非空消息 · 单次最多 50 条</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" />导入后自动去重与脱敏</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" size="lg" variant="outline" onClick={() => void pasteFromClipboard()} disabled={busy}><ClipboardPaste />从剪贴板粘贴</Button>
          <Button type="button" size="lg" onClick={() => void importMessages()} disabled={busy || !text.trim()}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}批量导入并整理</Button>
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">支持安装为 PWA 后从兼容系统的分享菜单导入；iPhone Safari 可直接复制消息并使用上方粘贴按钮。导入内容只进入本站审核队列，不会自动发布到雪球。</p>
      </div>
    </section>
  );
}

function splitPreview(value: string) {
  return value.replace(/\r\n?/g, '\n').split(/\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 51);
}
