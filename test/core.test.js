const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

const NOW = Date.parse('2026-11-16T14:30:00Z');
const H = 3600e3;
const iso = (hAgo) => new Date(NOW - hAgo * H).toISOString();

const parsed = C.normalizeParsed({
  product: 'Claude', vendor: 'Anthropic', aliases: ['claude.ai', 'Claude Code'],
  symptoms_en: ['elevated errors', 'not responding'], symptoms_zh: ['报错'],
  errors: ['overloaded_error'],
}, 'Claude 今天下午一直报错 overloaded_error', {});
const ctx = () => C.makeCtx(parsed, 48, NOW);
const item = (o) => Object.assign({ src: 'search', title: '', url: '', text: '', date: iso(2) }, o);

test('canonicalUrl 去掉跟踪参数、前缀和锚点', () => {
  assert.equal(C.canonicalUrl('https://www.Example.com/a/b/?utm_source=x&id=3#top'), 'example.com/a/b?id=3');
  assert.equal(C.canonicalUrl('https://example.com/a/b?id=3'), 'example.com/a/b?id=3');
});

test('canonicalUrl 把同一个帖子的不同写法归成一条', () => {
  const a = C.canonicalUrl('https://www.reddit.com/r/ClaudeAI/comments/1abc2d/claude_is_down/');
  const b = C.canonicalUrl('https://old.reddit.com/r/claudeai/comments/1abc2d/claude_is_down/k9x/?context=3');
  assert.equal(a, b);
  assert.equal(C.canonicalUrl('https://twitter.com/Foo/status/123456?s=20&t=abc'), C.canonicalUrl('https://x.com/foo/status/123456/photo/1'));
  assert.equal(C.canonicalUrl('https://github.com/Anthropics/claude-code/issues/99#issuecomment-1'), 'github.com/anthropics/claude-code/issues/99');
  assert.equal(C.canonicalUrl('https://news.ycombinator.com/item?id=42&p=2'), 'news.ycombinator.com/item?id=42');
});

test('canonicalUrl 不合并有意义的参数', () => {
  assert.notEqual(C.canonicalUrl('https://bbs.example.com/viewtopic.php?t=123'), C.canonicalUrl('https://bbs.example.com/viewtopic.php?t=124'));
});

test('tokens 同时处理英文词和中文二元组', () => {
  const t = C.tokens('Claude 报错了 overloaded_error!');
  assert.ok(t.has('claude') && t.has('overloaded_error'));
  assert.ok(t.has('报错') && t.has('错了'));
  assert.equal(C.jaccard(C.tokens('Claude is down'), C.tokens('is claude down?')), 1);
  assert.equal(C.jaccard(new Set(), new Set()), 0);
});

test('classifySource 区分官方、社区、聚合站、新闻', () => {
  const c = ctx();
  assert.equal(C.classifySource({ url: 'https://status.claude.com/incidents/abc', title: 'Elevated errors' }, c), 'official');
  assert.equal(C.classifySource({ url: 'https://www.anthropic.com/news/x', title: 'x' }, c), 'official');
  assert.equal(C.classifySource({ url: 'https://www.reddit.com/r/ClaudeAI/comments/1/x', title: 'x' }, c), 'community');
  assert.equal(C.classifySource({ url: 'https://forum.cursor.com/t/abc', title: 'x' }, c), 'community');
  assert.equal(C.classifySource({ url: 'https://statusgator.com/services/claude', title: 'Claude outage history' }, c), 'aggregator');
  assert.equal(C.classifySource({ url: 'https://pulsetic.com/status/claude/', title: 'Is Claude Down? Claude Status & Outage Tracker' }, c), 'aggregator');
  assert.equal(C.classifySource({ url: 'https://www.androidauthority.com/claude-outage-1/', title: 'Claude is experiencing a widespread outage' }, c), 'news');
  // 今天实查 Claude 故障时搜到的真实页面：都是转抄状态页的第三方站
  for (const [url, title] of [
    ['https://claudestatus.com/', 'Is Claude Down?'],
    ['https://www.getmaxim.ai/bifrost/provider-status/anthropic', 'Is Claude Down? Anthropic API & Platform Status'],
    ['https://llmapi.ai/status/anthropic/', 'Claude API status: is Anthropic down?'],
    ['https://claudenetwork.com/status', 'Claude status — live service health and incident history'],
    ['https://visualsentinel.com/tools/status/claude', 'Claude Status: Is Claude Down Right Now?'],
    ['https://techbloat.com/is-claude-down-or-just-slow-a-practical-fix-guide.html', 'Is Claude Down or Slow? Causes, Checks, and Fixes'],
  ]) assert.equal(C.classifySource({ url, title }, c), 'aggregator', url);
  assert.equal(C.classifySource({ url: 'https://x.com/someone/status/123', title: 'Is Claude down for anyone else?' }, c), 'community');
  assert.equal(C.classifySource({ url: 'https://www.technobezz.com/news/claude-service-incident-d8', title: 'Claude Reports Elevated Errors' }, c), 'news');
  const other = C.makeCtx(C.normalizeParsed({ product: 'Notion', symptoms_en: ['sync error'] }, 'Notion 同步报错', {}), 48, NOW);
  assert.equal(C.classifySource({ url: 'https://status.notion.so/incidents/1', title: 'Sync delays' }, other), 'official');
  assert.equal(C.classifySource({ url: 'https://notion.statuspage.io/incidents/1', title: 'Sync delays' }, other), 'official');
  assert.equal(C.classifySource({ url: 'https://status.other.com/incidents/1', title: 'Notion sync delays' }, other), 'aggregator');
  assert.equal(C.classifySource({ url: 'https://download.example.com/notion-fix', title: 'Notion sync error fix' }, other), 'news');
});

test('heuristicParse 无 key 时也能拆出产品、症状和报错原文', () => {
  const p = C.heuristicParse('Claude 今天下午突然一直报错 overloaded_error，网页也用不了', {});
  assert.equal(p.product, 'Claude');
  assert.equal(p.status_page, 'https://status.claude.com');
  assert.ok(p.symptoms_en.includes('error'));
  assert.ok(p.symptoms_en.includes('not working'));
  assert.ok(p.symptoms_zh.includes('报错'));
  assert.ok(p.errors.includes('overloaded_error'));
  const q = C.heuristicParse('啥也没说', { product: 'Foo', keywords: 'login, 2fa' });
  assert.equal(q.product, 'Foo');
  assert.deepEqual(q.symptoms_en.slice(0, 2), ['login', '2fa']);
});

test('statusPageFor 按产品名查注册表，不误匹配子串', () => {
  assert.equal(C.registryFor('我的 claude code 出问题').status, 'https://status.claude.com');
  assert.equal(C.registryFor('npmjs 装不上') , null);
  assert.equal(C.registryFor('npm 装不上').product, 'npm');
});

test('buildQueries 拆成多条细查询，长度合规且不重复', () => {
  const qs = C.buildQueries(parsed, 48, NOW);
  assert.ok(qs.length >= 9 && qs.length <= 15);
  for (const q of qs) assert.ok(q.q.length <= 128, q.q);
  assert.equal(new Set(qs.map((q) => q.q)).size, qs.length);
  const all = qs.map((q) => q.q).join('\n');
  assert.match(all, /site:reddit\.com/);
  assert.match(all, /site:x\.com/);
  assert.match(all, /"overloaded_error"/);
  assert.match(all, /after:2026-11-13/);
  assert.ok(!/after:2026-11-1[4-9]/.test(all), '48 小时窗口要多留一天余量');
  assert.match(qs.find((q) => q.label === '官方变更').q, /after:2026-10-16$/, '官方变更往回看 30 天');
  assert.match(qs.find((q) => q.label === '官方通告').q, /after:2026-11-08$/, '官方事故通告仍是 7 天');
  assert.match(all, /lang:zh/);
  assert.ok(qs.some((q) => q.upstream));
  const noErr = C.buildQueries(Object.assign({}, parsed, { errors: [] }), 48, NOW);
  assert.ok(!noErr.some((q) => q.label === '报错原文'));
  const long = C.buildQueries(Object.assign({}, parsed, { symptoms_en: ['x'.repeat(200)] }), 48, NOW);
  for (const q of long) assert.ok(q.q.length <= 128);
});

test('applyFilters 合并同一链接', () => {
  const r = C.applyFilters([
    item({ title: 'Claude elevated errors today', url: 'https://www.reddit.com/r/ClaudeAI/comments/1abc/x/?utm_source=a' }),
    item({ title: 'Claude elevated errors today', url: 'https://old.reddit.com/r/claudeai/comments/1abc/x/' }),
  ], ctx());
  assert.equal(r.kept.length, 1);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].reason, 'dup');
});

test('applyFilters 去掉过期帖，但官方条目放宽到 7 天', () => {
  const r = C.applyFilters([
    item({ title: 'Claude down, errors everywhere', url: 'https://reddit.com/r/ClaudeAI/comments/old1/x', date: iso(24 * 20) }),
    item({ src: 'status', type: 'official', title: 'Elevated errors on Claude', url: 'https://status.claude.com/incidents/a', date: iso(24 * 5) }),
    item({ src: 'status', type: 'official', title: 'Elevated errors last month', url: 'https://status.claude.com/incidents/b', date: iso(24 * 30) }),
    item({ title: 'Claude errors right now', url: 'https://reddit.com/r/ClaudeAI/comments/new1/x', date: null }),
  ], ctx());
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.url, e.reason]));
  assert.equal(reasons['https://reddit.com/r/ClaudeAI/comments/old1/x'], 'old');
  assert.equal(reasons['https://status.claude.com/incidents/b'], 'old');
  assert.ok(r.kept.some((k) => k.url.endsWith('/incidents/a')));
  const undated = r.kept.find((k) => k.url.endsWith('new1/x'));
  assert.ok(undated && undated.undated);
});

test('applyFilters 官方公告放宽到 30 天并标为背景；状态页事故仍是 7 天；较早的公告最多留 5 条', () => {
  const note = (n, days, title) => item({ title: title || ('Claude usage limits update ' + n + ' v' + n * 7919), url: 'https://www.anthropic.com/news/limits-' + n, text: 'New weekly limits change for Claude plans, item ' + n, date: iso(24 * days) });
  const r = C.applyFilters([
    note(1, 20), note(2, 40),
    item({ title: 'Claude limits changed today', url: 'https://www.anthropic.com/news/today', text: 'Limits change', date: iso(3) }),
    item({ src: 'status', type: 'official', title: 'Elevated errors on Claude', url: 'https://status.claude.com/incidents/w5', date: iso(24 * 5) }),
    item({ src: 'status', type: 'official', title: 'Elevated errors three weeks ago', url: 'https://status.claude.com/incidents/w20', date: iso(24 * 20) }),
    item({ title: 'Claude limits are worse, errors too', url: 'https://reddit.com/r/ClaudeAI/comments/lim20/x', date: iso(24 * 20) }),
  ], ctx());
  const by = (frag) => r.kept.find((k) => k.url.includes(frag));
  const why = Object.fromEntries(r.excluded.map((e) => [e.url.split('/').pop(), e.reason]));
  assert.equal(by('limits-1').older, true, '20 天前的官方公告留下，标为早于时间范围');
  assert.equal(by('/today').older, false);
  assert.equal(by('w5').older, true);
  assert.deepEqual(why, { 'limits-2': 'old', w20: 'old', x: 'old' });
  assert.ok(by('/today').score > by('limits-1').score, '最近的排在较早的前面');
  const many = C.applyFilters(Array.from({ length: 9 }, (_, i) => note(i + 10, 10 + i)), ctx());
  assert.equal(many.kept.length, 5);
  assert.equal(many.excluded.filter((e) => e.reason === 'oldcap').length, 4);
  const user = C.analysisMessages('Claude 限额变了', parsed, r.kept, '', NOW, 480, 48)[1].content;
  assert.match(user, /\[\d+\] 类型=官方 来源=anthropic\.com 时间=10-27[^\n]*备注=早于时间范围，仅作背景/);
  assert.ok(!/时间=11-16[^\n]*早于时间范围/.test(user));
});

test('postProcess 透传「最近的情况」和「现在的状态」，并校验取值', () => {
  const { items, id } = evItems();
  const out = C.postProcess({ verdict: 'widespread', headline: 'h', confidence: 'high', status_now: 'resolved',
    recent: { summary: '下午的故障已恢复，深夜又有一条新事件在调查。', evidence: [id('status.claude'), 777] },
    causes: [{ title: 'x', confidence: 'high', evidence: [id('status.claude')] }], labels: [] }, items);
  assert.equal(out.report.status_now, 'resolved');
  assert.deepEqual(out.report.recent, { summary: '下午的故障已恢复，深夜又有一条新事件在调查。', evidence: [id('status.claude')] });
  const bad = C.postProcess({ verdict: 'widespread', status_now: 'fine', causes: [], labels: [] }, items);
  assert.equal(bad.report.status_now, 'unknown');
  assert.deepEqual(bad.report.recent, { summary: '', evidence: [] });
});

test('applyFilters 去掉没提到产品或没提到故障的', () => {
  const r = C.applyFilters([
    item({ title: 'Gemini is throwing errors', url: 'https://reddit.com/r/Bard/comments/g1/x' }),
    item({ title: 'Claude wrote my thesis outline', url: 'https://reddit.com/r/ClaudeAI/comments/t1/x', text: 'It was great.' }),
    item({ title: 'Is anyone else getting overloaded_error from Claude?', url: 'https://reddit.com/r/ClaudeAI/comments/e1/x' }),
  ], ctx());
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.url, e.reason]));
  assert.equal(reasons['https://reddit.com/r/Bard/comments/g1/x'], 'noproduct');
  assert.equal(reasons['https://reddit.com/r/ClaudeAI/comments/t1/x'], 'nosymptom');
  assert.equal(r.kept.length, 1);
  assert.ok(r.kept[0].errorHit);
});

test('applyFilters 相似标题归成一组并保留数量', () => {
  const r = C.applyFilters([
    item({ title: 'Claude is down again', url: 'https://reddit.com/r/ClaudeAI/comments/a1/x', comments: 80 }),
    item({ title: 'Is Claude down again?', url: 'https://reddit.com/r/ClaudeAI/comments/a2/x', comments: 3 }),
    item({ title: 'claude down AGAIN!!', url: 'https://reddit.com/r/Anthropic/comments/a3/x' }),
    item({ title: 'Claude Code hangs on tool calls, errors after update', url: 'https://github.com/anthropics/claude-code/issues/7', src: 'github', fromRepo: true, comments: 12 }),
  ], ctx());
  assert.equal(r.kept.length, 2);
  const rep = r.kept.find((k) => k.url.endsWith('a1/x'));
  assert.ok(rep, '互动最多的那条当代表');
  assert.equal(rep.similar.length, 2);
  assert.equal(r.excluded.length, 0);
});

test('applyFilters 聚合站最多留 2 条，编号连续，按分数排序并截断', () => {
  const agg = ['statusgator.com/a', 'isdown.app/b', 'downdetector.com/c', 'pulsetic.com/status/d'].map((u, i) =>
    item({ title: 'Claude status ' + i + ' outage tracker', url: 'https://' + u, text: 'Claude outage reports number ' + 'word'.repeat(i + 1) }));
  const many = Array.from({ length: 60 }, (_, i) =>
    item({ title: 'Claude error report case ' + i + ' ' + 'k' + i * 7919, url: 'https://site' + i + '.example.com/post', text: 'unique body ' + i + ' token' + i * 31, date: iso(1 + i / 10) }));
  const c = ctx();
  const r = C.applyFilters([...agg, ...many], c);
  assert.equal(r.kept.filter((k) => k.type === 'aggregator').length, 2);
  assert.ok(r.kept.length <= c.cap);
  assert.deepEqual(r.kept.map((k) => k.id), r.kept.map((_, i) => i + 1));
  for (let i = 1; i < r.kept.length; i++) assert.ok(r.kept[i - 1].score >= r.kept[i].score);
  assert.ok(r.excluded.some((e) => e.reason === 'aggregator'));
  assert.ok(r.excluded.some((e) => e.reason === 'cap'));
  assert.equal(r.stats.total, 64);
});

test('applyFilters 产品仓库里的普通 issue 不算证据，除非对上症状、报错原文或很多人跟帖', () => {
  const gh = (n, title, extra) => item(Object.assign({ src: 'github', fromRepo: true, title, url: 'https://github.com/anthropics/claude-code/issues/' + n }, extra || {}));
  const r = C.applyFilters([
    gh(1, '[BUG] LSP does not follow the working directory, errors on start'),
    gh(2, '[BUG] cursor stays visible, broken rendering'),
    gh(3, '[BUG] elevated errors on every request since noon'),
    gh(4, '[BUG] API returns overloaded_error'),
    gh(5, '[BUG] everything fails for me', { comments: 30 }),
  ], ctx());
  assert.deepEqual(r.kept.map((k) => +k.url.split('/').pop()).sort(), [3, 4, 5]);
  assert.deepEqual(r.excluded.map((e) => e.reason), ['reponoise', 'reponoise']);
});

test('applyFilters 同一网站最多留 12 条，避免一个来源挤掉其他来源', () => {
  const posts = Array.from({ length: 20 }, (_, i) =>
    item({ title: 'Claude error thread ' + i + ' q' + i * 7919, url: 'https://reddit.com/r/ClaudeAI/comments/h' + i + '/x', text: 'body ' + i + ' w' + i * 31 }));
  const other = item({ title: 'Claude errors reported by users', url: 'https://news.ycombinator.com/item?id=9' });
  const r = C.applyFilters([...posts, other], ctx());
  assert.equal(r.kept.filter((k) => k.host === 'reddit.com').length, 12);
  assert.ok(r.kept.some((k) => k.host === 'news.ycombinator.com'));
  assert.equal(r.excluded.filter((e) => e.reason === 'hostcap').length, 8);
});

test('applyFilters 说明文档不算事故证据；对上报错原文的留下当参考，更新日志照常保留', () => {
  // 前两条是真实跑出来的噪音：Claude Code 的报错对照表被当成了官方证据排在最前面
  const r = C.applyFilters([
    item({ title: 'Error reference - Claude Code Docs', url: 'https://code.claude.com/docs/en/errors', text: 'AWS default-chain credential resolve timed out. Check your network and proxy settings, then try again. Claude Code error.', date: iso(72) }),
    item({ title: '錯誤參考 – Claude Code Docs – Failed to write to a teammate’s inbox', url: 'https://code.claude.com/docs/zh-TW/errors', text: 'Claude Code 無法將訊息寫入，error', date: iso(96) }),
    item({ title: 'Errors - Claude API Documentation', url: 'https://docs.claude.com/en/api/errors', text: 'overloaded_error: The Claude API is temporarily overloaded.', date: iso(24 * 200) }),
    item({ title: 'Release notes - Claude Docs', url: 'https://docs.claude.com/en/release-notes/overview', text: 'Claude usage limits changed this week.', date: iso(30) }),
    item({ title: 'The Claude docs are wrong about this error', url: 'https://reddit.com/r/ClaudeAI/comments/d1/x', text: 'errors everywhere' }),
  ], ctx());
  const by = (frag) => r.kept.find((k) => k.url.includes(frag));
  assert.deepEqual(r.excluded.map((e) => e.reason), ['docs', 'docs']);
  assert.equal(by('/api/errors').type, 'reference', '对上报错原文的文档留下，且不受时间范围限制');
  assert.equal(by('release-notes').type, 'official');
  assert.equal(by('reddit.com').type, 'community');
  assert.ok(by('/api/errors').score < by('reddit.com').score, '说明文档排在真实报告后面');
  const out = C.postProcess({ verdict: 'widespread', headline: 'h', confidence: 'high', causes: [{ title: 'x', confidence: 'high', evidence: [by('/api/errors').id] }], labels: [] }, r.kept);
  assert.equal(out.report.causes[0].note, '只有聚合站或说明文档，不能当依据');
  assert.equal(out.report.verdict, 'insufficient');
});

test('粘贴的帖子：不要求提到产品，过期的照样排除，同一内容粘两次只算一条，能算作独立来源', () => {
  const link = 'https://www.reddit.com/search/?q=Claude&sort=new';
  const mk = (title, mins, src) => C.fromPaste({ title, text: title + ' — body', time: '3h', minutes_ago: mins, replies: 5, author: 'u1' }, src || 'reddit', NOW, link);
  const a = mk('anyone else getting errors on sonnet since noon', 120);
  const b = mk('same here, EU, web and code', 100);
  const old = mk('it was also down last week', 60 * 24 * 6);
  const again = mk('anyone else getting errors on sonnet since noon', 120);
  const chat = C.fromPaste({ title: '', text: '群里都说下午用不了，四点多才好', minutes_ago: null }, 'group', NOW, '');
  assert.equal(C.fromPaste({}, 'x', NOW, ''), null);
  assert.deepEqual([a.src, a.type, a.pasted, a.hostLabel, a.url], ['paste', 'community', true, 'reddit.com', link]);
  assert.equal(a.canonKey, again.canonKey);
  assert.notEqual(a.canonKey, b.canonKey);
  assert.equal(chat.url, ''); assert.equal(chat.date, null); assert.equal(chat.title, '群里都说下午用不了，四点多才好');
  const r = C.applyFilters([a, b, old, again, chat], ctx());
  assert.deepEqual(r.excluded.map((e) => e.reason).sort(), ['dup', 'old']);
  assert.equal(r.kept.length, 3);
  assert.deepEqual(r.kept.map((k) => k.host).sort(), ['reddit.com', 'reddit.com', '群聊']);
  assert.ok(r.kept.find((k) => k.host === '群聊').undated);
  const ids = r.kept.filter((k) => k.host === 'reddit.com').map((k) => k.id);
  const out = C.postProcess({ verdict: 'widespread', headline: 'h', confidence: 'high', causes: [{ title: 'x', confidence: 'high', evidence: ids }], labels: [] }, r.kept);
  assert.equal(out.report.causes[0].confidence, 'medium', '两条独立的社区帖子，没有官方依据，最多到中');
  assert.equal(out.report.causes[0].sources, 2);
  const msgs = C.pasteMessages('x'.repeat(30000), 'Reddit', 'Claude', NOW, 480);
  assert.match(msgs[0].content, /json/); assert.ok(!msgs[0].content.includes('拆解'));
  assert.ok(msgs[1].content.length < 20200, '过长的粘贴内容要截断');
});

test('粘贴的帖子不受同一网站 12 条上限限制，并排在搜到的条目前面', () => {
  const found = Array.from({ length: 14 }, (_, i) => item({ title: 'Claude error thread ' + i + ' q' + i * 7919, url: 'https://reddit.com/r/ClaudeAI/comments/s' + i + '/x', text: 'body ' + i + ' w' + i * 31 }));
  const pasted = C.fromPaste({ title: 'my paste z9', text: 'unique pasted body k7', minutes_ago: 60 }, 'reddit', NOW, 'https://www.reddit.com/search/?q=x');
  const r = C.applyFilters([...found, pasted], ctx());
  assert.ok(r.kept.some((k) => k.pasted));
  assert.equal(r.kept.filter((k) => k.host === 'reddit.com' && !k.pasted).length, 12);
});

test('applyFilters 上游故障条目不要求提到产品，但限量', () => {
  const up = Array.from({ length: 6 }, (_, i) => item({ upstream: true, title: 'Azure outage hits services ' + i + ' z' + i * 13, url: 'https://news' + i + '.example.com/a', text: 'Major outage at Azure number ' + i }));
  const r = C.applyFilters(up, ctx());
  assert.equal(r.kept.length, 3);
  assert.ok(r.kept.every((k) => k.type === 'upstream'));
});

test('来源适配器输出统一结构', () => {
  const d = C.fromDeepseek({ title: 'T', url: 'https://a.com/x', snippet: 's', summary: 'long summary', date: '2026-11-16T08:00:00+00:00', rerank_score: 2.1, authority: 3, site_name: 'A' }, { label: 'Reddit' });
  assert.deepEqual([d.src, d.title, d.text, d.rerank, d.via], ['search', 'T', 'long summary', 2.1, 'Reddit']);
  const g = C.fromGithub({ title: 'Bug', html_url: 'https://github.com/o/r/issues/1', body: 'b'.repeat(2000), created_at: '2026-11-16T08:00:00Z', comments: 4, reactions: { total_count: 9 } }, true);
  assert.equal(g.src, 'github'); assert.equal(g.comments, 4); assert.equal(g.points, 9); assert.ok(g.text.length <= 600); assert.equal(g.fromRepo, true);
  const s = C.fromHN({ objectID: '77', story_title: 'Claude down', comment_text: '<p>same &amp; here</p>', created_at: '2026-11-16T08:00:00Z', points: null, num_comments: null });
  assert.equal(s.url, 'https://news.ycombinator.com/item?id=77'); assert.equal(s.text, 'same & here');
  const p = C.fromStatuspage({ name: 'Elevated errors', shortlink: 'https://stspg.io/x', impact: 'major', status: 'resolved', created_at: '2026-11-16T07:49:00Z', resolved_at: '2026-11-16T09:03:00Z', incident_updates: [{ body: 'Fixed.', created_at: '2026-11-16T09:03:00Z', status: 'resolved' }, { body: 'Investigating.', created_at: '2026-11-16T07:49:00Z', status: 'investigating' }] }, 'https://status.claude.com');
  assert.equal(p.type, 'official'); assert.equal(p.src, 'status'); assert.equal(p.url, 'https://stspg.io/x');
  assert.equal(C.fromStatuspage({ id: 'abc', name: 'n', shortlink: 'https://stspg.io/x' }, 'https://status.claude.com').url, 'https://status.claude.com/incidents/abc'); assert.match(p.text, /Investigating\./); assert.match(p.text, /resolved/);
});

test('extractJson 能从围栏和杂文里取出 JSON，空白返回 null', () => {
  assert.deepEqual(C.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(C.extractJson('好的，结果如下：{"a":{"b":"}"}} 以上'), { a: { b: '}' } });
  assert.equal(C.extractJson('     '), null);
  assert.equal(C.extractJson('not json'), null);
});

const evItems = () => {
  const r = C.applyFilters([
    item({ src: 'status', type: 'official', title: 'Elevated errors for Claude Sonnet', url: 'https://status.claude.com/incidents/a' }),
    item({ title: 'Claude overloaded_error for everyone?', url: 'https://reddit.com/r/ClaudeAI/comments/r1/x', comments: 50 }),
    item({ title: 'Claude API returning errors since this morning in Europe', url: 'https://news.ycombinator.com/item?id=5' }),
    item({ title: 'Claude outage tracker says errors rising', url: 'https://statusgator.com/services/claude' }),
    item({ title: 'Claude subscription price error on invoice', url: 'https://reddit.com/r/ClaudeAI/comments/r9/x' }),
  ], ctx());
  const id = (frag) => r.kept.find((k) => k.url.includes(frag)).id;
  return { items: r.kept, id };
};

test('postProcess 去掉不存在的编号，没有依据的结论降为低把握', () => {
  const { items, id } = evItems();
  const out = C.postProcess({
    verdict: 'widespread', headline: 'h', confidence: 'high',
    causes: [
      { title: '服务方故障', type: 'provider_outage', confidence: 'high', evidence: [id('status.claude'), 999] },
      { title: '瞎猜的', type: 'unknown', confidence: 'high', evidence: [] },
    ],
    labels: [],
  }, items);
  assert.deepEqual(out.report.causes[0].evidence, [id('status.claude')]);
  assert.equal(out.report.causes[0].confidence, 'high');
  assert.equal(out.report.causes[1].confidence, 'low');
  assert.equal(out.report.causes[1].note, '无依据');
});

test('postProcess 单一来源、聚合站依据、独立来源不足时自动下调', () => {
  const { items, id } = evItems();
  const out = C.postProcess({
    verdict: 'widespread', headline: 'h', confidence: 'high',
    causes: [
      { title: 'A', confidence: 'high', evidence: [id('r1/x')] },
      { title: 'B', confidence: 'high', evidence: [id('statusgator')] },
      { title: 'C', confidence: 'high', evidence: [id('r1/x'), id('item?id=5')] },
    ],
    labels: [],
  }, items);
  const [a, b, c] = out.report.causes;
  assert.equal(a.confidence, 'low'); assert.equal(a.note, '单一来源');
  assert.equal(b.confidence, 'low'); assert.equal(b.note, '只有聚合站或说明文档，不能当依据');
  assert.equal(c.confidence, 'medium');
  assert.equal(out.report.confidence, 'low', '总体把握不能高于第一条原因');
});

test('postProcess 转述算同一来源，无关条目移出证据', () => {
  const { items, id } = evItems();
  const out = C.postProcess({
    verdict: 'widespread', headline: 'h', confidence: 'medium',
    causes: [{ title: 'A', confidence: 'medium', evidence: [id('r1/x'), id('item?id=5'), id('r9/x')] }],
    labels: [
      { id: id('item?id=5'), rel: 'same', dup_of: id('r1/x') },
      { id: id('r9/x'), rel: 'irrelevant', dup_of: null },
    ],
  }, items);
  assert.deepEqual(out.report.causes[0].evidence, [id('r1/x')]);
  assert.equal(out.report.causes[0].confidence, 'low');
  assert.ok(!out.kept.some((k) => k.url.includes('r9/x')));
  assert.ok(!out.kept.some((k) => k.url.includes('item?id=5')));
  assert.deepEqual(out.moved.map((m) => m.reason).sort(), ['irrelevant', 'restate']);
  const root = out.kept.find((k) => k.url.includes('r1/x'));
  assert.ok(root.similar.some((s) => s.restate));
});

test('postProcess 没有任何有依据的原因时改判证据不足', () => {
  const { items } = evItems();
  const out = C.postProcess({ verdict: 'widespread', headline: 'h', confidence: 'high', causes: [{ title: 'x', confidence: 'high', evidence: [] }], labels: [] }, items);
  assert.equal(out.report.verdict, 'insufficient');
});

test('提示词包含全部条目编号，时间按用户时区换算', () => {
  const { items } = evItems();
  const msgs = C.analysisMessages('Claude 一直报错', parsed, items, '', NOW, 480, 48);
  const user = msgs[1].content;
  for (const it of items) assert.ok(user.includes('[' + it.id + ']'));
  assert.match(msgs[0].content, /json/i);
  assert.equal(C.fmtLocal(Date.parse('2026-11-16T07:49:00Z'), 480), '11-16 15:49');
  assert.match(user, /UTC\+08:00/);
});

test('buildDeepLinks 给出各平台按最新排序的直达链接', () => {
  const links = C.buildDeepLinks(parsed);
  const by = Object.fromEntries(links.map((l) => [l.name, l.url]));
  assert.match(by['Reddit'], /sort=new/);
  assert.match(by['X'], /f=live/);
  assert.match(by['官方状态页'], /status\.claude\.com/);
  for (const l of links) assert.match(l.url, /^https:\/\//);
});
