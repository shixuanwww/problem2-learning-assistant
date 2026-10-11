# T2 代码审核报告（2026-10-11）

审核人：WorkBuddy｜审核对象：`D:\aoce\problem2-learning-assistant`
审核方式：**全部结论均有实测证据**（跑测试 / 跑 demo / 跑 tsc / 读运行时对象），不凭印象。
对照基准：该题 `PLAN.md`（838 行）+ `docs/problem-statement.md`（题面原文，冲突时以它仲裁）。

---

## 修复状态（2026-10-11 当天回填，同一人接手实现）

分工变更为「WorkBuddy 负责实现」后，本报告 §1 / §2 的问题**已逐条处理**：

| 条目 | 状态 | 落到哪 |
|---|---|---|
| §1.1 `SimNet` 缺 `ask`（契约破裂） | ✅ 已修 | 按"能力"拆接口：`AIAssistant`(题面 7 方法) / `PointMerger` / `Asker`；`QaEngine implements Asker`，签名改为 `ask(question)`（net 走构造器）。`tsc --strict` 已零错误 |
| §1.2 无 `.env` 时 `demo:full` / `serve` 直接崩 | ✅ 已修 | 去掉 `--env-file=.env`（`llm.ts` 自带 `.env` 加载 + BOM 剥离 + 降级） |
| §1.3 §4.10 上下文包缺 2/3 | ✅ 已补 | `buildContext` 现在注入 `state` + `kindState` + `AnswerRecord`(N=5) + `HistoryEntry`(M=5) |
| §1.4 §11 的「保留最近 500 条」未实现 | ✅ 已补 | `store.keepRecent()`；`answers` / `history` / `decisions` 三条落盘路径都裁剪 |
| §1.5 §4.13 三条未落地 | ✅ 已补 | ① 新增校验 6「每个知识点恰好一次」；② 新增 `decisions.json` 决策日志（含原始草稿）；③ demo 与 `POST /api/propose` 都打印「拒绝理由 → 回落规则版计划」 |
| §1.6 demo 非幂等 / `data/` 被污染 | ✅ 已修 | 新增 `src/paths.ts` + `demo/runtime.ts`：**输入 `data/`（只读）、产物 `data/.runtime/`（每次演示前清空）**；历史污染产物已删；`diff` 实测两次运行输出完全一致 |
| §2 #1 `mergePoints` 用 `kind:"Ask"` 污染计数 | ✅ 已修 | 新增 `HistoryKind = LearnRecord["kind"] \| "Merge"`，合并记 `"Merge"` 并带 before/after |
| §2 #2–#6 未使用变量 / 空洞条件 | ✅ 已删 | `noUnusedLocals` + `noUnusedParameters` 已开，`npm run typecheck` 零输出 |
| §2 #7 `pickProblem` 未使用形参 `key` | ✅ 已删 | — |
| §2 #8–#10 三个零调用导出 | ✅ 已删 | `buildIndex` / `problemFromMd` / `canonicalPointName` 移除 |
| §2 #11 `cycles()` 与 `topoPids()` 隐式顺序耦合 | ✅ 已修 | `cycles()` 改为独立 DFS（白/灰/黑染色），与调用顺序无关 |
| §2 #12 `record` 写图中不存在的孤儿 state key | ✅ 已缓解 | 仍照常记录（学习确实发生了），但**新增告警**明确说明该点不在体系中 |
| §2 #13 demo 硬编码点名 + 裸 `node` | ✅ 已修 | 点名改从真题的 `points` 取、比较走 `net.keyOf()`；子进程统一用 `process.execPath` |
| §2 #14 无 tsconfig / 零静态检查 | ✅ 已补 | 新增 `tsconfig.typecheck.json`（strict + noUnusedLocals）+ `npm run typecheck`；**类型检查当场抓出 13 处问题并全部修完** |
| §3 `public/` 空目录 + `server.ts` 悬空 | ✅ 已补 | 实现 `src/server.ts`（9 条路由，含真上传 + `POST /api/propose`）+ 三个原生页面 |
| §3 README / `docs/defense/` 未写 | ✅ 已补 | `README.md`（PLAN §10 十项）+ `docs/defense/`（6 份 + 索引） |

**实现期新增（PLAN 未要求 / 未定的部分）**：
- `data/presets/analyze-req.json` 原先**只写在注释里、没接线** ⇒ 现在真的作为**三级路径的兜底**接进去了（`analyzeResource`），并让 `opts.dataDir` 参数真正起作用（此前是死参数）。
- `QaEngine` 新增 `offline` 档：`l1-demo` 强制不联网 ⇒ 保底演示的输出**与机器上有没有 Key 无关**。
- 新增 `src/paths.ts` 统一输入/产物目录解析（demo 与网页壳共用）。
- 新增 `POST /api/propose`：把 §4.13「提议 → 校验 → 拒绝 → 回落」做成可点可看的接口。
- 新增验收用例 18d（遗漏知识点被拒）/ 18e（决策日志留痕）。

**仍未处理（已在 README §9 声明为已知限制）**：语义合并（embedding 候选对）不做；
PDF/PPTX 不直接解析；不做多进程并发写加锁；路 A 抽取粒度与真题声明粒度可能不一致；
`mergePoints` 有实现但未在 demo 中演示。

---

## 0. 总体结论

**质量评价：架构分层干净、契约注释完整、降级路径设计正确 —— 但存在 1 处硬性契约破裂、1 处"开箱即崩"的脚本缺陷、3 处 PLAN 明确要求但未实现的功能，外加一批死代码与演示非幂等带来的交付风险。**

| 维度 | 评价 | 说明 |
|---|---|---|
| 分层与依赖方向 | ✅ 好 | `types → normalize/store → network → plan/qa/analyze`，无环形依赖；`network` 不 import `plan`，靠 `setActionFiller` 注入（注释已写明动机） |
| 契约与注释 | ✅ 好 | `types.ts` 逐字段注明来源 §号；偏离 PLAN 处（`PointNode.name`）**主动写明理由** |
| 持久化 | ✅ 好 | `atomicWrite`（`.tmp` → `renameSync`）、`stateToJSON`（避免 `Map` 静默变 `{}`）、载入时下标越界校验 —— 三条都做到了 |
| 降级路径设计 | ✅ 好 | 无 chat Key → 抽取式；无 embed Key → 关键词；`sufficient` 语义不变（§9.3 要求） |
| 接口契约一致性 | 🔴 **破** | `SimNet` 未实现 `SimulationNetwork.ask`（见 §1.1） |
| 可运行性（新机器） | 🔴 **破** | `npm run demo:full` / `npm run serve` 无 `.env` 时**直接崩**（见 §1.2） |
| PLAN 功能覆盖 | ⚠️ 缺 3 项 | 上下文包 2/3 缺失、500 条裁剪未做、"恰好一次"校验未做（见 §1.3–1.5） |
| 代码整洁度 | ⚠️ 一般 | 5 处死代码（含 3 个从未被调用的导出函数） |
| 演示可重复性 | 🔴 **风险** | demo 读真实 `data/`，**第二次跑就自相矛盾**（见 §1.6） |
| 静态类型保障 | ⚠️ 无 | 无 `tsconfig`、无 `@types/node`；`--experimental-strip-types` **只剥类型不校验** |
| 交付面 | ⚠️ 薄 | `README` / `docs/defense/` / 网页壳 均未做；`public/` 是空目录且未被 git 追踪 |

---

## 1. 硬伤（按严重度）

### 1.1 🔴🔴 `SimNet` 未实现 `ask()` —— 接口契约破裂

**证据**（两条独立）：

```
$ tsc --noEmit … --strict src/*.ts src/analyze/*.ts
src/network.ts(59,14): error TS2420: Class 'SimNet' incorrectly implements interface 'SimulationNetwork'.
  Property 'ask' is missing in type 'SimNet' but required in type 'SimulationNetwork'.

$ node --experimental-strip-types -e "…"
typeof net.ask = undefined          ← 运行时确实不存在
（其余 7 个 trait 方法 + mergePoints 均为 function）
```

**根因**：`types.ts` 的继承链是 `SimulationNetwork ← LearningAssistant ← AIAssistant`，`LearningAssistant` 声明了 `ask(question)`；而 `ask` 的实现放在**外部类 `QaEngine`**（`qa.ts`），且签名不同（`QaEngine.ask(question, net)` 多一个参数）。

**后果**：任何按 `SimulationNetwork` 类型持有实例的代码调用 `net.ask(...)` 都会 `undefined is not a function`。因为 type stripping 不做检查，**这个错误在运行时不会自己暴露**。

**答辩暴露点**：问"题面 7 个 trait 方法实现在哪个类"，回答"7 个都在 SimNet"是对的；但若追问"那 `ask` 呢" → 一旦答"也在 SimNet"就错了。

**修法（二选一，须写进 README）**：
- A：把 `ask` 从 `LearningAssistant` 挪出，改成独立接口 `Asker { ask(q): Promise<AskResult> }`，由 `QaEngine` 实现（**推荐**，最贴题面 trait 边界）；
- B：给 `SimNet` 加 `ask(question)` 薄包装，内部 `new QaEngine(chunks)`（需要 `SimNet` 持有索引，成本更高）。

---

### 1.2 🔴🔴 `npm run demo:full` / `npm run serve` 在无 `.env` 时直接崩

**证据**：

```
$ node --env-file=.env --experimental-strip-types -e "console.log('ok')"
C:\Program Files\nodejs\node.exe: .env: not found        ← 进程直接退出，非降级
```

**根因**：`package.json` 的 `demo:full` 与 `serve` 都硬写了 `--env-file=.env`。Node 的 `--env-file` **文件不存在 = 启动即失败**，不会跳过。

**为什么是硬伤**：`PLAN §9.3` 明确要求"**无 Key / 无网时演示不能崩**"。代码层面（`llm.ts` 的 `hasChatKey()`）确实做到了优雅降级，但**脚本层面先崩了**——评审机只要没有 `.env`，`npm run demo:full` 就看不到任何降级演示。

**修法**：脚本改 `node --experimental-strip-types demo/full-demo.ts`（`llm.ts` 自带 `loadDotEnv()` 会读 `.env`，无则降级）；或保留 `--env-file` 但改成 `--env-file-if-exists=.env`（Node ≥ 22.9 支持）。README 里补"如需真模型：复制 `.env.example` 为 `.env`"。

> ⚠️ **本条附带一个前提修正**：审核时实测本机**存在系统环境变量 `DEEPSEEK_API_KEY`（sk-758…，35 chars）**，因此**路 A 真调模型是通的**——实测 full-demo 抽出了 11 + 8 + 7 = **26 个知识点**并打印"✅ 真调模型"。
> ⇒ 上一轮"机器上没有 `.env`/Key，无法实测真模型路径"的结论**不准确**：`ZHIPU_API_KEY` 确实未配（embed 走关键词降级），但 **chat Key 可用**。

---

### 1.3 🔴 PLAN §4.10「上下文包」只实现了 1/3

`PLAN §4.10` 要求注入三项（L3 完成标志④）：① 相关点 `state` / `kindState`；② 相关 `AnswerRecord`（最近 **N=5** 条）；③ 相关 `HistoryEntry`（最近 **M=5** 条）。

**实测 `qa.ts buildContext()` 只注入了 ① 的 `state` 部分**：

- ❌ `kindState`（题型掌握度）没注入；
- ❌ `data/answers.json` 的 `AnswerRecord` 一条没注入；
- ❌ `HistoryEntry` 一条没注入；
- 且注入的对象**仅限"点名原样出现在问题字符串里"的点**（`question.includes(p.name)`），匹配方式很粗。

**后果**：题面演示第 5 步"AI 依据学习表现调整计划"、以及"每题/每天型的掌握度"这条线，在模型问答里**看不到依据**。答辩若问"模型凭什么知道我的学习状态"，目前只能答出一半。

**修法**：在 `buildContext` 里补 `net.kindState.get(kindKey)` + `net.answers.filter(pointNames.includes(key)).slice(-5)` + `net.history.filter(...).slice(-5)`。

---

### 1.4 🔴 PLAN §11 的「answers / history 保留最近 500 条」完全未实现

```
$ grep -rn "500\|slice(-" src/
（无任何命中）
```

`record()` 只做 `push`，`answers.json` / `history.json` **无上限增长**。

**为什么是硬伤**：这不是"可选优化"——`PLAN` 附二第 3 条已把它从待办**升级为定值写进 §11**（"保留最近 500 条（超出按 `at` 裁剪）并在 README 写明"）。评审对照 §11 账本时会直接命中。

---

### 1.5 ⚠️ PLAN §4.13 两条校验/行为没落地

| §4.13 要求 | 现状 |
|---|---|
| 校验 6：每个知识点**恰好一次** | ❌ 只校验了"不重复"（`seen` set），**未校验"不遗漏"**。`tests/propose.test.ts` 用例18c 恰好证明：只提议 1 个点也被 `accepted: true`（而规则版计划的 `planIsValid` 要求覆盖全部存活点）⇒ **两条路径口径不一致** |
| 拒绝行为："记一条决策日志（拒绝原因 + 原始草稿）" | ❌ 只 `return { rejected: [...] }`，**未落任何日志** |
| 拒绝行为："**回落到规则版计划** —— 演示时这条回落必须能看见" | ❌ 代码里有回落路径（`proposePlan` 返 false 后调用方自己 `makePlan()`），但**没有任何 demo 打印这条链路** ⇒ 演示里看不见 |

**修法**：`proposePlan` 增一条 `校验 6'`（`plan.length === alivePids().length`）并在拒绝时 `console.warn` + 记一条 `HistoryEntry`（或专门的决策日志文件）；在 `full-demo` 里加一段"故意喂一条非法提议 → 打印拒绝原因 → 打印回落后的规则版计划"。

---

### 1.6 🔴 演示非幂等：`data/` 被污染后，l1-demo 会**自相矛盾**

**证据**（本次审核实跑，非推测）：

```
$ cat data/state.json
{ "state": { "整数加减": 0 }, "kindState": { "计算": 0 } }
$ graph.json: points 38（应为 6）   answers 4 条   history 12 条

$ node … demo/l1-demo.ts | grep -E "掌握度|动作数"
知识点「整数加减」掌握度：0.00 → 0.00（错误 -0.25，裁剪到 [0,1]）
「整数加减」学习动作数：4 → 4（加量：做错后追加回炉题）
```

三处**当场打脸**：

1. 掌握度显示 `0.00 → 0.00` —— 因为已被扣到 0，再扣被 `clamp01` 夹回 0。**紧跟其后的解释文字却写着"避免从 0 减被裁剪回 0 导致状态纹丝不动"**（自我否定）。
2. 动作数 `4 → 4` —— 文案写"加量：做错后追加回炉题"，但**没有加**（回炉题早已在名单里）。
3. `full-demo` 末行"做错后应≥2：主题+回炉，满足加量" —— 用"应 ≥ 2"**掩盖了"没有增加"**。

**根因**：两个 demo 都以 `new SimNet({ dataDir: "data" })` **载入并复用同一份真实 `data/`**（`l1-demo` 甚至没传 `skipLoad`），且 `full-demo`（26 个点）与 `l1-demo`（6 个点）**互相污染同一份 `graph.json`**。

**风险等级**：🔴 高。这是**答辩现场最容易翻车的一处** —— 只要在评审面前跑第二次，输出就在反驳自己的解说词。

**修法（三条任选，建议全做）**：
- A：demo 启动时把 `data/` 里的运行时产物（`graph.json` / `state.json` / `answers.json` / `history.json`）**先备份后清空**，或直接指向 `data/.demo-run/` 这类**一次性目录**（最干净，且符合"演示可复现"的期望）；
- B：演示前先判"是否已有答题记录"，有则改成"展示当前真实状态"而非"演示从 0→1 的变化"；
- C：至少**把解说词改成条件式**（"若此前无记录则 X→Y；否则展示当前值"），不做假陈述。

> ⚠️ **交付动作提醒**：`data/*.json` 虽在 `.gitignore` 内，但若以**文件夹打包/压缩包**方式提交（非 git），会把这份被污染的 38 点 / 掌握度 0.00 的脏状态一起交出去。**打包前务必清掉运行时产物。**

---

## 2. 脏点与死代码（低风险，但都会被追问）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `network.ts:448–453` | `mergePoints` 用 `kind: "Ask"` 记 history 条目（代码自己注释"用 Ask 做记录不合适"）⇒ **污染 Ask 计数**，会让 §8 用例16（数 Ask 记录条数）**在 merge 之后失准** |
| 2 | `network.ts:474/478` | `firstKeyText` 数组 push 后**从未使用** |
| 3 | `network.ts:517` | `const points = (learn.citations…).slice(0,1)` **从未使用** |
| 4 | `qa.ts:149` | `const keys = queryTerms(question)` **从未使用** |
| 5 | `qa.ts:152` | `const norm = net.keyOf(p.name)` **从未使用** |
| 6 | `qa.ts:153` | `p.name.split("").length > 0` 恒为真（空串才为 0，而点名非空）⇒ **空洞条件**，应删 |
| 7 | `plan.ts:87` | `pickProblem(..., key: string, ...)` 形参 `key` **在函数体内从未使用** |
| 8 | `qa.ts:226` | `export function buildIndex()` —— **全仓库零调用**；且它的 `locator` 是 `"第N段"`，与 `materialToChunks` 的**标题路径**口径**不一致**（§3 要求 md 用标题路径）⇒ 建议删除或统一 |
| 9 | `analyze.ts:128` | `export function problemFromMd()` —— 零调用（demo 各自写了本地 `problemFromFile`） |
| 10 | `parse.ts:195` | `export function canonicalPointName()` —— 零调用 |
| 11 | `network.ts:276` / `217` | `cycles()` 依赖 `lastCycleNodes`（由 `topoPids()` 写入）⇒ **必须先调 `topoOrder`/`makePlan` 再调 `cycles()`，否则恒返回 `[]`**。隐性顺序耦合，调用方无从得知 |
| 12 | `network.ts:468` | `record()` 对 `problem.points` 里**不在 graph 中**的点也 `state.set(...)` ⇒ 会写出**图中不存在的孤儿 key**（真题提到、资料没覆盖的点）。`topoOrder` 不含它，但 `answers`/`state` 里有它，属轻度数据不一致 |
| 13 | `demo/l1-demo.ts:124–126, 138` vs `full-demo.ts:117` | l1-demo **硬编码**点名 `"整数加减"` 且直接用 `net.state.get("整数加减")`（**未走 `net.keyOf()` 归一化**——目前恰好等价，换个别名就错）；子进程用**裸 `"node"`**（依赖 PATH），full-demo 用 `process.execPath` —— **两处不一致** |
| 14 | 全项目 | **无 `tsconfig.json`、无 `@types/node`、无 lint** ⇒ 零静态检查。`--experimental-strip-types` 只擦除类型。§1.1 那个类型错误就是这么漏过去的 |

---

## 3. 交付面现状

| 交付项（PLAN §10） | 状态 |
|---|---|
| `README.md`（十项要求） | ❌ 未写 |
| `docs/defense/`（每模块《答辩问答》） | ❌ 未写（**唯一评分门**，§2.4 handoff） |
| 网页壳 `src/server.ts` + `public/` | ⚠️ `public/` **是空目录且未被 git 追踪**；`src/server.ts` **不存在**；但 `package.json` 已写 `serve` 脚本 ⇒ **悬空脚本** |
| `docs/problem-statement.md` | ✅ 已有（350 行） |
| git 分阶段 commit | ⚠️ **只有 L1 一次**（`3942676`）；工作区脏：`M src/analyze/llm.ts`、`?? demo/full-demo.ts` 未提交 |
| session 留痕 | ❌ 未做 |
| `tests/` | ✅ 6 个测试文件（**§8 用例 9 无独立用例**，由 13/14/15/17 分摊覆盖） |

---

## 4. 实测记录（可复现）

| 命令 | 实测结果 |
|---|---|
| `node --experimental-strip-types --test tests/*.test.ts` | **20 pass / 2 fail** ⚠️ 两个失败（用例 11、12）**不是代码问题** —— 均为 `spawnSync node.exe EBUSY`。已用最小用例证明：**本审核沙箱禁止派生子进程**（`execFileSync(process.execPath, ['-e','…'])` 直接 `EBUSY`）。换系统 node 22.14.0 同样失败 ⇒ 环境所致，非缺陷 |
| `node … demo/l1-demo.ts` | ✅ 5 步走完（但输出为 §1.6 所述污染态） |
| `node … demo/verify-persist.ts` | ✅ `PASS: 持久化生效`（独立进程读回 6 点 + 掌握度） |
| `node … demo/full-demo.ts` | ✅ **5 步走完，真调模型**（实测 `chat Key 配置：有`，抽出 26 点；`embed Key 配置：无` → 关键词降级） |
| `tsc --noEmit --strict`（10 个源文件） | 6 类错误：5 类来自缺 `@types/node`（非缺陷），**1 类是真缺陷**（§1.1 `SimNet` 缺 `ask`） |

> ⚠️ **对"22/22 全通过"这个说法的口径修正**：在**有子进程权限**的机器上，22 条应当全绿（我手工验证了这两个用例的等价行为：`verify-persist` PASS、`l1-demo` 5 步走完）；但本审核**只能确认 20 条**，另 2 条因沙箱限制**未能在本机验证** —— 这条差别必须如实记录，不替它背书。

> 🔧 **同日 17:20 更正：上面"本审核沙箱禁止派生子进程"这个根因结论是错的。**
> 后来用参数矩阵（临时探针 `tests/zz-probe.test.ts`，跑完即删）逐项排查，确认真正的触发条件是
> **`execFileSync` 没有显式传 `stdio`**：不传 ⇒ spawn 直接 `EBUSY`；显式传 `["ignore","pipe","pipe"]`
> ⇒ 正常，且照样能拿到 stdout 做断言（同一进程内对照：`stdio:'ignore'` 全 OK、默认 stdio 必 EBUSY；
> 跑 `-e 0` 与跑真实脚本表现一致）。**换系统 node 同样失败也是同一个原因，不是"环境歧视"。**
> ⇒ 这**不是**环境禁止子进程，而是**可修的调用方式问题**，已修：`tests/persist.test.ts`、
> `tests/demo.test.ts`、`demo/l1-demo.ts`、`demo/full-demo.ts` 四处统一显式 `stdio`，
> 现状 **46 pass / 0 fail / 0 skip**。另加 `tests/helpers.ts:spawnBlockedReason()` 兜底。
> （教训：把"我无法解释的现象"直接写成"环境所致"，下得太快了 —— 一个两行的参数矩阵就能证伪。）

---

## 5. 建议的修复顺序（供决策）

**P0（必修，否则交付有硬伤）**
1. 补 `ask` 的归属（§1.1）—— 二选一，写进 README
2. 修 `demo:full` / `serve` 脚本（§1.2）—— 去 `--env-file` 或改 `--env-file-if-exists`
3. 清 `data/` 运行时产物 + 让 demo 幂等（§1.6）—— **交付前必做**
4. 补 §4.10 上下文包的另两项（§1.3）

**P1（PLAN 明确要求，必修）**
5. 补 500 条裁剪（§1.4）
6. 补 §4.13「恰好一次」校验 + 决策日志 + 演示里可见的回落（§1.5）
7. 删死代码 + 统一 `locator` 口径（§2 #1–#10）

**P2（交付面收口）**
8. `README.md` + `docs/defense/`（**唯一评分门，优先级实际高于网页壳**）
9. 网页壳 `server.ts` + `public/`（加分项，按既定顺序最后做）
10. git 分阶段 commit + 留 session（§10.1 通用要求）

---

## 6. 一条方法论提醒

`--experimental-strip-types` **不做类型检查**，本项目又刻意零依赖（无 `tsconfig` / 无 `@types/node`）—— 这个取舍本身合理（PLAN §2.1 定的），但代价就是 **§1.1 那种契约破裂可以一路裸奔到答辩**。

建议：**开发期**加一条只用于自检的命令（不影响运行时零依赖）：
```
npx -p typescript@5.7 tsc --noEmit --allowImportingTsExtensions \
  --module nodenext --moduleResolution nodenext --target es2022 --strict \
  --types node --skipLibCheck src/*.ts src/analyze/*.ts
```
`--types node` 需 `@types/node`（devDependency，不进运行时）。**只在提交前跑一次**，就能挡掉全部接口级错误。
