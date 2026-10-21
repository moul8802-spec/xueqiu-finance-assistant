#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, sqlite3, sys, threading, time, urllib.request, urllib.parse, webbrowser, hashlib, html
import xml.etree.ElementTree as ET
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR=Path(sys.executable).resolve().parent if getattr(sys,"frozen",False) else Path(__file__).resolve().parent
BASE=Path(os.getenv("LOCALAPPDATA",APP_DIR))/("雪球财经助手") if getattr(sys,"frozen",False) else APP_DIR/"data"
DB=BASE/"assistant.db"; FEEDS=BASE/"feeds.json"
DEFAULT=[
 {"name":"A股市场","url":"https://news.google.com/rss/search?q="+urllib.parse.quote("A股 OR 沪深300 OR 创业板 when:1d")+"&hl=zh-CN&gl=CN&ceid=CN:zh-Hans","enabled":True},
 {"name":"科技产业","url":"https://news.google.com/rss/search?q="+urllib.parse.quote("半导体 OR 光模块 OR 算力 OR 芯片 when:1d")+"&hl=zh-CN&gl=CN&ceid=CN:zh-Hans","enabled":True},
 {"name":"政策监管","url":"https://news.google.com/rss/search?q="+urllib.parse.quote("证监会 OR 上交所 OR 深交所 OR 央行 when:1d")+"&hl=zh-CN&gl=CN&ceid=CN:zh-Hans","enabled":True}
]
TERMS=("A股","上证","深证","创业板","科创板","沪深","港股","半导体","光模块","算力","芯片","机器人","证监会","央行","交易所","回购","减持","增持","解禁","定增","IPO","基金","美联储","科技","证券","业绩","分红")

def db():
    BASE.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(DB,timeout=15); c.row_factory=sqlite3.Row
    c.execute("PRAGMA busy_timeout=15000")
    return c

def init():
    BASE.mkdir(parents=True,exist_ok=True)
    if not FEEDS.exists(): FEEDS.write_text(json.dumps(DEFAULT,ensure_ascii=False,indent=2),encoding="utf-8")
    c=db(); c.executescript("""
    CREATE TABLE IF NOT EXISTS items(
      id INTEGER PRIMARY KEY AUTOINCREMENT,fingerprint TEXT UNIQUE,title TEXT,brief TEXT,url TEXT,source TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,status TEXT DEFAULT 'draft',draft TEXT,category TEXT,risk TEXT DEFAULT '待核验');
    CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT DEFAULT CURRENT_TIMESTAMP,source TEXT,result TEXT,added INTEGER DEFAULT 0);
    """); c.commit(); c.close()

def clean(s):
    return re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]+>"," ",s or ""))).strip()[:3000]

def category(t):
    for n,ks in [("政策监管",("证监会","交易所","政策","央行")),("资金筹码",("减持","增持","回购","解禁","定增","融资","两融","成交量")),("科技产业",("AI","算力","光模块","芯片","存储","半导体","机器人")),("公司公告",("业绩","利润","营收","分红","公告","IPO"))]:
        if any(k.lower() in t.lower() for k in ks): return n
    return "市场动态"

def rewrite(title,brief,url):
    title=re.sub(r"\s+-\s+[^-]{1,40}$","",title).strip()
    b=clean(brief)
    p=f"【{category(title+' '+b)}】{title}\n\n"
    if b and b not in title: p+=f"消息线索：{b[:180]}\n\n"
    p+="这条消息先别急着下结论。真正需要看的是原始出处、发生时间、关键数字，以及它到底影响哪一类资金和公司。标题能提供线索，但不能替代核实。\n\n"
    p+="【发布前核验】请确认原始来源、时间、关键数字与转载许可。"
    if url: p+=f"\n来源链接：{url}"
    return p[:2500]

def parse(raw):
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper(): raise ValueError("不安全XML")
    root=ET.fromstring(raw); out=[]
    items=root.findall("./channel/item")
    if items:
        for n in items[:40]:
            def tx(tag):
                q=n.find(tag); return "".join(q.itertext()).strip() if q is not None else ""
            out.append({"title":clean(tx("title"))[:260],"brief":clean(tx("description"))[:900],"url":tx("link")[:1500]})
    else:
        ns="{http://www.w3.org/2005/Atom}"
        for n in root.findall(ns+"entry")[:40]:
            def tx(tag):
                q=n.find(ns+tag); return "".join(q.itertext()).strip() if q is not None else ""
            link=""
            for q in n.findall(ns+"link"):
                if q.attrib.get("href"): link=q.attrib["href"]; break
            out.append({"title":clean(tx("title"))[:260],"brief":clean(tx("summary") or tx("content"))[:900],"url":link[:1500]})
    return [x for x in out if x["title"]]

def fetch(url):
    u=urllib.parse.urlparse(url)
    if u.scheme!="https" or not u.hostname: raise ValueError("仅支持HTTPS RSS")
    req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 FinancialRSS/1.2","Accept":"application/rss+xml,application/xml,text/xml"})
    with urllib.request.urlopen(req,timeout=18) as r:
        raw=r.read(2_000_001)
    if len(raw)>2_000_000: raise ValueError("响应过大")
    return raw

def feeds():
    try:return json.loads(FEEDS.read_text(encoding="utf-8"))
    except:return []

def poll():
    results=[]
    for f in feeds():
        if not f.get("enabled"): continue
        added=dup=skip=0
        try:
            rows=parse(fetch(f["url"]))
            c=db()
            for x in rows:
                text=x["title"]+" "+x["brief"]
                if not any(k.lower() in text.lower() for k in TERMS): skip+=1; continue
                fp=hashlib.sha256(re.sub(r"\W","",x["title"].lower()).encode()).hexdigest()
                try:
                    c.execute("INSERT INTO items(fingerprint,title,brief,url,source,draft,category) VALUES(?,?,?,?,?,?,?)",
                              (fp,x["title"],x["brief"],x["url"],f["name"],rewrite(x["title"],x["brief"],x["url"]),category(text)))
                    added+=1
                    if added>=10: break
                except sqlite3.IntegrityError: dup+=1
            c.execute("INSERT INTO runs(source,result,added) VALUES(?,?,?)",(f["name"],"成功",added)); c.commit(); c.close()
            results.append({"source":f["name"],"ok":True,"added":added,"duplicate":dup,"skipped":skip})
        except Exception as e:
            c=db(); c.execute("INSERT INTO runs(source,result,added) VALUES(?,?,0)",(f["name"],type(e).__name__+": "+str(e)[:120])); c.commit(); c.close()
            results.append({"source":f["name"],"ok":False,"error":type(e).__name__+": "+str(e)[:160]})
    return results

PAGE=r'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>雪球财经助手 · 自动采集版</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f1;color:#213128;font:14px "Microsoft YaHei",sans-serif}.wrap{display:grid;grid-template-columns:230px 1fr;min-height:100vh}.side{background:#173328;color:#eaf2ed;padding:26px 18px}.brand{font-size:20px;font-weight:800;margin-bottom:8px}.ver{font-size:11px;color:#9cb4a7;margin-bottom:30px}.side button{width:100%;text-align:left;border:0;border-radius:10px;padding:13px;margin:4px 0;background:transparent;color:#d9e6dd}.side button.on{background:#e3ce98;color:#173328;font-weight:700}.main{padding:35px 45px}.head{display:flex;justify-content:space-between;align-items:center;gap:20px}.head h1{margin:0 0 8px;font-size:30px}.muted{color:#85928a}.primary{background:#315b47;color:white;border:0;border-radius:9px;padding:12px 17px;font-weight:700}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}.card{background:white;border:1px solid #e0e5e0;border-radius:14px;padding:20px}.card b{display:block;font-size:27px;margin-top:8px}.panel{background:white;border:1px solid #e0e5e0;border-radius:14px;padding:22px}.item{padding:18px 0;border-bottom:1px solid #edf0ec}.item h3{margin:8px 0}.chips span{background:#eef4ef;border-radius:6px;padding:4px 8px;font-size:11px;margin-right:6px}.draft{color:#657169;line-height:1.7;white-space:pre-wrap;max-width:900px}.meta{font-size:11px;color:#8d9991;margin-top:10px}.meta a{color:#38735b}.actions{margin-top:10px;display:flex;gap:8px}.secondary{border:1px solid #d6ddd8;background:white;border-radius:8px;padding:8px 12px}.hidden{display:none}.source{padding:14px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;gap:15px}.source small{display:block;color:#89948d;word-break:break-all;margin-top:5px}.empty{text-align:center;padding:70px;color:#87958b}@media(max-width:800px){.wrap{grid-template-columns:1fr}.side{display:none}.main{padding:20px}.cards{grid-template-columns:repeat(2,1fr)}}
</style>
<div class="wrap"><aside class="side"><div class="brand">雪球财经助手</div><div class="ver">WINDOWS · RSS AUTO v1.2</div>
<button class="on" data-tab="queue">▣ 待审核</button><button data-tab="sources">◈ 自动采集源</button><button data-tab="logs">◷ 运行记录</button></aside>
<main class="main"><div class="head"><div><h1>自动财经采集</h1><div class="muted">公开 RSS / Atom → 自动筛选 → 去重 → 自动生成待审草稿</div></div><button id="poll" class="primary">↻ 立即采集</button></div>
<div class="cards"><div class="card">已采集<b id="total">0</b></div><div class="card">待审核<b id="draft">0</b></div><div class="card">已审核<b id="reviewed">0</b></div><div class="card">自动频率<b style="font-size:18px">15分钟</b></div></div>
<section id="queue" class="panel"><h2>最新财经线索</h2><div id="items"></div></section>
<section id="sources" class="panel hidden"><h2>自动采集源</h2><p class="muted">程序启动后每15分钟自动检查。这里只使用公开 RSS / Atom。</p><div id="feedlist"></div></section>
<section id="logs" class="panel hidden"><h2>运行记录</h2><div id="runlist"></div></section></main></div>
<script>
const $=x=>document.getElementById(x); async function get(u){let r=await fetch(u);return r.json()} async function post(u,d){let r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json','X-App-Request':'1'},body:JSON.stringify(d||{})});return r.json()}
async function refresh(){let s=await get('/api/status');$('total').textContent=s.total;$('draft').textContent=s.draft;$('reviewed').textContent=s.reviewed;let a=await get('/api/items');$('items').innerHTML=a.items.length?a.items.map(x=>'<div class="item"><div class="chips"><span>'+esc(x.category)+'</span><span>'+esc(x.risk)+'</span></div><h3>'+esc(x.title)+'</h3><div class="draft">'+esc(x.draft)+'</div><div class="meta">'+esc(x.source)+(x.url?' · <a target="_blank" href="'+esc(x.url)+'">查看来源 ↗</a>':'')+'</div><div class="actions"><button class="secondary" onclick="mark('+x.id+',\'reviewed\')">标记已审核</button><button class="secondary" onclick="copyText('+x.id+')">复制草稿</button></div></div>').join(''):'<div class="empty">暂无内容。点击“立即采集”，或等待自动采集。</div>'; let f=await get('/api/feeds');$('feedlist').innerHTML=f.items.map(x=>'<div class="source"><div><b>'+esc(x.name)+'</b><small>'+esc(x.url)+'</small></div><span>'+(x.enabled?'自动采集':'已停用')+'</span></div>').join(''); let rr=await get('/api/runs');$('runlist').innerHTML=rr.items.map(x=>'<div class="source"><div><b>'+esc(x.source)+'</b><small>'+esc(x.at)+'</small></div><span>'+esc(x.result)+' · 新增 '+x.added+'</span></div>').join('')}
function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function mark(id,status){await post('/api/update',{id,status});refresh()} async function copyText(id){let a=await get('/api/items');let x=a.items.find(v=>v.id===id);if(x){await navigator.clipboard.writeText(x.draft);alert('已复制到剪贴板')}}
$('poll').onclick=async()=>{$('poll').disabled=true;$('poll').textContent='采集中…';let r=await post('/api/poll',{});$('poll').disabled=false;$('poll').textContent='↻ 立即采集';alert('完成，新增 '+r.results.reduce((n,x)=>n+(x.added||0),0)+' 条');refresh()}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('on'));b.classList.add('on');document.querySelectorAll('section').forEach(x=>x.classList.add('hidden'));$(b.dataset.tab).classList.remove('hidden')});refresh();setInterval(refresh,30000);
</script>'''

class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def out(self,obj,code=200):
        raw=json.dumps(obj,ensure_ascii=False).encode(); self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(raw))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(raw)
    def do_GET(self):
        p=urllib.parse.urlsplit(self.path).path
        if p=="/":
            raw=PAGE.encode(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if p=="/api/status":
            c=db(); total=c.execute("select count(*) from items").fetchone()[0]; d=c.execute("select count(*) from items where status='draft'").fetchone()[0]; r=c.execute("select count(*) from items where status='reviewed'").fetchone()[0]; c.close(); self.out({"total":total,"draft":d,"reviewed":r}); return
        if p=="/api/items":
            c=db(); rows=[dict(x) for x in c.execute("select * from items order by id desc limit 200")]; c.close(); self.out({"items":rows}); return
        if p=="/api/feeds": self.out({"items":feeds()}); return
        if p=="/api/runs":
            c=db(); rows=[dict(x) for x in c.execute("select * from runs order by id desc limit 50")]; c.close(); self.out({"items":rows}); return
        self.out({"error":"not found"},404)
    def do_POST(self):
        if self.headers.get("X-App-Request")!="1": self.out({"error":"forbidden"},403); return
        try:
            n=int(self.headers.get("Content-Length","0")); obj=json.loads(self.rfile.read(n) or b"{}"); p=urllib.parse.urlsplit(self.path).path
            if p=="/api/poll": self.out({"results":poll()}); return
            if p=="/api/update":
                c=db(); c.execute("update items set status=? where id=?",(str(obj.get("status","draft")),int(obj.get("id",0)))); c.commit(); c.close(); self.out({"ok":True}); return
            self.out({"error":"not found"},404)
        except Exception as e:self.out({"error":str(e)},400)

def loop():
    time.sleep(4)
    while True:
        try: poll()
        except: pass
        time.sleep(900)

def main():
    init(); srv=ThreadingHTTPServer(("127.0.0.1",0),H); port=srv.server_address[1]; threading.Thread(target=loop,daemon=True).start()
    url=f"http://127.0.0.1:{port}"
    if os.getenv("XUEQIU_NO_BROWSER")!="1": threading.Timer(1,lambda:webbrowser.open(url)).start()
    print(url,flush=True); srv.serve_forever()

if __name__=="__main__": main()
