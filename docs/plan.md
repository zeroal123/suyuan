# 故障溯源 · 独立网页 实现计划

**目标**：一个不依赖 Claude 的单文件静态网页。输入一句情况描述，输出「原因 / 时间线 / 其他人的情况 / 现在能做什么」，并附可核对的证据。

**架构**：纯前端，无后端。`core.js` 放全部可测的纯逻辑（查询生成、去重、过滤、打分、结论校验），`app.js` 只管网络请求和界面。构建脚本把三份源码内联成一个 `index.html`，直接放 GitHub Pages。

**技术栈**：原生 JS / CSS，DeepSeek Chat + Search API，GitHub Search API，HN Algolia API，Statuspage v2 API。测试用 node:test 和 Playwright。

## 文件

| 文件 | 职责 |
|---|---|
| `src/core.js` | 纯函数：URL 归一、分词、相似度、来源分类、查询生成、过滤去重、JSON 提取、结论校验 |
| `src/app.js` | 设置、网络请求、流程编排、渲染、历史 |
| `src/style.css` | 移动端优先的样式，跟随系统深浅色 |
| `src/template.html` | 页面骨架 |
| `build.py` | 内联生成 `dist/index.html` |
| `test/core.test.js` | 纯逻辑单元测试 |
| `test/e2e.mjs` | Playwright：拦截全部网络请求，跑完整流程并截图 |

## 流程

1. 拆解：有 key 时由模型输出结构化字段；无 key 时用内置词表做启发式拆解。
2. 搜索：十余条细分查询并行（综合、故障词、Reddit、X、报错原文、官方通告、官方变更、中文、中文社区、上游故障），加 GitHub、HN、官方状态页。
3. 机械清洗：同链接合并 → 时间窗 → 产品/症状相关性 → 聚合站限量 → 相似标题归组 → 按分数截断。每条被排除的都带原因。
4. 语义筛选与归纳：模型逐条标注（同一件事 / 相关 / 无关 / 转述自哪条），再给出带编号依据的结论。
5. 代码校验：依据编号必须存在；没有官方依据且独立来源不足时，自动下调把握程度。

## 任务

- [x] 1 核实接口（DeepSeek 模型名、Search 端点与字段、GitHub 查询必须带 is:issue）
- [x] 2 `core.js` 测试先行，再实现
- [x] 3 `app.js`、样式、骨架
- [x] 4 构建并做端到端测试（有 key / 无 key 两条路径）
- [x] 5 Claude 技能
- [x] 6 用今天的 Claude 故障验证
