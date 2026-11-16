/* 故障溯源 · 界面与网络 */
(function () {
  'use strict';
  const C = window.Core;
  const $ = (id) => document.getElementById(id);
  const LS = { cfg: 'suyuan.cfg', hist: 'suyuan.hist' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const DEFAULTS = { key: '', base: 'https://api.deepseek.com', model: 'deepseek-flash', think: false, win: 48 };
  let cfg = Object.assign({}, DEFAULTS, store.get(LS.cfg, {}));
  let usage = { search: 0, tokens: 0 };
  let running = false;

  /* ---------- DOM 小工具（外部文本一律走 textContent，不拼 HTML） ---------- */
  function safeUrl(u) {
    try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : '#'; } catch (e) { return '#'; }
  }
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'href') el.setAttribute('href', safeUrl(v));
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]];
      for (const kid of kids) {
        if (kid == null || kid === false || kid === '') continue;
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return el;
  }
  const link = (url, text, cls) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
  const tzMin = () => -new Date().getTimezoneOffset();
  function ago(ts, now) {
    const m = Math.round((now - ts) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 60 * 36) return Math.round(m / 60) + ' 小时前';
    return Math.round(m / 1440) + ' 天前';
  }

  /* ---------- 网络 ---------- */
  const HTTP_MSG = { 400: '请求格式不对', 401: 'key 无效', 402: '余额不足', 403: '被拒绝', 404: '地址不存在', 422: '请求不被接受', 429: '请求太频繁', 500: '对方服务器出错', 502: '对方网关出错', 503: '对方服务不可用', 504: '对方超时' };
  async function req(url, opt, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opt || {}));
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!r.ok) {
        const raw = data && (data.error ? (data.error.message || data.error) : data.message);
        const limited = /rate limit/i.test(String(raw || ''));
        const err = new Error(limited ? '请求太频繁（未登录每分钟只能搜 10 次），过一分钟再试' : (HTTP_MSG[r.status] || 'HTTP ' + r.status) + (raw ? '：' + String(raw).slice(0, 100) : ''));
        err.status = r.status;
        throw err;
      }
      if (data == null) throw new Error('返回的不是 JSON');
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('超时');
      if (e instanceof TypeError) throw new Error('连不上（网络不通，或被跨域策略拦截）');
      throw e;
    } finally { clearTimeout(timer); }
  }
  const baseUrl = (b) => String(b || DEFAULTS.base).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const auth = (key) => ({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });

  async function chatOnce(messages, maxTokens, think) {
    const body = { model: cfg.model, messages, response_format: { type: 'json_object' }, max_tokens: maxTokens, thinking: { type: think ? 'enabled' : 'disabled' } };
    if (think) body.reasoning_effort = 'high';
    const data = await req(baseUrl(cfg.base) + '/chat/completions', { method: 'POST', headers: auth(cfg.key), body: JSON.stringify(body) }, think ? 240000 : 120000);
    usage.tokens += (data.usage && data.usage.total_tokens) || 0;
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return C.extractJson(msg && msg.content);
  }
  async function chatJson(messages, maxTokens, think) {
    let v = await chatOnce(messages, maxTokens, think);
    // 官方文档提醒 JSON 模式偶尔会返回一串空白，这里关掉思考再试一次
    if (!v) v = await chatOnce(messages, maxTokens, false);
    if (!v) throw new Error('模型没有返回可解析的 JSON');
    return v;
  }
  async function dsSearch(q, desc) {
    const body = { query: q.q, count: 20 };
    if (desc) body.ori_question = desc.slice(0, 128);
    const data = await req(baseUrl(cfg.base) + '/v1/tools/search', { method: 'POST', headers: auth(cfg.key), body: JSON.stringify(body) }, 25000);
    const rs = Array.isArray(data.results) ? data.results : [];
    if (rs.length) usage.search++;
    return rs.map((r) => C.fromDeepseek(r, q));
  }
  async function ghSearch(q, sort) {
    const url = 'https://api.github.com/search/issues?q=' + encodeURIComponent(q) + '&sort=' + sort + '&order=desc&per_page=30';
    const data = await req(url, null, 15000);
    return Array.isArray(data.items) ? data.items : [];
  }
  async function collectGithub(p, hours, now) {
    const since = new Date(now - hours * C.HOUR).toISOString().slice(0, 19) + 'Z';
    const kw = (p.symptoms_en[0] || '').split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(' ');
    const jobs = [];
    if (p.github_repos.length) {
      for (const r of p.github_repos) {
        const q = 'is:issue repo:' + r + ' created:>=' + since;
        jobs.push(ghSearch(q, 'comments').then((a) => a.map((i) => C.fromGithub(i, true))));
        jobs.push(ghSearch(q, 'created').then((a) => a.map((i) => C.fromGithub(i, true))));
      }
      if (p.errors[0]) jobs.push(ghSearch('is:issue repo:' + p.github_repos[0] + ' "' + p.errors[0].replace(/"/g, '') + '" created:>=' + since, 'created').then((a) => a.map((i) => C.fromGithub(i, true))));
    } else {
      jobs.push(ghSearch('is:issue ' + p.product + ' ' + kw + ' created:>=' + since, 'created').then((a) => a.map((i) => C.fromGithub(i, false))));
      jobs.push(ghSearch('is:issue ' + p.product + ' in:title created:>=' + since, 'comments').then((a) => a.map((i) => C.fromGithub(i, false))));
    }
    return settle(jobs);
  }
  async function collectHN(p, hours, now) {
    const ts = Math.floor((now - hours * C.HOUR) / 1000);
    const kw = (p.symptoms_en[0] || '').split(/\s+/).filter((w) => w.length > 2)[0] || '';
    const u = (q, tag) => 'https://hn.algolia.com/api/v1/search_by_date?query=' + encodeURIComponent(q) + '&tags=' + tag + '&numericFilters=' + encodeURIComponent('created_at_i>' + ts) + '&hitsPerPage=30';
    return settle([
      req(u(p.product, 'story')).then((d) => (d.hits || []).map(C.fromHN)),
      req(u((p.product + ' ' + kw).trim(), 'comment')).then((d) => (d.hits || []).map(C.fromHN)),
    ]);
  }
  async function collectStatus(p) {
    const b = p.status_page.replace(/\/+$/, '');
    const rs = await Promise.allSettled([req(b + '/api/v2/incidents.json'), req(b + '/api/v2/summary.json')]);
    if (rs[0].status === 'rejected' && rs[1].status === 'rejected') throw rs[0].reason;
    const incs = rs[0].status === 'fulfilled' && Array.isArray(rs[0].value.incidents) ? rs[0].value.incidents : [];
    const summary = rs[1].status === 'fulfilled' ? rs[1].value : null;
    return {
      items: incs.slice(0, 25).map((i) => C.fromStatuspage(i, b, tzMin())),
      summary: C.summarizeStatus(summary),
      active: incs.some((i) => !i.resolved_at),
    };
  }
  /* 一组请求里只要有一个成功就算成功；全失败才抛错 */
  async function settle(jobs) {
    const rs = await Promise.allSettled(jobs);
    const ok = rs.filter((r) => r.status === 'fulfilled');
    if (!ok.length && rs.length) throw rs[0].reason;
    const items = [];
    ok.forEach((r) => items.push.apply(items, r.value));
    return { items, failed: rs.length - ok.length, total: rs.length, firstError: (rs.find((r) => r.status === 'rejected') || {}).reason };
  }

  /* ---------- 进度 ---------- */
  const ICON = { wait: '·', run: '◌', ok: '✓', fail: '✕', warn: '!', skip: '–' };
  function progress() {
    const ul = h('ul', { class: 'plist' });
    const box = $('progress');
    box.replaceChildren(h('h2', null, '进度'), ul);
    box.hidden = false;
    return function add(label) {
      const ic = h('span', { class: 'ic' }, ICON.wait);
      const note = h('span', { class: 'note' });
      const li = h('li', { class: 'st-wait' }, ic, h('div', null, label, ' ', note));
      ul.append(li);
      return function set(state, text) { li.className = 'st-' + state; ic.textContent = ICON[state]; note.textContent = text || ''; };
    };
  }

  /* ---------- 主流程 ---------- */
  const SELF_CHECK = [
    { do: '换一个网络，或关掉、更换代理节点再试', why: '很多「突然用不了」是出口 IP 被限制，换线路就能分辨' },
    { do: '换设备或浏览器，或用无痕窗口', why: '排除缓存、插件和客户端版本的问题' },
    { do: '退出重新登录，看注册邮箱和站内通知', why: '排除账号被限制、欠费、额度用完' },
    { do: '用下面的直达链接看各平台最新帖子', why: 'Reddit 和 X 只能跳转过去看，页面抓不到' },
    { do: '过 15 到 30 分钟再查一次，或把时间范围调大', why: '刚发生的故障通常要过一会儿才有人发帖' },
  ];
  function emptyReport(statusFetched, statusActive) {
    const calm = statusFetched && !statusActive;
    return {
      verdict: calm ? 'likely_local' : 'insufficient',
      headline: calm
        ? '没找到其他人在报同样的问题，官方状态页也没有未解决的事故。多半是你这边的问题，或者故障刚开始还没人发帖。'
        : '时间范围内没找到相关报告，暂时下不了结论。',
      confidence: 'low', causes: [], timeline: [],
      others: { summary: '没有找到其他人的报告。', scale: '', affected: '', evidence: [] },
      official: { statement: calm ? '状态页没有未解决的事故。' : '', matches_reports: '', evidence: [] },
      actions: SELF_CHECK,
      unknowns: ['没找到不等于没有：页面抓不到 Reddit、X 和群聊里的内容。'],
    };
  }

  async function run() {
    if (running) return;
    const desc = $('desc').value.trim();
    const manual = { product: $('mProduct').value.trim(), keywords: $('mKw').value.trim(), status: $('mStatus').value.trim() };
    if (!desc && !manual.product) { $('desc').focus(); return; }
    const hours = +$('win').value || 48;
    cfg.win = hours; store.set(LS.cfg, cfg);
    const now = Date.now();
    const notices = [];
    usage = { search: 0, tokens: 0 };
    running = true; $('go').disabled = true; $('go').textContent = '正在查…';
    $('result').hidden = true;
    const add = progress();
    const hasKey = !!cfg.key;
    let llmOk = hasKey;

    try {
      // 1 拆解
      const sParse = add('拆解描述');
      sParse('run');
      let parsed;
      if (hasKey && desc) {
        try {
          parsed = C.normalizeParsed(await chatJson(C.parseMessages(desc), 900, false), desc, manual);
          sParse('ok', parsed.product + ' · ' + parsed.symptoms_en.slice(0, 3).join(' / '));
        } catch (e) {
          llmOk = false;
          parsed = C.heuristicParse(desc, manual);
          sParse('warn', '模型调用失败（' + e.message + '），改用内置规则');
          notices.push('DeepSeek 模型调用失败：' + e.message + '。本次没有归纳，只有抓取和过滤。可在「设置」里做连接自检。');
        }
      } else {
        parsed = C.heuristicParse(desc, manual);
        sParse('ok', (parsed.product || '?') + ' · ' + (parsed.symptoms_en.slice(0, 3).join(' / ') || '无症状词') + '（内置规则）');
      }
      if (!parsed.product) {
        sParse('fail', '没认出是哪个产品，请在「手动指定」里填产品名');
        $('adv').open = true; $('mProduct').focus();
        return;
      }

      // 2 搜索
      const raw = [];
      const jobs = [];
      let statusInfo = { fetched: false, active: false, summary: '' };

      const sSearch = add('联网搜索');
      if (hasKey) {
        const queries = C.buildQueries(parsed, hours, now);
        sSearch('run', queries.length + ' 条细分查询');
        jobs.push(Promise.allSettled(queries.map((q) => dsSearch(q, desc))).then((rs) => {
          const ok = rs.filter((r) => r.status === 'fulfilled');
          let n = 0;
          ok.forEach((r) => { n += r.value.length; raw.push.apply(raw, r.value); });
          if (!ok.length) {
            const msg = rs[0] && rs[0].reason ? rs[0].reason.message : '未知错误';
            sSearch('fail', '全部失败：' + msg);
            notices.push('DeepSeek 搜索接口调用失败：' + msg + '。本次结果只来自 GitHub、Hacker News 和官方状态页。');
          } else sSearch(ok.length < rs.length ? 'warn' : 'ok', ok.length + '/' + rs.length + ' 条查询成功，共 ' + n + ' 条结果');
        }));
      } else sSearch('skip', '没填 key，跳过');

      const source = (label, fn, okText) => {
        const set = add(label);
        set('run');
        jobs.push(fn().then((r) => {
          raw.push.apply(raw, r.items);
          set(r.failed ? 'warn' : 'ok', okText(r) + (r.failed ? '（' + r.failed + '/' + r.total + ' 个请求失败：' + r.firstError.message + '）' : ''));
        }).catch((e) => set('fail', e.message)));
      };
      source('GitHub issues', () => collectGithub(parsed, hours, now), (r) => r.items.length + ' 条');
      source('Hacker News', () => collectHN(parsed, hours, now), (r) => r.items.length + ' 条');
      const sStatus = add('官方状态页');
      if (parsed.status_page) {
        sStatus('run');
        jobs.push(collectStatus(parsed).then((r) => {
          raw.push.apply(raw, r.items);
          statusInfo = { fetched: true, active: r.active, summary: r.summary };
          sStatus('ok', (r.summary || '已读取') + ' · 近期事故 ' + r.items.length + ' 条');
        }).catch((e) => sStatus('fail', e.message + '，请点下方「官方状态页」手动看')));
      } else sStatus('skip', parsed.status_link ? '这个状态页不支持自动读取，下方有直达链接' : '不知道它的状态页地址，可在「手动指定」里填');
      await Promise.all(jobs);

      // 3 机械去重过滤
      const sFilter = add('去重过滤');
      const f = C.applyFilters(raw, C.makeCtx(parsed, hours, now));
      sFilter('ok', '共 ' + f.stats.total + ' 条 → 留下 ' + f.kept.length + ' 条，相似归组 ' + f.stats.similar + ' 条，排除 ' + f.excluded.length + ' 条');

      // 4 语义筛选与归纳
      const sLlm = add('语义筛选与归纳');
      let report = null, kept = f.kept, excluded = f.excluded;
      if (!f.kept.length) {
        report = emptyReport(statusInfo.fetched, statusInfo.active);
        sLlm('skip', '没有可用条目，不调用模型');
      } else if (llmOk) {
        sLlm('run', cfg.think ? '深度思考中，可能要一两分钟' : '');
        try {
          const msgs = C.analysisMessages(desc, parsed, f.kept, statusInfo.summary, now, tzMin(), hours);
          const pp = C.postProcess(await chatJson(msgs, cfg.think ? 20000 : 6000, cfg.think), f.kept);
          report = pp.report; kept = pp.kept; excluded = excluded.concat(pp.moved);
          sLlm('ok', pp.moved.length ? '又筛掉 ' + pp.moved.length + ' 条' : '');
        } catch (e) {
          sLlm('fail', e.message);
          notices.push('归纳这一步失败：' + e.message + '。下面是过滤后的原始条目。');
        }
      } else sLlm('skip', hasKey ? '模型不可用' : '没填 key，跳过');
      if (!hasKey) notices.push('没填 DeepSeek key：只做了抓取和机械过滤，没有结论。到「设置」里填 key 可以得到归纳结果。');

      const state = {
        t: now, desc, hours, product: parsed.product, report, kept, excluded,
        stats: Object.assign({}, f.stats, { kept: kept.length, excluded: excluded.length }),
        links: C.buildDeepLinks(parsed), usage: Object.assign({}, usage), notices,
      };
      render(state);
      saveHistory(state);
    } catch (e) {
      const box = $('result');
      box.replaceChildren(h('p', { class: 'notice err' }, '出错了：' + (e && e.message ? e.message : String(e))));
      box.hidden = false;
    } finally {
      running = false; $('go').disabled = false; $('go').textContent = '开始查';
    }
  }

  /* ---------- 渲染 ---------- */
  const VERDICT = { widespread: ['不止你一个', 'red'], official_change: ['官方主动变更', 'blue'], likely_local: ['多半是你这边', 'teal'], mixed: ['部分人受影响', 'amber'], insufficient: ['证据不足', ''] };
  const CONF = { high: ['把握：高', 'teal'], medium: ['把握：中', 'amber'], low: ['把握：低', ''] };
  const CAUSE = { provider_outage: '服务方故障', deliberate_change: '官方主动变更', upstream: '上游依赖故障', account: '账号个别问题', local: '本地环境', unknown: '类型未知' };
  const TYPE_CHIP = { official: 'blue', community: 'teal', news: '', aggregator: 'amber', upstream: 'amber' };

  function refs(ids) {
    if (!ids || !ids.length) return null;
    return h('span', { class: 'refs' }, ids.map((id) => h('button', {
      class: 'ref', type: 'button', 'aria-label': '查看证据 ' + id,
      onclick: () => {
        const el = $('ev-' + id);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      },
    }, String(id))));
  }
  const chip = (text, cls) => h('span', { class: 'chip ' + (cls || '') }, text);
  const section = (title) => { const s = h('section', { class: 'card' }); if (title) s.append(h('h2', null, title)); return s; };

  function renderReport(box, r) {
    const v = VERDICT[r.verdict] || VERDICT.insufficient, cf = CONF[r.confidence] || CONF.low;
    box.append(h('section', { class: 'card verdict v-' + r.verdict },
      h('div', { class: 'chips' }, chip(v[0], v[1]), chip(cf[0], cf[1])),
      h('p', { class: 'headline' }, r.headline || v[0])));

    if (r.causes.length) {
      const s = section('原因');
      r.causes.forEach((c) => {
        const cc = CONF[c.confidence] || CONF.low;
        s.append(h('div', { class: 'cause' },
          h('h3', null, c.title),
          h('div', { class: 'chips' }, chip(CAUSE[c.type] || CAUSE.unknown), chip(cc[0], cc[1]), c.note ? chip(c.note, 'red') : null,
            c.evidence.length ? chip(c.official ? '有官方依据' : c.sources + ' 个独立来源', c.official ? 'blue' : '') : null),
          c.why ? h('p', null, c.why, refs(c.evidence)) : (c.evidence.length ? h('p', null, '依据', refs(c.evidence)) : null),
          c.against.length ? h('p', { class: 'meta' }, '不支持这个判断的条目', refs(c.against)) : null));
      });
      box.append(s);
    }
    if (r.timeline.length) {
      const s = section('时间线');
      s.append(h('ul', { class: 'tl' }, r.timeline.map((t) => h('li', null, h('time', null, t.time || '—'), h('span', null, t.event, refs(t.evidence))))));
      box.append(s);
    }
    const o = r.others;
    if (o.summary || o.scale || o.affected) {
      const s = section('其他人的情况');
      const dl = h('dl', { class: 'kv' });
      if (o.summary) dl.append(h('dt', null, '概况'), h('dd', null, o.summary, refs(o.evidence)));
      if (o.scale) dl.append(h('dt', null, '规模'), h('dd', null, o.scale));
      if (o.affected) dl.append(h('dt', null, '谁受影响'), h('dd', null, o.affected));
      s.append(dl); box.append(s);
    }
    const of = r.official;
    if (of.statement || of.matches_reports) {
      const s = section('官方说法，和用户报告对照');
      const dl = h('dl', { class: 'kv' });
      if (of.statement) dl.append(h('dt', null, '官方怎么说'), h('dd', null, of.statement, refs(of.evidence)));
      if (of.matches_reports) dl.append(h('dt', null, '对得上吗'), h('dd', null, of.matches_reports));
      s.append(dl); box.append(s);
    }
    if (r.actions.length) {
      const s = section('你现在能做什么');
      s.append(h('ol', { class: 'acts' }, r.actions.map((a) => h('li', null, a.do, a.why ? h('small', null, a.why) : null))));
      box.append(s);
    }
    if (r.unknowns.length) {
      const s = section('还不确定的');
      s.append(h('ul', { class: 'plain' }, r.unknowns.map((u) => h('li', null, u))));
      box.append(s);
    }
  }

  function renderEvidence(box, st) {
    const s = section('证据（' + st.kept.length + ' 条）');
    if (!st.kept.length) s.append(h('p', { class: 'hint' }, '没有符合条件的条目。'));
    st.kept.forEach((it) => {
      const meta = [it.host || ''];
      if (it.ts != null) meta.push(C.fmtLocal(it.ts, tzMin()) + '（' + ago(it.ts, st.t) + '）'); else meta.push('时间未知');
      if (it.comments) meta.push(it.comments + ' 评论');
      if (it.points) meta.push(it.points + ' 赞');
      const snip = it.text ? h('p', { class: 'snip' }, it.text) : null;
      const el = h('article', { class: 'ev', id: 'ev-' + it.id },
        h('div', { class: 'ev-head' }, h('span', { class: 'ev-id' }, '[' + it.id + ']'), chip(C.TYPE_ZH[it.type] || it.type, TYPE_CHIP[it.type]),
          it.rel === 'related' ? chip('同产品，不同问题') : null),
        link(it.url, it.title, 'ev-title'),
        h('p', { class: 'meta' }, meta.filter(Boolean).join(' · ')),
        snip);
      if (snip && it.text.length > 90) {
        const btn = h('button', { class: 'more', type: 'button', onclick: () => { const open = snip.classList.toggle('open'); btn.textContent = open ? '收起' : '展开'; } }, '展开');
        el.append(btn);
      }
      if (it.similar && it.similar.length) {
        const d = h('details', null, h('summary', null, '另有 ' + it.similar.length + ' 条相似'));
        d.append(h('ul', { class: 'sim' }, it.similar.map((x) => h('li', null, x.restate ? '转述：' : '', link(x.url, x.title || x.url), ' · ' + (x.host || '')))));
        el.append(d);
      }
      s.append(el);
    });
    box.append(s);
  }

  function renderExcluded(box, st) {
    const by = st.stats.byReasonAll || {};
    const n = st.stats.excluded || 0;
    if (!n) return;
    const s = h('section', { class: 'card excl' });
    const parts = Object.keys(by).map((k) => (C.REASON[k] || k) + ' ' + by[k]);
    const d = h('details', null, h('summary', null, '已排除 ' + n + ' 条 · 点开核对'));
    d.append(h('p', { class: 'hint' }, parts.join('；')));
    if (st.excluded && st.excluded.length) {
      const list = st.excluded.filter((e) => e.reason !== 'dup').slice(0, 80);
      d.append(h('ul', { class: 'excl-list' }, list.map((e) => h('li', null, link(e.url, e.title || e.url), h('span', { class: 'why' }, ' · ' + (C.REASON[e.reason] || e.reason) + (e.host ? ' · ' + e.host : ''))))));
      if (by.dup) d.append(h('p', { class: 'hint' }, '「同一链接」的 ' + by.dup + ' 条是多条查询搜到了同一页，不逐条列出。'));
    } else d.append(h('p', { class: 'hint' }, '历史记录里只保留了数量，没有保留被排除的条目。'));
    s.append(d); box.append(s);
  }

  function render(st) {
    const box = $('result');
    box.replaceChildren();
    if (!st.stats.byReasonAll) {
      st.stats.byReasonAll = (st.excluded || []).reduce((m, e) => { m[e.reason] = (m[e.reason] || 0) + 1; return m; }, {});
    }
    (st.notices || []).forEach((n) => box.append(h('p', { class: 'notice' }, n)));
    if (st.report) renderReport(box, st.report);
    const ls = section('一键直达');
    ls.append(h('p', { class: 'hint', style: 'margin:0 0 8px' }, 'Reddit 和 X 不让页面抓取，点开看最新帖子。'));
    ls.append(h('div', { class: 'links' }, (st.links || []).map((l) => link(l.url, l.name))));
    box.append(ls);
    renderEvidence(box, st);
    renderExcluded(box, st);
    box.append(h('p', { class: 'usage' }, '查询于 ' + C.fmtLocal(st.t, tzMin()) + ' · 时间范围 ' + (st.hours >= 48 ? st.hours / 24 + ' 天' : st.hours + ' 小时') +
      (st.usage && (st.usage.search || st.usage.tokens) ? ' · 搜索 ' + st.usage.search + ' 次 · 模型 ' + st.usage.tokens + ' tokens' : '')));
    box.hidden = false;
  }

  /* ---------- 历史 ---------- */
  function slim(st) {
    return {
      t: st.t, desc: st.desc, hours: st.hours, product: st.product, report: st.report, links: st.links, usage: st.usage, notices: st.notices,
      stats: st.stats,
      kept: st.kept.map((it) => ({ id: it.id, type: it.type, src: it.src, title: it.title, url: it.url, host: it.host, ts: it.ts, text: C.clip(it.text, 300), similar: it.similar, comments: it.comments, points: it.points, rel: it.rel })),
    };
  }
  function saveHistory(st) {
    const list = store.get(LS.hist, []);
    list.unshift(slim(st));
    while (list.length > 8) list.pop();
    while (!store.set(LS.hist, list) && list.length > 1) list.pop();
    renderHistory();
  }
  function renderHistory() {
    const list = store.get(LS.hist, []);
    const box = $('history');
    box.replaceChildren();
    if (!list.length) return;
    const s = section('查过的');
    s.append(h('ul', { class: 'hist' }, list.map((st) => {
      const v = st.report ? (VERDICT[st.report.verdict] || VERDICT.insufficient)[0] : '未归纳';
      return h('li', null, h('button', { type: 'button', onclick: () => { $('progress').hidden = true; render(st); $('result').scrollIntoView({ behavior: 'smooth' }); } },
        h('span', { class: 'd' }, st.desc || st.product), h('span', { class: 'm' }, C.fmtLocal(st.t, tzMin()) + ' · ' + v)));
    })));
    box.append(s);
  }

  /* ---------- 设置 ---------- */
  function updateHint() {
    $('modeHint').textContent = cfg.key ? '' : '还没填 DeepSeek key：现在只能抓取和过滤，没有结论。点右上角「设置」填写。';
  }
  function openSettings() {
    $('sKey').value = cfg.key; $('sBase').value = cfg.base; $('sModel').value = cfg.model; $('sThink').checked = !!cfg.think;
    $('sTestOut').replaceChildren();
    const d = $('dlg');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function saveSettings() {
    cfg.key = $('sKey').value.trim();
    cfg.base = baseUrl($('sBase').value) || DEFAULTS.base;
    cfg.model = $('sModel').value || DEFAULTS.model;
    cfg.think = $('sThink').checked;
    if (!store.set(LS.cfg, cfg)) alertText('浏览器不允许保存设置（可能是无痕模式），这次打开期间仍然有效。');
    updateHint();
  }
  function alertText(t) { const box = $('result'); box.prepend(h('p', { class: 'notice' }, t)); box.hidden = false; }

  async function selfTest() {
    const out = $('sTestOut');
    out.replaceChildren();
    const key = $('sKey').value.trim(), b = baseUrl($('sBase').value), model = $('sModel').value;
    const row = (label) => {
      const ic = h('span', { class: 'ic' }, ICON.run), note = h('span', { class: 'note' });
      const li = h('li', { class: 'st-run' }, ic, h('div', null, label, ' ', note));
      out.append(li);
      return (state, text) => { li.className = 'st-' + state; ic.textContent = ICON[state]; note.textContent = text || ''; };
    };
    const check = (label, fn, skip) => {
      const set = row(label);
      if (skip) { set('skip', skip); return Promise.resolve(); }
      return fn().then((t) => set('ok', t || '可用')).catch((e) => set('fail', e.message));
    };
    $('sTest').disabled = true;
    await Promise.all([
      check('DeepSeek 模型', () => req(b + '/chat/completions', { method: 'POST', headers: auth(key), body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, thinking: { type: 'disabled' } }) }, 30000).then(() => '可用'), key ? '' : '没填 key'),
      check('DeepSeek 搜索', () => req(b + '/v1/tools/search', { method: 'POST', headers: auth(key), body: JSON.stringify({ query: 'status', count: 1 }) }, 25000).then(() => '可用'), key ? '' : '没填 key'),
      check('GitHub', () => req('https://api.github.com/search/issues?q=' + encodeURIComponent('is:issue repo:anthropics/claude-code') + '&per_page=1').then(() => '可用')),
      check('Hacker News', () => req('https://hn.algolia.com/api/v1/search_by_date?query=status&hitsPerPage=1').then(() => '可用')),
      check('官方状态页（以 Claude 为例）', () => req('https://status.claude.com/api/v2/status.json').then((d) => (d.status && d.status.description) || '可用')),
    ]);
    $('sTest').disabled = false;
  }

  /* ---------- 启动 ---------- */
  function init() {
    $('win').value = String(cfg.win || 48);
    updateHint();
    renderHistory();
    $('go').addEventListener('click', run);
    $('desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });
    $('btnSet').addEventListener('click', openSettings);
    $('sTest').addEventListener('click', selfTest);
    $('sCancel').addEventListener('click', () => $('dlg').close('cancel'));
    $('sClear').addEventListener('click', () => { store.set(LS.hist, []); renderHistory(); $('sTestOut').replaceChildren(h('li', { class: 'st-ok' }, h('span', { class: 'ic' }, ICON.ok), h('div', null, '历史已清空'))); });
    $('dlg').addEventListener('close', () => { if ($('dlg').returnValue === 'save') saveSettings(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
