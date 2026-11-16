/* 故障溯源 · 纯逻辑（不碰网络和界面，可在 node 里单测） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const uniq = (a) => Array.from(new Set(a));
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------------- 链接归一 ---------------- */
  const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|igshid|ref_src|ref_url|mc_cid|mc_eid|spm|share_id|rdt|cmpid|ref)$/i;
  const HOST_PREFIX = /^(www|m|mobile|old|new|np|amp)\./;

  function normHost(h) {
    h = String(h || '').toLowerCase().replace(HOST_PREFIX, '');
    if (h === 'twitter.com' || h === 'fxtwitter.com' || h === 'vxtwitter.com' || h === 'nitter.net') h = 'x.com';
    return h;
  }
  function hostOf(raw) {
    try { return normHost(new URL(String(raw).trim()).hostname); } catch (e) { return ''; }
  }
  function canonicalUrl(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch (e) { return String(raw || '').trim().toLowerCase(); }
    const host = normHost(u.hostname);
    const path = u.pathname.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
    let m;
    if (host === 'reddit.com' && (m = path.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i))) {
      return 'reddit.com/r/' + m[1].toLowerCase() + '/comments/' + m[2].toLowerCase();
    }
    if (host === 'x.com' && (m = path.match(/^\/[^/]+\/status(?:es)?\/(\d+)/i))) return 'x.com/status/' + m[1];
    if (host === 'github.com' && (m = path.match(/^\/([^/]+)\/([^/]+)\/(issues|pull|discussions)\/(\d+)/i))) {
      return 'github.com/' + m[1].toLowerCase() + '/' + m[2].toLowerCase() + '/' + m[3] + '/' + m[4];
    }
    if (host === 'news.ycombinator.com' && u.searchParams.get('id')) {
      return 'news.ycombinator.com/item?id=' + u.searchParams.get('id');
    }
    const keep = [];
    u.searchParams.forEach((v, k) => {
      if (TRACKING.test(k)) return;
      if (host === 'x.com' && (k === 's' || k === 't')) return;
      keep.push([k, v]);
    });
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const qs = keep.map((kv) => kv[0] + '=' + kv[1]).join('&');
    return host + path + (qs ? '?' + qs : '');
  }

  /* ---------------- 分词与相似度 ---------------- */
  const STOP = new Set(('a an the is are was were be been am to of in on at for and or it its this that these those with ' +
    'my me i you your we our they their he she his her as by from so do does did has have had just any anyone else ' +
    'there here what when why how if then than but about into out up').split(' '));

  function tokens(s) {
    const out = new Set();
    const t = String(s || '').normalize('NFKC').toLowerCase();
    const latin = t.match(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/g) || [];
    for (const w of latin) if (!STOP.has(w)) out.add(w);
    const runs = t.match(/[㐀-鿿぀-ヿ가-힯]+/g) || [];
    for (const run of runs) {
      if (run.length === 1) out.add(run);
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    }
    return out;
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  /* ---------------- 词表 ---------------- */
  const GENERIC = new RegExp(
    '\\b(down|outages?|errors?|issues?|problems?|broken|fail(?:ing|ed|s|ure|ures)?|bugs?|degraded|incidents?|' +
    'unavailable|slow|timeouts?|crash(?:ing|es|ed)?|stuck|blocked|banned|suspended|overloaded|disruption|' +
    'maintenance|removed|deprecated|unable|cannot|limit(?:s|ed)?|hangs?|frozen|glitch(?:es)?)\\b|' +
    'not (?:working|loading|responding)|can[’\']?t|no longer|stopped working|' +
    '故障|崩|挂了|报错|用不了|无法|打不开|异常|宕机|封|限制|失败|错误|卡|不能用|出问题|炸了|抽风|维护|下线|限额|降智', 'i');
  /* 「弱」症状词：几乎所有故障帖都会出现，区分不了是不是同一个问题 */
  const WEAK = /\b(down|outages?|errors?|issues?|problems?|broken|bugs?|fail(?:ing|ed|s|ure|ures)?|unable|cannot)\b|not (?:working|loading|responding)|can[’']?t|故障|报错|错误|出错|用不了|不能用|无法|挂了|崩了|异常/gi;
  const CHANGE = /\b(chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|polic(?:y|ies)|pricing|price|terms|retir(?:e|ed|ing)|sunset|rollout|new limits?)\b|调整|变更|更新|政策|涨价|下架/i;
  const INFRA = /\b(aws|amazon web services|azure|microsoft|google cloud|gcp|cloudflare|fastly|akamai|cdn|dns|internet)\b/i;

  const ZH_EN = [
    [/报错|出错|错误/, 'error'],
    [/用不了|不能用|无法使用|没法用|打不开|进不去|无法访问|连不上/, 'not working'],
    [/挂了|崩了|宕机|炸了|瘫痪/, 'down outage'],
    [/很慢|太慢|变慢|卡顿|很卡|转圈|加载不/, 'slow loading'],
    [/登不上|登录|登陆|验证码/, 'login'],
    [/封号|被封|封禁|停用/, 'account banned suspended'],
    [/限额|额度|限流|用量|上限|限制/, 'usage limit'],
    [/付款|支付|扣费|订阅|续费|退款/, 'billing payment'],
    [/闪退|崩溃/, 'crash'],
    [/白屏|空白/, 'blank page'],
    [/超时/, 'timeout'],
    [/上传|附件/, 'upload'],
    [/没反应|不回复|无响应|不出结果/, 'not responding'],
    [/降智|变笨|质量下降/, 'quality degraded'],
    [/消失|不见了|没了|下架|下线/, 'removed missing'],
  ];

  /* ---------------- 已知产品注册表 ----------------
     status 必须是 Statuspage v2 接口能用的地址；拿不准的只给 statusLink（只做跳转）。 */
  const REGISTRY = [
    { names: ['claude', 'anthropic', 'claude code', 'claude.ai'], product: 'Claude', vendor: 'Anthropic', status: 'https://status.claude.com', repos: ['anthropics/claude-code'], hosts: ['anthropic.com', 'claude.com', 'claude.ai'], subs: ['ClaudeAI'] },
    { names: ['chatgpt', 'openai', 'codex', 'sora', 'gpt'], product: 'ChatGPT', vendor: 'OpenAI', status: 'https://status.openai.com', repos: ['openai/codex'], hosts: ['openai.com', 'chatgpt.com'], subs: ['ChatGPT'] },
    { names: ['deepseek'], product: 'DeepSeek', vendor: 'DeepSeek', status: 'https://status.deepseek.com', repos: [], hosts: ['deepseek.com'], subs: ['DeepSeek'] },
    { names: ['gemini', 'ai studio', 'bard'], product: 'Gemini', vendor: 'Google', status: '', statusLink: 'https://aistudio.google.com/status', repos: ['google-gemini/gemini-cli'], hosts: ['blog.google', 'ai.google.dev', 'aistudio.google.com'], subs: ['GeminiAI'] },
    { names: ['cursor'], product: 'Cursor', vendor: 'Anysphere', status: 'https://status.cursor.com', repos: [], hosts: ['cursor.com'], subs: ['cursor'] },
    { names: ['copilot', 'github'], product: 'GitHub', vendor: 'GitHub', status: 'https://www.githubstatus.com', repos: [], hosts: ['github.blog', 'githubstatus.com'], subs: ['github'] },
    { names: ['cloudflare'], product: 'Cloudflare', vendor: 'Cloudflare', status: 'https://www.cloudflarestatus.com', repos: [], hosts: ['cloudflare.com', 'cloudflarestatus.com'], subs: ['CloudFlare'] },
    { names: ['discord'], product: 'Discord', vendor: 'Discord', status: 'https://discordstatus.com', repos: [], hosts: ['discordstatus.com'], subs: ['discordapp'] },
    { names: ['reddit'], product: 'Reddit', vendor: 'Reddit', status: 'https://www.redditstatus.com', repos: [], hosts: ['redditstatus.com', 'redditinc.com'], subs: ['help'] },
    { names: ['vercel'], product: 'Vercel', vendor: 'Vercel', status: 'https://www.vercel-status.com', repos: [], hosts: ['vercel.com', 'vercel-status.com'], subs: ['vercel'] },
    { names: ['npm'], product: 'npm', vendor: 'GitHub', status: 'https://status.npmjs.org', repos: [], hosts: ['npmjs.org', 'npmjs.com'], subs: ['node'] },
    { names: ['figma'], product: 'Figma', vendor: 'Figma', status: 'https://status.figma.com', repos: [], hosts: ['figma.com'], subs: ['FigmaDesign'] },
    { names: ['dropbox'], product: 'Dropbox', vendor: 'Dropbox', status: 'https://status.dropbox.com', repos: [], hosts: ['dropbox.com'], subs: ['dropbox'] },
    { names: ['digitalocean'], product: 'DigitalOcean', vendor: 'DigitalOcean', status: 'https://status.digitalocean.com', repos: [], hosts: ['digitalocean.com'], subs: ['digital_ocean'] },
    { names: ['epic games', 'fortnite'], product: 'Epic Games', vendor: 'Epic Games', status: 'https://status.epicgames.com', repos: [], hosts: ['epicgames.com'], subs: ['FortNiteBR'] },
  ];

  function nameRe(n) {
    if (/^[\x00-\x7f]+$/.test(n)) return new RegExp('(^|[^a-z0-9])' + escRe(n.toLowerCase()) + '([^a-z0-9]|$)', 'i');
    return new RegExp(escRe(n), 'i');
  }
  function registryFor(text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    for (const e of REGISTRY) for (const n of e.names) if (nameRe(n).test(t)) return e;
    return null;
  }

  /* ---------------- 拆解描述 ---------------- */
  function extractErrors(desc) {
    const s = String(desc || '');
    const out = [];
    let m;
    const quoted = /[「『“"'`]([^「」『』“”"'`\n]{3,80})[」』”"'`]/g;
    while ((m = quoted.exec(s))) if (/[A-Za-z0-9]/.test(m[1])) out.push(m[1].trim());
    const ident = /[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g;
    while ((m = ident.exec(s))) out.push(m[0]);
    const code = /(?:error|err|code|错误码?|状态码|http)\s*[:：#]?\s*(\d{3,5})(?!\d)/gi;
    while ((m = code.exec(s))) out.push(m[1]);
    return uniq(out).slice(0, 3);
  }

  function splitList(v) {
    return String(v || '').split(/[,，、;；\n]+/).map((x) => x.trim()).filter(Boolean);
  }
  function validHttp(u) {
    try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.origin + x.pathname.replace(/\/+$/, '') : ''; } catch (e) { return ''; }
  }

  function normalizeParsed(o, desc, manual) {
    o = o || {}; manual = manual || {};
    const arr = (v, n) => uniq((Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []))
      .map((x) => String(x == null ? '' : x).trim()).filter(Boolean)).slice(0, n);
    const aliasesIn = arr(o.aliases, 8);
    const reg = registryFor(manual.product) || registryFor(o.product) || registryFor(aliasesIn.join(' | ')) ||
      (!manual.product && !o.product ? registryFor(desc) : null);
    const product = String(manual.product || o.product || (reg && reg.product) || '').trim();
    const aliases = uniq(aliasesIn.concat(reg ? reg.names : []))
      .filter((a) => a.toLowerCase() !== product.toLowerCase()).slice(0, 8);
    const status = validHttp(manual.status) || (reg && reg.status) || (reg ? '' : validHttp(o.status_page)) || '';
    const officialHosts = uniq((reg ? reg.hosts : []).concat(status ? [hostOf(status)] : []).filter(Boolean));
    return {
      product,
      vendor: String(o.vendor || (reg && reg.vendor) || '').trim(),
      aliases,
      symptoms_en: uniq(splitList(manual.keywords).concat(arr(o.symptoms_en, 5))).slice(0, 5),
      symptoms_zh: arr(o.symptoms_zh, 3),
      errors: arr(o.errors, 3).filter((e) => e.length >= 3 && e.length <= 80),
      platform: String(o.platform || '').trim(),
      status_page: status,
      status_link: status || (reg && reg.statusLink) || validHttp(o.status_page) || '',
      github_repos: uniq((reg ? reg.repos : []).concat(arr(o.github_repos, 2)))
        .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 2),
      subs: reg && reg.subs ? reg.subs.slice(0, 1) : [],
      officialHosts,
      extra_queries: arr(o.extra_queries, 3).map((q) => q.slice(0, 100)),
    };
  }

  function heuristicParse(desc, manual) {
    manual = manual || {};
    const s = String(desc || '');
    const reg = registryFor(manual.product) || registryFor(s);
    let product = manual.product || (reg && reg.product) || '';
    if (!product) { const m = s.match(/[A-Za-z][A-Za-z0-9.+-]{1,30}/); if (m) product = m[0]; }
    const en = [], zh = [];
    for (const pair of ZH_EN) { const m = s.match(pair[0]); if (m) { en.push(pair[1]); zh.push(m[0]); } }
    const errors = extractErrors(s);
    const skip = new Set([product.toLowerCase()].concat(reg ? reg.names : [], errors.map((e) => e.toLowerCase())));
    const words = (s.match(/[A-Za-z][A-Za-z0-9'-]{2,}/g) || [])
      .filter((w) => !skip.has(w.toLowerCase()) && !STOP.has(w.toLowerCase()) && !errors.some((e) => e.indexOf(w) >= 0));
    return normalizeParsed({ product, symptoms_en: en.concat(uniq(words).slice(0, 2)), symptoms_zh: zh, errors }, s, manual);
  }

  /* ---------------- 查询生成 ---------------- */
  function buildQueries(p, windowHours, now) {
    const day = (h) => new Date(now - h * HOUR).toISOString().slice(0, 10);
    const d = day(windowHours), dw = day(Math.max(windowHours, 168));
    const P = p.product;
    const s1 = p.symptoms_en[0] || 'not working';
    const s2 = p.symptoms_en[1];
    const z1 = p.symptoms_zh[0] || '用不了';
    const e1 = p.errors[0];
    const out = [], seen = new Set();
    const add = (label, core, tail, extra) => {
      tail = tail ? ' ' + tail : '';
      let c = String(core).replace(/\s+/g, ' ').trim();
      const max = 128 - tail.length;
      if (c.length > max) c = c.slice(0, max).trim();
      const q = c + tail;
      if (!c || seen.has(q)) return;
      seen.add(q);
      out.push(Object.assign({ label, q }, extra || {}));
    };
    add('综合', P + ' ' + s1, 'after:' + d);
    add('故障词', P + ' outage down not working', 'after:' + d);
    add('Reddit', P + ' ' + s1, 'site:reddit.com after:' + d);
    add('X', P + ' ' + s1, 'site:x.com OR site:twitter.com after:' + d);
    if (e1) add('报错原文', P + ' "' + e1.replace(/"/g, '') + '"', 'after:' + d);
    if (s2) add('第二症状', P + ' ' + s2, 'after:' + d);
    add('开发者社区', P + ' ' + s1, 'site:github.com OR site:news.ycombinator.com after:' + d);
    add('官方通告', P + ' status incident update', 'after:' + dw);
    add('官方变更', ((p.vendor && p.vendor !== P ? p.vendor + ' ' : '') + P + ' changelog policy change announcement'), 'after:' + dw);
    add('中文', P + ' ' + z1, 'lang:zh after:' + d);
    add('中文社区', P + ' ' + z1, 'site:v2ex.com OR site:linux.do OR site:zhihu.com after:' + d);
    add('上游故障', 'major outage cloudflare aws azure google cloud', 'after:' + d, { upstream: true });
    (p.extra_queries || []).forEach((q, i) => add('补充' + (i + 1), q, 'after:' + d));
    return out;
  }

  function buildDeepLinks(p) {
    const e = encodeURIComponent;
    const q = (p.product + ' ' + (p.symptoms_en[0] || '')).trim();
    const zh = (p.product + ' ' + (p.symptoms_zh[0] || '')).trim();
    const links = [];
    if (p.status_link) links.push({ name: '官方状态页', url: p.status_link.replace(/^http:/, 'https:') });
    links.push({ name: 'Reddit', url: 'https://www.reddit.com/search/?q=' + e(q) + '&sort=new&t=day' });
    (p.subs || []).forEach((s) => links.push({ name: 'r/' + s + ' 最新', url: 'https://www.reddit.com/r/' + e(s) + '/new/' }));
    links.push({ name: 'X', url: 'https://x.com/search?q=' + e(q) + '&f=live' });
    links.push({ name: 'Google 24 小时', url: 'https://www.google.com/search?q=' + e(q) + '&tbs=qdr:d' });
    links.push({ name: 'Downdetector', url: 'https://downdetector.com/search/?q=' + e(p.product) });
    links.push({ name: 'GitHub issues', url: 'https://github.com/search?q=' + e(q + ' is:issue') + '&type=issues&s=created&o=desc' });
    links.push({ name: 'Hacker News', url: 'https://hn.algolia.com/?q=' + e(q) + '&sort=byDate&dateRange=last24h&type=all' });
    links.push({ name: 'linux.do', url: 'https://linux.do/search?q=' + e(zh + ' order:latest') });
    links.push({ name: 'V2EX', url: 'https://www.google.com/search?q=' + e(zh + ' site:v2ex.com') + '&tbs=qdr:w' });
    return links;
  }

  /* ---------------- 来源适配 ---------------- */
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function decodeHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }
  function fromDeepseek(r, q) {
    return {
      src: 'search', title: clip(r.title, 200), url: String(r.url || ''), text: clip(r.summary || r.snippet || '', 600),
      date: r.date || null, rerank: typeof r.rerank_score === 'number' ? r.rerank_score : null,
      authority: typeof r.authority === 'number' ? r.authority : null, site: r.site_name || '',
      via: (q && q.label) || '', upstream: !!(q && q.upstream),
    };
  }
  function fromGithub(i, fromRepo) {
    return {
      src: 'github', title: clip(i.title, 200), url: String(i.html_url || ''), text: clip(i.body || '', 600),
      date: i.created_at || null, comments: i.comments || 0, points: (i.reactions && i.reactions.total_count) || 0,
      fromRepo: !!fromRepo, via: 'GitHub',
    };
  }
  function fromHN(h) {
    return {
      src: 'hn', title: clip(decodeHtml(h.title || h.story_title || ''), 200),
      url: 'https://news.ycombinator.com/item?id=' + h.objectID,
      text: clip(decodeHtml(h.comment_text || h.story_text || ''), 600),
      date: h.created_at || null, comments: h.num_comments || 0, points: h.points || 0, via: 'Hacker News',
    };
  }
  function fmtLocal(ts, offsetMin) {
    const d = new Date(ts + (offsetMin || 0) * 60000);
    return pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function tzLabel(offsetMin) {
    const a = Math.abs(offsetMin);
    return 'UTC' + (offsetMin < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }
  function fromStatuspage(inc, base, offsetMin) {
    const ups = (inc.incident_updates || []).slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const lines = ups.map((u) => '[' + fmtLocal(Date.parse(u.created_at), offsetMin) + ' ' + (u.status || '') + '] ' + clip(u.body, 300));
    const comps = (inc.components || []).map((c) => c.name).filter(Boolean).join('、');
    const head = '影响级别:' + (inc.impact || '?') + ' 当前状态:' + (inc.status || '?') +
      (inc.resolved_at ? ' 解决于:' + fmtLocal(Date.parse(inc.resolved_at), offsetMin) : ' 尚未解决') +
      (comps ? ' 受影响组件:' + comps : '');
    return {
      src: 'status', type: 'official', title: clip(inc.name, 200),
      url: String(inc.id ? base + '/incidents/' + inc.id : (inc.shortlink || base)),
      text: clip(head + ' ' + lines.join(' '), 1200), date: inc.created_at || null,
      resolved: inc.resolved_at || null, impact: inc.impact || '', via: '官方状态页',
    };
  }
  function summarizeStatus(summary) {
    if (!summary || typeof summary !== 'object') return '';
    const overall = summary.status && summary.status.description ? summary.status.description : '';
    const bad = (summary.components || []).filter((c) => c && c.status && c.status !== 'operational' && !c.group)
      .map((c) => c.name + '（' + c.status + '）');
    return (overall ? '总体：' + overall : '') + (bad.length ? '；异常组件：' + bad.slice(0, 8).join('、') : overall ? '；各组件正常' : '');
  }

  /* ---------------- 来源分类 ---------------- */
  const COMMUNITY = ['reddit.com', 'x.com', 'news.ycombinator.com', 'github.com', 'v2ex.com', 'linux.do', 'zhihu.com',
    'tieba.baidu.com', 'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'lobste.rs', 'bsky.app',
    'discord.com', 'weibo.com', 'nodeseek.com', 'hostloc.com', 'threads.net', 'threads.com', 'mastodon.social', 'lemmy.world',
    'douban.com', 'coolapk.com', 'nga.cn', 'steamcommunity.com', 'tildes.net', 'quora.com', 'facebook.com', 'youtube.com', 'bilibili.com', 't.me'];
  /* 聚合站：自动转抄状态页或收集「我也挂了」点击数的站。按域名、路径、标题三种特征识别。 */
  const AGG_HOST = /(status|down|outage|uptime|pulsetic|claudenetwork|visualsentinel|notopening)/i;
  const AGG_PATH = /\/(provider-)?status(\/|$)|\/outages?(\/|$)|\/is-[a-z0-9-]*-down/i;
  const AGG_TITLE = /^is .{1,40} down\b|(outage|status) (tracker|history|map|checker|monitor)|status\s*(&|and)\s*outage|down right now|live (service )?status|current status|is it down/i;
  function pathOf(raw) { try { return new URL(String(raw).trim()).pathname; } catch (e) { return ''; } }

  function hostIn(host, list) { return list.some((h) => host === h || host.endsWith('.' + h)); }
  function classifySource(it, ctx) {
    if (it.src === 'status') return 'official';
    const host = hostOf(it.url);
    if (ctx && ctx.officialHosts && hostIn(host, ctx.officialHosts)) return 'official';
    // 注册表里没有的产品：status.<厂商域名> 这种写法按官方状态页处理
    if (ctx && /^status\./.test(host) && (ctx.names || []).some((n) => host.indexOf(n.toLowerCase().replace(/[^a-z0-9]/g, '')) > 6)) return 'official';
    if (hostIn(host, COMMUNITY) || /^(community|forum|forums|discuss|discourse|bbs|ask|answers)\./.test(host)) return 'community';
    if (AGG_HOST.test(host) || AGG_PATH.test(pathOf(it.url)) || AGG_TITLE.test(it.title || '')) return 'aggregator';
    return 'news';
  }

  /* ---------------- 过滤、去重、打分 ---------------- */
  function makeCtx(p, windowHours, now) {
    const names = uniq([p.product].concat(p.aliases || []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2));
    return {
      names, nameRes: names.map(nameRe),
      symptoms: (p.symptoms_en || []).concat(p.symptoms_zh || [])
        .map((s) => ({ set: tokens(s), weak: tokens(String(s).replace(WEAK, ' ')).size === 0 })).filter((s) => s.set.size),
      errorRes: (p.errors || []).map((e) => /^[\x00-\x7f]+$/.test(e) ? new RegExp('(^|[^a-z0-9_])' + escRe(e) + '([^a-z0-9_]|$)', 'i') : new RegExp(escRe(e), 'i')),
      officialHosts: p.officialHosts || [], windowMs: windowHours * HOUR, now, cap: 40, hostCap: 12,
    };
  }

  const REASON = {
    dup: '同一链接', old: '超出时间范围', noproduct: '没提到这个产品', nosymptom: '没提到故障或症状',
    reponoise: '仓库里的普通 issue，没对上你说的症状', hostcap: '同一网站已留够 12 条',
    aggregator: '聚合站（只留 2 条当热度信号）', upcap: '上游事件（只留 3 条）', cap: '相关度靠后，超出上限',
    irrelevant: '语义筛选：和你说的不是一回事', restate: '语义筛选：转述同一来源',
  };
  const TYPE_W = { official: 2.5, community: 1, news: 0.5, aggregator: -1, upstream: 0 };

  function applyFilters(raw, ctx) {
    const excluded = [];
    const stats = { total: raw.length };
    const drop = (it, reason) => { it.reason = reason; excluded.push(it); };

    // 1 同一链接合并
    const byCanon = new Map();
    for (const r of raw) {
      if (!r || !r.url || !r.title) continue;
      const it = Object.assign({}, r);
      it.canon = canonicalUrl(it.url);
      it.host = hostOf(it.url);
      const prev = byCanon.get(it.canon);
      if (!prev) { it.vias = it.via ? [it.via] : []; byCanon.set(it.canon, it); continue; }
      const better = (!prev.date && it.date) || (!!prev.date === !!it.date && (it.text || '').length > (prev.text || '').length);
      const win = better ? it : prev, lose = better ? prev : it;
      win.vias = uniq((prev.vias || []).concat(it.via ? [it.via] : []));
      win.comments = Math.max(prev.comments || 0, it.comments || 0);
      win.points = Math.max(prev.points || 0, it.points || 0);
      win.rerank = Math.max(prev.rerank == null ? -1 : prev.rerank, it.rerank == null ? -1 : it.rerank);
      if (win.rerank < 0) win.rerank = null;
      win.upstream = prev.upstream && it.upstream;
      win.fromRepo = prev.fromRepo || it.fromRepo;
      byCanon.set(it.canon, win);
      drop(lose, 'dup');
    }

    // 2 时间、相关性、打分
    const pass = [];
    for (const it of byCanon.values()) {
      const title = it.title || '', body = title + ' ' + (it.text || '');
      const exempt = it.src === 'status' || it.fromRepo;
      const inTitle = ctx.nameRes.some((re) => re.test(title));
      const inBody = inTitle || ctx.nameRes.some((re) => re.test(body));
      const productHit = exempt || inBody;
      it.type = it.upstream && !inBody ? 'upstream' : (it.type && it.type !== 'upstream' ? it.type : classifySource(it, ctx));

      let ts = it.date ? Date.parse(it.date) : NaN;
      if (!isNaN(ts) && ts > ctx.now + DAY) ts = NaN;
      it.ts = isNaN(ts) ? null : ts;
      it.undated = it.ts == null;
      const limit = it.type === 'official' ? Math.max(ctx.windowMs, 7 * DAY) : ctx.windowMs;
      if (it.ts != null && ctx.now - it.ts > limit) { drop(it, 'old'); continue; }

      const generic = GENERIC.test(body);
      if (it.type === 'upstream') {
        if (!(INFRA.test(body) && generic)) { drop(it, 'noproduct'); continue; }
      } else if (!productHit) { drop(it, 'noproduct'); continue; }

      it.tt = tokens(title);
      it.bt = tokens(body);
      let specific = 0, weak = 0;
      for (const sym of ctx.symptoms) {
        let hit = 0;
        for (const t of sym.set) if (it.bt.has(t)) hit++;
        if (hit / sym.set.size >= 0.6) { if (sym.weak) weak++; else specific++; }
      }
      it.errorHit = ctx.errorRes.some((re) => re.test(body));
      const changeWord = it.type === 'official' && CHANGE.test(body);
      if (it.src !== 'status' && it.type !== 'upstream' && !specific && !weak && !generic && !it.errorHit && !changeWord) { drop(it, 'nosymptom'); continue; }
      // 产品自己的 issue 区里每条都带 bug、error 这类词，必须对上具体症状、报错原文，或者跟帖的人很多
      const engaged = (it.comments || 0) + (it.points || 0);
      if (it.fromRepo && !specific && !it.errorHit && engaged < 8) { drop(it, 'reponoise'); continue; }

      let s = TYPE_W[it.type] || 0;
      if (it.type !== 'upstream') s += it.fromRepo ? 1.5 : exempt ? 2 : inTitle ? 3 : 1.5;
      s += Math.min(3, specific * 1.5 + weak * 0.5 + (generic ? 0.5 : 0));
      if (it.errorHit) s += 3;
      s += it.ts != null ? 2 * Math.exp(-(ctx.now - it.ts) / ctx.windowMs) : -0.5;
      s += Math.min(1.5, Math.log10(1 + engaged) * 0.75);
      if (it.rerank != null) s += 0.4 * it.rerank;
      it.score = Math.round(s * 1000) / 1000;
      pass.push(it);
    }
    pass.sort((a, b) => b.score - a.score || (b.ts || 0) - (a.ts || 0));

    // 3 聚合站、上游事件限量
    const main = [], agg = [], up = [];
    for (const it of pass) {
      if (it.type === 'aggregator') { if (agg.length < 2) agg.push(it); else drop(it, 'aggregator'); }
      else if (it.type === 'upstream') { if (up.length < 3) up.push(it); else drop(it, 'upcap'); }
      else main.push(it);
    }

    // 4 相似标题归组（官方条目不参与：不同日期的同名事故必须分开）
    const reps = [], perHost = new Map();
    for (const it of main) {
      it.similar = [];
      let host = null;
      if (it.type !== 'official') {
        for (const rep of reps) {
          if (rep.type !== it.type) continue;
          const same = jaccard(it.tt, rep.tt) >= 0.7 ||
            (it.bt.size >= 8 && rep.bt.size >= 8 && jaccard(it.bt, rep.bt) >= 0.75);
          if (same) { host = rep; break; }
        }
      }
      if (host) { host.similar.push({ title: it.title, url: it.url, host: it.host, date: it.date || null }); continue; }
      const used = perHost.get(it.host) || 0;
      if (it.type !== 'official' && used >= ctx.hostCap) { drop(it, 'hostcap'); continue; }
      perHost.set(it.host, used + 1);
      reps.push(it);
    }
    agg.concat(up).forEach((it) => { it.similar = []; });

    // 5 截断并编号
    const room = Math.max(0, ctx.cap - agg.length - up.length);
    reps.slice(room).forEach((it) => drop(it, 'cap'));
    const kept = reps.slice(0, room).concat(agg, up).sort((a, b) => b.score - a.score || (b.ts || 0) - (a.ts || 0));
    kept.forEach((it, i) => { it.id = i + 1; });
    stats.kept = kept.length;
    stats.similar = kept.reduce((n, it) => n + it.similar.length, 0);
    stats.excluded = excluded.length;
    stats.byReason = excluded.reduce((m, it) => { m[it.reason] = (m[it.reason] || 0) + 1; return m; }, {});
    return { kept, excluded, stats };
  }

  /* ---------------- 模型输出处理 ---------------- */
  function extractJson(text) {
    const s = String(text || '');
    for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { const v = JSON.parse(s.slice(start, i + 1)); if (v && typeof v === 'object') return v; } catch (e) { /* 换下一个起点 */ }
            break;
          }
        }
      }
    }
    return null;
  }

  const CONF = ['low', 'medium', 'high'];
  const VERDICTS = ['widespread', 'official_change', 'likely_local', 'mixed', 'insufficient'];

  function postProcess(report, items) {
    report = report && typeof report === 'object' ? report : {};
    const byId = new Map(items.map((i) => [i.id, i]));
    const lab = new Map();
    for (const l of Array.isArray(report.labels) ? report.labels : []) {
      const id = Number(l && l.id);
      if (!byId.has(id)) continue;
      const dup = l.dup_of == null || l.dup_of === '' ? null : Number(l.dup_of);
      lab.set(id, { rel: String(l.rel || ''), dup_of: byId.has(dup) && dup !== id ? dup : null });
    }
    const rootOf = (id) => {
      const seen = new Set([id]);
      let cur = id;
      for (;;) {
        const l = lab.get(cur);
        if (!l || l.dup_of == null || seen.has(l.dup_of) || byId.get(cur).type === 'official') return cur;
        cur = l.dup_of; seen.add(cur);
      }
    };
    const irrelevant = new Set();
    lab.forEach((l, id) => { if (l.rel === 'irrelevant') irrelevant.add(id); });
    const cleanIds = (arr) => uniq((Array.isArray(arr) ? arr : []).map(Number)
      .filter((id) => byId.has(id) && !irrelevant.has(id)).map(rootOf).filter((id) => !irrelevant.has(id)));
    const weigh = (ids) => {
      let official = false, usable = 0;
      const keys = new Set();
      let extra = 0;
      for (const id of ids) {
        const it = byId.get(id);
        if (it.type === 'aggregator') continue;
        usable++;
        if (it.type === 'official') official = true;
        if (!keys.has(it.canon)) {
          keys.add(it.canon);
          if (it.type === 'community') extra += (it.similar || []).filter((s) => !s.restate).length;
        }
      }
      return { official, usable, n: keys.size + extra };
    };
    const conf = (v) => (CONF.indexOf(v) >= 0 ? v : 'low');
    const txt = (v) => (v == null ? '' : String(v).trim());

    const causes = (Array.isArray(report.causes) ? report.causes : []).slice(0, 5).map((c) => {
      c = c || {};
      const ev = cleanIds(c.evidence);
      const w = weigh(ev);
      let cf = conf(c.confidence), note = '';
      if (!ev.length) { cf = 'low'; note = '无依据'; }
      else if (!w.usable) { cf = 'low'; note = '只有聚合站，不能当依据'; }
      else if (!w.official) {
        if (w.n < 2) { cf = 'low'; note = '单一来源'; }
        else if (w.n < 3 && cf === 'high') cf = 'medium';
      }
      return { title: txt(c.title), type: txt(c.type) || 'unknown', confidence: cf, note, why: txt(c.why), evidence: ev, against: cleanIds(c.against), sources: w.n, official: w.official };
    }).filter((c) => c.title);

    let verdict = VERDICTS.indexOf(report.verdict) >= 0 ? report.verdict : 'insufficient';
    const backed = causes.some((c) => c.evidence.length && c.note !== '只有聚合站，不能当依据');
    if (!backed && verdict !== 'likely_local') verdict = 'insufficient';
    let overall = conf(report.confidence);
    const top = causes.length ? causes[0].confidence : 'low';
    if (CONF.indexOf(overall) > CONF.indexOf(top)) overall = top;

    const sec = (o) => { o = o && typeof o === 'object' ? o : {}; return o; };
    const others = sec(report.others), official = sec(report.official);
    const out = {
      verdict, headline: txt(report.headline), confidence: overall, causes,
      timeline: (Array.isArray(report.timeline) ? report.timeline : []).slice(0, 12)
        .map((t) => ({ time: txt(t && t.time), event: txt(t && t.event), evidence: cleanIds(t && t.evidence) })).filter((t) => t.event),
      others: { summary: txt(others.summary), scale: txt(others.scale), affected: txt(others.affected), evidence: cleanIds(others.evidence) },
      official: { statement: txt(official.statement), matches_reports: txt(official.matches_reports), evidence: cleanIds(official.evidence) },
      actions: (Array.isArray(report.actions) ? report.actions : []).slice(0, 6)
        .map((a) => (typeof a === 'string' ? { do: a, why: '' } : { do: txt(a && a.do), why: txt(a && a.why) })).filter((a) => a.do),
      unknowns: (Array.isArray(report.unknowns) ? report.unknowns : []).map(txt).filter(Boolean).slice(0, 6),
    };

    const moved = [], kept = [];
    for (const it of items) {
      if (irrelevant.has(it.id)) { it.reason = 'irrelevant'; moved.push(it); continue; }
      const r = rootOf(it.id);
      if (r !== it.id && !irrelevant.has(r)) {
        it.reason = 'restate';
        byId.get(r).similar.push({ title: it.title, url: it.url, host: it.host, date: it.date || null, restate: true });
        moved.push(it); continue;
      }
      const l = lab.get(it.id);
      it.rel = l ? l.rel : '';
      kept.push(it);
    }
    return { report: out, kept, moved };
  }

  /* ---------------- 提示词 ---------------- */
  function parseMessages(desc) {
    const sys = [
      '你是故障调查工具里的"拆解"环节。用户会描述某个产品或服务突然出现的问题。请只输出 json，不要输出别的内容。',
      '字段：',
      '{',
      '  "product": "产品的英文常用名，如 Claude",',
      '  "vendor": "厂商英文名，如 Anthropic；不确定填空字符串",',
      '  "aliases": ["其他叫法、域名、子产品，最多 5 个"],',
      '  "symptoms_en": ["英文症状短语 2-4 个，每个 2-4 个词，用户最强调的排最前，用海外用户发帖时会用的说法"],',
      '  "symptoms_zh": ["中文症状短语 1-3 个"],',
      '  "errors": ["用户原文里出现的报错原文或错误码，原样照抄；没有就给空数组"],',
      '  "platform": "涉及的平台或版本，如 iOS app、API、网页；不确定填空",',
      '  "status_page": "官方状态页网址；不确定填空，不要编",',
      '  "github_repos": ["最相关的官方 GitHub 仓库 owner/name，最多 2 个；不确定给空数组，不要编"],',
      '  "extra_queries": ["最多 3 条值得补充的英文搜索词，每条不超过 80 个字符"]',
      '}',
      '规则：不要猜原因；不要把症状写得比用户说的更具体。',
      '示例输入：Cursor 今天更新完之后 tab 补全不出来了，一直转圈',
      '示例 json 输出：{"product":"Cursor","vendor":"Anysphere","aliases":["cursor.com","Cursor IDE"],"symptoms_en":["tab completion not working","autocomplete stuck loading","broken after update"],"symptoms_zh":["补全不出来","一直转圈"],"errors":[],"platform":"桌面端","status_page":"https://status.cursor.com","github_repos":[],"extra_queries":["Cursor tab autocomplete broken latest version"]}',
    ].join('\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: String(desc || '').slice(0, 1500) }];
  }

  const TYPE_ZH = { official: '官方', community: '社区', news: '新闻', aggregator: '聚合站', upstream: '上游事件' };

  function analysisMessages(desc, p, items, statusSummary, now, offsetMin, windowHours) {
    const sys = [
      '你是故障调查分析员。用户描述了一个突然出现的问题。下面是一批已经做过机械去重的证据条目，每条有编号、来源类型、时间、标题、摘要。',
      '请只根据这些条目判断：出了什么事、原因是什么、其他人的情况如何、用户现在能做什么。只输出 json。',
      '',
      '硬性规则：',
      '1. 只能使用给出的条目。每个结论都要在 evidence 里写出依据的条目编号。没有条目支持的内容不能写成结论，放进 unknowns。',
      '2. 先逐条筛选，写进 labels：rel 取 same（和用户说的是同一件事）、related（同一产品但不是同一个问题）、irrelevant（无关）。如果某条只是在转述另一条（同一条官方通告、同一个帖子、同一篇通稿），在 dup_of 填被转述的那条编号，否则填 null。',
      '3. 把握程度 confidence：high = 官方已承认且症状和时间都对得上，或至少 3 个互相独立的来源一致；medium = 至少 2 个独立来源一致；low = 只有 1 个来源，或只是推测。转述同一来源的只算 1 个。',
      '4. 官方说法也只是一种待核实的说法。要对比官方承认的时间和范围与用户报告是否一致，例如用户先报告了多久官方才承认、官方说的范围是否比用户报告的小。不一致就写出来。',
      '5. 原因类型 type 只能取：provider_outage（服务方故障）、deliberate_change（官方主动变更，如政策、限额、下线、改版、封禁）、upstream（上游依赖故障）、account（账号个别问题）、local（用户本地环境，如网络、代理、版本、缓存）、unknown。',
      '6. 如果证据和用户的症状或时间对不上，verdict 用 insufficient，并在 actions 里给出自查步骤。不要为了给出结论硬凑。时间范围之外的旧事故不能当成这次的原因。',
      '7. 类型为"聚合站"的条目只能说明有很多人在查或在报，不能作为原因的依据。类型为"上游事件"的条目只有在时间吻合、且有条目把它和这个产品联系起来时才能当原因。',
      '8. 条目的"时间"已经换算成用户时区。timeline 的 time 用 MM-DD HH:mm 格式，直接取条目时间，不要自己换算。',
      '9. 用简体中文，句子短，不要客套话。actions 要具体可执行。',
      '',
      '输出 json 结构：',
      '{',
      '  "labels": [{"id": 1, "rel": "same", "dup_of": null}],',
      '  "verdict": "widespread | official_change | likely_local | mixed | insufficient",',
      '  "headline": "一句话结论",',
      '  "confidence": "high | medium | low",',
      '  "causes": [{"title": "原因假设", "type": "provider_outage", "confidence": "high", "why": "为什么这么判断", "evidence": [1, 2], "against": []}],',
      '  "timeline": [{"time": "11-16 15:49", "event": "发生了什么", "evidence": [1]}],',
      '  "others": {"summary": "其他人的情况", "scale": "大概多少人或多大范围", "affected": "哪些地区、平台、版本、套餐受影响", "evidence": [2, 3]},',
      '  "official": {"statement": "官方怎么说；没有官方说法就写没有", "matches_reports": "和用户报告是否一致、差在哪", "evidence": [1]},',
      '  "actions": [{"do": "现在能做什么", "why": "依据"}],',
      '  "unknowns": ["还不确定的事"]',
      '}',
      'verdict 含义：widespread = 普遍问题，不止用户一个；official_change = 官方主动变更；likely_local = 没有其他人报告，多半是用户这边的问题；mixed = 只有部分人受影响；insufficient = 证据不足。',
    ].join('\n');

    const lines = [];
    lines.push('用户描述：' + String(desc || '').slice(0, 1500));
    lines.push('当前时间：' + fmtLocal(now, offsetMin) + '（' + tzLabel(offsetMin) + '）');
    lines.push('时间范围：最近 ' + (windowHours >= 48 && windowHours % 24 === 0 ? windowHours / 24 + ' 天' : windowHours + ' 小时') + '（官方条目放宽到 7 天）');
    lines.push('产品：' + p.product + (p.platform ? '；平台：' + p.platform : ''));
    if (p.errors && p.errors.length) lines.push('用户给出的报错原文：' + p.errors.join(' / '));
    if (statusSummary) lines.push('官方状态页当前显示：' + statusSummary);
    lines.push('');
    lines.push('证据条目（共 ' + items.length + ' 条）：');
    for (const it of items) {
      const eng = [];
      if (it.comments) eng.push('评论' + it.comments);
      if (it.points) eng.push('赞' + it.points);
      lines.push('[' + it.id + '] 类型=' + (TYPE_ZH[it.type] || it.type) + ' 来源=' + (it.host || '') +
        ' 时间=' + (it.ts != null ? fmtLocal(it.ts, offsetMin) : '未知') + (eng.length ? ' 互动=' + eng.join('、') : ''));
      lines.push('标题：' + it.title);
      if (it.text) lines.push('摘要：' + clip(it.text, it.src === 'status' ? 1200 : 500));
      if (it.similar && it.similar.length) {
        lines.push('另有 ' + it.similar.length + ' 条相似（' + uniq(it.similar.map((s) => s.host)).slice(0, 4).join('、') + '）');
      }
    }
    if (!items.length) lines.push('（没有找到符合条件的条目）');
    return [{ role: 'system', content: sys }, { role: 'user', content: lines.join('\n') }];
  }

  return {
    HOUR, DAY, REASON, TYPE_ZH, REGISTRY,
    uniq, clip, canonicalUrl, hostOf, tokens, jaccard, registryFor, extractErrors,
    normalizeParsed, heuristicParse, buildQueries, buildDeepLinks,
    fromDeepseek, fromGithub, fromHN, fromStatuspage, summarizeStatus, fmtLocal, tzLabel,
    classifySource, makeCtx, applyFilters, extractJson, postProcess, parseMessages, analysisMessages,
  };
});
