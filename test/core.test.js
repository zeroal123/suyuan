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
  assert.equal(b.confidence, 'low'); assert.equal(b.note, '只有聚合站，不能当依据');
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
