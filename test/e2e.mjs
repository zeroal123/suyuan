// 端到端测试：拦截全部网络请求，用假数据跑完整流程。不会访问任何真实接口。
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

// 找 Playwright：先按常规方式，再试 PLAYWRIGHT_DIR 指定的目录
const load = () => {
  for (const base of [import.meta.url, (process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules') + '/']) {
    try { return createRequire(base)('playwright'); } catch (e) { /* 换下一个 */ }
  }
  throw new Error('找不到 playwright，请先 npm i -D playwright，或用 PLAYWRIGHT_DIR 指定 node_modules 目录');
};
const { chromium } = load();
const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '../index.html'), 'utf8');
const shots = path.join(here, '../shots');
mkdirSync(shots, { recursive: true });
const ORIGIN = 'https://zeroal123.github.io/suyuan/';
const H = 3600e3;
const iso = (hAgo) => new Date(Date.now() - hAgo * H).toISOString();

const searchPool = () => [
  { title: 'Claude overloaded errors for everyone right now?', url: 'https://www.reddit.com/r/ClaudeAI/comments/aaa111/claude_overloaded/?utm_source=share', summary: 'Getting overloaded_error on every message with Sonnet 5.5 since about an hour ago. Web and Claude Code both.', date: iso(3), rerank_score: 2.6 },
  { title: 'Claude overloaded errors for everyone right now?', url: 'https://old.reddit.com/r/ClaudeAI/comments/aaa111/claude_overloaded/', summary: 'dup of the same thread', date: iso(3), rerank_score: 2.1 },
  { title: 'Claude is down again', url: 'https://www.reddit.com/r/ClaudeAI/comments/bbb222/x/', summary: 'Errors on every request, Fable 5.2 too.', date: iso(2.8), rerank_score: 2.2 },
  { title: 'Is Claude down again?', url: 'https://www.reddit.com/r/Anthropic/comments/ccc333/x/', summary: 'Same here, elevated errors in EU.', date: iso(2.7), rerank_score: 2.0 },
  { title: 'Claude Sonnet 5.5 returning elevated errors, anyone else?', url: 'https://x.com/someone/status/1234567890?s=20', summary: 'elevated errors on Claude for the past 30 minutes', date: iso(2.9), rerank_score: 1.9 },
  { title: 'Claude was down yesterday for hours', url: 'https://www.reddit.com/r/ClaudeAI/comments/old999/x/', summary: 'old outage errors', date: iso(24 * 20), rerank_score: 1.2 },
  { title: 'Claude wrote my thesis outline', url: 'https://www.reddit.com/r/ClaudeAI/comments/thesis1/x/', summary: 'It was great.', date: iso(5), rerank_score: 0.8 },
  { title: 'Gemini is throwing errors', url: 'https://www.reddit.com/r/Bard/comments/gem1/x/', summary: 'errors', date: iso(2), rerank_score: 0.7 },
  { title: 'Claude outage history', url: 'https://statusgator.com/services/claude', summary: 'Claude outage reports', date: iso(1), rerank_score: 1.0 },
  { title: 'Is Claude Down? Claude Status & Outage Tracker', url: 'https://isdown.app/status/claude', summary: 'Claude down reports', date: iso(1), rerank_score: 1.0 },
  { title: 'Claude down? Current problems and outages', url: 'https://downdetector.com/status/claude/', summary: 'Claude outage chart', date: iso(1), rerank_score: 1.0 },
  { title: 'Anthropic’s Claude hit by elevated errors on newest models', url: 'https://technews.example.com/claude-errors', summary: 'Anthropic confirmed elevated errors on Claude Sonnet 5.5 and Fable 5.2.', date: iso(2), rerank_score: 2.3 },
  { title: 'Anthropic’s Claude hit by elevated errors on newest models', url: 'https://syndicated.example.org/claude-errors-copy', summary: 'Anthropic confirmed elevated errors on Claude Sonnet 5.5 and Fable 5.2. (wire copy)', date: iso(1.9), rerank_score: 1.5 },
  { title: 'Claude subscription price error on my invoice', url: 'https://www.reddit.com/r/ClaudeAI/comments/price77/x/', summary: 'billing issue', date: iso(6), rerank_score: 1.1 },
  { title: '<img src=x onerror="window.__xss=1"> Claude error', url: 'javascript:window.__xss=2', summary: '<script>window.__xss=3</script> Claude errors', date: iso(2), rerank_score: 1.0 },
];
const upstream = [{ title: 'Azure outage disrupts services worldwide', url: 'https://cloudnews.example.com/azure', summary: 'A major Azure outage is affecting many services.', date: iso(4), rerank_score: 1.4 }];

function analysisFor(userContent) {
  const ids = {};
  for (const m of userContent.matchAll(/^\[(\d+)\] 类型=(\S+) 来源=(\S*)[^\n]*\n标题：([^\n]*)/gm)) ids[m[4]] = +m[1];
  const id = (frag) => { const k = Object.keys(ids).find((t) => t.includes(frag)); return k ? ids[k] : null; };
  const ev = (...f) => f.map(id).filter((x) => x != null);
  return {
    labels: Object.values(ids).map((n) => ({ id: n, rel: 'same', dup_of: null }))
      .map((l) => (l.id === id('subscription price') ? { ...l, rel: 'irrelevant' } : l.id === id('<img') ? { ...l, rel: 'irrelevant' } : l)),
    verdict: 'widespread', headline: 'Claude 的 Sonnet 5.5 和 Fable 5.2 出现服务方故障，官方已确认并已恢复。', confidence: 'high',
    causes: [
      { title: '服务方故障：两个新模型错误率升高', type: 'provider_outage', confidence: 'high', why: '官方状态页确认，用户报告的时间和症状一致。', evidence: [...ev('Elevated errors for Claude'), ...ev('overloaded errors for everyone'), 9999], against: [] },
      { title: '上游云故障波及', type: 'upstream', confidence: 'high', why: '同期有 Azure 故障报道。', evidence: ev('Azure outage'), against: [] },
    ],
    timeline: [{ time: '11-16 15:49', event: '官方开始调查', evidence: ev('Elevated errors for Claude') }],
    others: { summary: 'Reddit、X、Hacker News 上多人同时报告。', scale: '多个社区同时出现报告', affected: '网页端和 Claude Code', evidence: ev('overloaded errors for everyone', 'Claude is down again') },
    official: { statement: '状态页确认错误率升高并已解决。', matches_reports: '基本一致。', evidence: ev('Elevated errors for Claude') },
    actions: [{ do: '换用其他模型', why: '只有两个模型受影响' }],
    unknowns: ['官方没有说明根因'],
  };
}

async function setup(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  const log = { errors: [], calls: [], unexpected: [], models: [] };
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) log.errors.push(m.text()); });
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('dialog', (d) => { log.errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url === ORIGIN) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    log.calls.push(url);
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (url.endsWith('/models')) {
      if (opts.modelsFail) return route.abort('failed');
      assert.equal(req.headers().authorization, 'Bearer sk-test');
      return json({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }, { id: 'deepseek-v5-next', object: 'model' }] });
    }
    if (url.endsWith('/chat/completions')) {
      if (opts.chatFails) return json({ error: { message: 'Authentication Fails' } }, 401);
      const body = JSON.parse(req.postData());
      log.models.push(body.model);
      if (opts.modelGone && body.model === 'old-model') return json({ error: { message: 'Model Not Exist' } }, 400);
      if (body.max_tokens === 1) return json({ choices: [{ message: { content: 'p' } }], usage: { total_tokens: 2 } }); // 自检的 ping
      assert.equal(body.response_format.type, 'json_object');
      assert.ok(['enabled', 'disabled'].includes(body.thinking.type));
      const sys = body.messages[0].content;
      const content = sys.includes('拆解')
        ? JSON.stringify({ product: 'Claude', vendor: 'Anthropic', aliases: ['claude.ai'], symptoms_en: ['overloaded error', 'elevated errors'], symptoms_zh: ['报错'], errors: ['overloaded_error'], platform: '网页', status_page: '', github_repos: [], extra_queries: ['Claude Sonnet 5.5 errors'] })
        : '```json\n' + JSON.stringify(analysisFor(body.messages[1].content)) + '\n```';
      return json({ choices: [{ message: { content } }], usage: { total_tokens: 1234 } });
    }
    if (url.endsWith('/v1/tools/search')) {
      if (opts.searchBlocked) return route.abort('failed');
      const body = JSON.parse(req.postData());
      assert.ok(body.query.length <= 128);
      assert.ok(!body.ori_question || body.ori_question.length <= 128);
      return json({ results: /cloudflare aws azure/.test(body.query) ? upstream : searchPool() });
    }
    if (url.startsWith('https://api.github.com/search/issues')) {
      assert.match(decodeURIComponent(url), /is:issue/);
      return json({ items: [
        { title: '[BUG] API Error: overloaded_error on every request', html_url: 'https://github.com/anthropics/claude-code/issues/5001', body: 'Every request fails with overloaded_error since this afternoon.', created_at: iso(2.9), comments: 40, reactions: { total_count: 25 } },
        { title: 'Feature: per-session mute', html_url: 'https://github.com/anthropics/claude-code/issues/5002', body: 'Would be nice.', created_at: iso(1), comments: 0, reactions: { total_count: 0 } },
      ] });
    }
    if (url.startsWith('https://hn.algolia.com/')) {
      return json({ hits: [{ objectID: '4242', title: 'Claude is down', created_at: iso(2.6), points: 120, num_comments: 64, story_text: 'Elevated errors &amp; timeouts on Claude.' }] });
    }
    if (url === 'https://status.claude.com/api/v2/incidents.json') {
      if (opts.statusFails) return route.abort('failed');
      return json({ incidents: [
        { id: 'i1', name: 'Elevated errors for Claude Sonnet 5.5 and Claude Fable 5.2', shortlink: 'https://stspg.io/abc', impact: 'major', status: 'resolved', created_at: iso(3.1), resolved_at: iso(1.9), components: [{ name: 'claude.ai' }], incident_updates: [{ status: 'resolved', body: 'This incident has been resolved.', created_at: iso(1.9) }, { status: 'investigating', body: 'We are investigating elevated errors.', created_at: iso(3.1) }] },
        { id: 'i0', name: 'Elevated errors last month', shortlink: 'https://stspg.io/old', impact: 'minor', status: 'resolved', created_at: iso(24 * 30), resolved_at: iso(24 * 30 - 1), incident_updates: [] },
      ] });
    }
    if (url === 'https://status.claude.com/api/v2/summary.json' || url === 'https://status.claude.com/api/v2/status.json') {
      if (opts.statusFails) return route.abort('failed');
      return json({ status: { indicator: 'none', description: 'All Systems Operational' }, components: [{ name: 'claude.ai', status: 'operational' }] });
    }
    log.unexpected.push(url);
    return route.abort('failed');
  });
  await page.goto(ORIGIN);
  if (opts.key) {
    // 用键盘回车保存：手机上粘贴完 key 直接按「前往」就是这个路径
    await page.click('#btnSet');
    await page.fill('#sKey', 'sk-test');
    await page.press('#sKey', 'Enter');
    // 弹窗的 close 事件是异步触发的，等它把设置写进去；写不进去就会在这里超时失败
    const savedKey = () => page.evaluate(() => (JSON.parse(localStorage.getItem('suyuan.cfg') || '{}')).key);
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('suyuan.cfg') || '{}')).key === 'sk-test', null, { timeout: 5000 });
    await page.click('#btnSet');
    await page.fill('#sKey', 'should-not-be-saved');
    await page.click('#sCancel');
    await page.waitForFunction(() => !document.getElementById('dlg').open);
    await page.waitForTimeout(100);
    assert.equal(await savedKey(), 'sk-test', '取消不保存');
  }
  return { page, log, ctx };
}
const runQuery = async (page, text) => {
  await page.fill('#desc', text);
  await page.click('#go');
  await page.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 20000 });
};

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
let passed = 0;
const scenario = async (name, fn) => { await fn(); passed++; console.log('ok - ' + name); };

await scenario('有 key：完整流程、去重过滤、结论校验、转义、历史', async () => {
  const { page, log, ctx } = await setup(browser, { key: true });
  await runQuery(page, 'Claude 今天下午突然一直报错 overloaded_error，网页和 Claude Code 都一样');
  assert.equal(await page.locator('#result').isVisible(), true);
  assert.equal(await page.locator('.verdict .chip').first().innerText(), '不止你一个');
  assert.equal(await page.locator('.verdict .chip').nth(1).innerText(), '把握：高');
  // 第二条原因只有 1 条上游新闻作依据，代码应把模型给的 high 压成 low 并标「单一来源」
  const cause2 = page.locator('.cause').nth(1);
  assert.match(await cause2.innerText(), /把握：低/);
  assert.match(await cause2.innerText(), /单一来源/);
  assert.match(await page.locator('.cause').first().innerText(), /有官方依据/);
  const evCount = await page.locator('.ev').count();
  assert.ok(evCount >= 6, 'evidence ' + evCount);
  const titles = await page.locator('.ev-title').allInnerTexts();
  assert.ok(!titles.some((t) => /thesis|Gemini|yesterday|last month|subscription price|per-session mute/.test(t)), titles.join(' | '));
  assert.equal(titles.filter((t) => t.includes('overloaded errors for everyone')).length, 1, '同一帖子只出现一次');
  assert.ok((await page.locator('.ev details summary').allInnerTexts()).some((t) => /另有 \d+ 条相似/.test(t)));
  assert.match(await page.locator('.excl summary').innerText(), /已排除 \d+ 条/);
  await page.click('.excl summary');
  const excl = await page.locator('.excl').innerText();
  for (const w of ['超出时间范围', '没提到这个产品', '没提到故障或症状', '聚合站', '和你说的不是一回事']) assert.ok(excl.includes(w), w);
  // 转义：恶意标题只能作为文本出现，javascript: 链接必须失效
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#result img, #result script').count(), 0);
  assert.equal(await page.locator('a[href^="javascript"]').count(), 0);
  // 引用编号可点，且指向存在的证据
  const ref = page.locator('.cause .ref').first();
  const n = await ref.innerText();
  await ref.click();
  assert.equal(await page.locator('#ev-' + n).count(), 1);
  assert.equal(await page.locator('.cause .ref', { hasText: '9999' }).count(), 0, '不存在的编号应被去掉');
  assert.match(await page.locator('.usage').innerText(), /搜索 \d+ 次 · 模型 2468 tokens/);
  assert.equal(await page.locator('.links a').count() >= 8, true);
  await page.screenshot({ path: path.join(shots, 'full-light.png'), fullPage: true });
  // 历史：刷新后还在，点开能重新渲染
  await page.reload();
  assert.equal(await page.locator('.hist li').count(), 1);
  await page.click('.hist button');
  assert.equal(await page.locator('.verdict .chip').first().innerText(), '不止你一个');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.unexpected, []);
  await ctx.close();
});

await scenario('没填 key：只抓取和过滤，不调用 DeepSeek', async () => {
  const { page, log, ctx } = await setup(browser, {});
  assert.match(await page.locator('#modeHint').innerText(), /还没填 DeepSeek key/);
  await runQuery(page, 'Claude 今天下午突然一直报错，用不了');
  assert.ok(!log.calls.some((u) => u.includes('deepseek')));
  assert.equal(await page.locator('.verdict').count(), 0);
  assert.match(await page.locator('.notice').first().innerText(), /没填 DeepSeek key/);
  assert.ok((await page.locator('.ev').count()) >= 2);
  assert.match((await page.locator('.ev-title').allInnerTexts()).join('|'), /Elevated errors for Claude/);
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.unexpected, []);
  await page.screenshot({ path: path.join(shots, 'nokey-light.png'), fullPage: true });
  await ctx.close();
});

await scenario('接口被拦或 key 失效：不中断，给出原因', async () => {
  const { page, log, ctx } = await setup(browser, { key: true, chatFails: true, searchBlocked: true, statusFails: true });
  await runQuery(page, 'Claude 一直报错');
  const prog = await page.locator('#progress').innerText();
  assert.match(prog, /key 无效/);
  assert.match(prog, /全部失败/);
  assert.match(prog, /连不上/);
  assert.ok((await page.locator('.ev').count()) >= 1, '其余来源仍然出结果');
  assert.ok((await page.locator('.notice').count()) >= 2);
  assert.deepEqual(log.errors, []);
  await ctx.close();
});

await scenario('认不出产品时提示手动填写；什么都没搜到时给自查步骤', async () => {
  const { page, log, ctx } = await setup(browser, {});
  await runQuery(page, '突然就不行了');
  assert.match(await page.locator('#progress').innerText(), /没认出是哪个产品/);
  assert.equal(await page.locator('#adv').getAttribute('open') !== null, true);
  await page.fill('#mProduct', 'Zzyzx');
  await page.route('https://api.github.com/**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"items":[]}' }));
  await page.route('https://hn.algolia.com/**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"hits":[]}' }));
  await runQuery(page, '突然就不行了');
  assert.equal(await page.locator('.verdict .chip').first().innerText(), '证据不足');
  assert.ok((await page.locator('ol.acts li').count()) >= 4);
  assert.deepEqual(log.errors, []);
  await ctx.close();
});

await scenario('设置：连接自检逐项给结果；深色模式可渲染', async () => {
  const { page, log, ctx } = await setup(browser, { key: true, dark: true });
  await page.click('#btnSet');
  await page.click('#sTest');
  await page.waitForFunction(() => !document.getElementById('sTest').disabled);
  const rows = await page.locator('#sTestOut li').allInnerTexts();
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => /可用|All Systems Operational/.test(r)), rows.join(' | '));
  await page.screenshot({ path: path.join(shots, 'settings-dark.png') });
  await page.click('#sSave');
  await runQuery(page, 'Claude 今天下午突然一直报错 overloaded_error');
  await page.screenshot({ path: path.join(shots, 'top-dark.png') });
  assert.deepEqual(log.errors, []);
  await ctx.close();
});

await scenario('模型：列表从账号读取，新模型刷新即有，也能手填；模型下线时给出提示', async () => {
  const { page, log, ctx } = await setup(browser, { key: true, modelGone: true });
  await page.click('#btnSet');
  await page.click('#sModels');
  await page.waitForFunction(() => /已读取 3 个模型/.test(document.getElementById('sModelHint').textContent));
  const opts = await page.locator('#sModel option').allInnerTexts();
  assert.ok(opts.includes('deepseek-v5-next'), opts.join(' | '));
  assert.equal(opts[opts.length - 1], '手动填写…');
  await page.selectOption('#sModel', 'deepseek-v5-next');
  await page.click('#sSave');
  await runQuery(page, 'Claude 一直报错 overloaded_error');
  assert.ok(log.models.length >= 2 && log.models.every((m) => m === 'deepseek-v5-next'), log.models.join(','));
  // 手填一个已经下线的模型名
  await page.click('#btnSet');
  await page.selectOption('#sModel', '__custom__');
  assert.equal(await page.locator('#sModelCustom').isVisible(), true);
  await page.fill('#sModelCustom', 'old-model');
  await page.click('#sSave');
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('suyuan.cfg') || '{}')).model === 'old-model');
  await page.click('#btnSet');
  assert.equal(await page.locator('#sModel').inputValue(), 'old-model');
  assert.match((await page.locator('#sModel option').allInnerTexts()).join('|'), /old-model（不在当前列表里）/);
  await page.click('#sCancel');
  await runQuery(page, 'Claude 一直报错');
  assert.match(await page.locator('#progress').innerText(), /模型「old-model」可能已下线/);
  assert.ok((await page.locator('.ev').count()) >= 1, '模型不可用时仍给出条目');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.unexpected, []);
  await ctx.close();
});

await scenario('模型列表读取失败：提示手填，不影响保存', async () => {
  const { page, log, ctx } = await setup(browser, { key: true, modelsFail: true });
  await page.click('#btnSet');
  await page.click('#sModels');
  await page.waitForFunction(() => /读取失败/.test(document.getElementById('sModelHint').textContent));
  assert.deepEqual(await page.locator('#sModel option').allInnerTexts(), ['deepseek-flash（快，便宜）', 'deepseek-v4-pro（更强，更贵）', '手动填写…']);
  await page.click('#sSave');
  assert.deepEqual(log.errors, []);
  await ctx.close();
});

await browser.close();
console.log(`# ${passed} scenarios passed`);
