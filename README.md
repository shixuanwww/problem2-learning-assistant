# AI 学习辅助系统（题 2 实现）

> **一句话定位**：把散落的课程资料与历年真题，自动整理成一张**带前置关系的知识点网络**；
> 再基于这张网络生成**学习计划**、做**带出处的问答**、并从**做题记录**更新掌握度、
> 反过来调整后续计划 —— 一个"资料 → 知识体系 → 学习行为 → 反馈"的闭环。

**技术栈**：TypeScript + Node 22 `--experimental-strip-types`，**运行时零第三方依赖**（无框架、无 dotenv、无构建步骤）。
数据落盘用 JSON + 原子写；网页壳用原生 `node:http` + 原生 HTML/JS。

---

## 1. 启动方式

```bash
node --version        # ⚠ 先看这条：需要 Node ≥ 22.6（本项目用 Node 的"类型擦除"直接跑 .ts）
npm run demo          # ⭐ 保底演示：零依赖、离线可跑、确定性输出，走完题面 5 步
npm run demo:full     # 完整演示：模型抽取 + 带出处问答 + 模型提议计划（无 Key 自动降级）
npm run serve         # 网页壳（9 条 API + 3 个页面）→ http://127.0.0.1:8787
npm test              # 44 条验收用例（含网页壳端到端）
```

等价的手写命令（不想用 npm scripts 时）：

```bash
node --experimental-strip-types demo/l1-demo.ts      # 保底演示（零依赖、离线）
node --experimental-strip-types demo/full-demo.ts    # 完整演示（真调模型）
node --experimental-strip-types src/server.ts        # 打开 http://127.0.0.1:8787
```

> 🔧 **`npm run *` 都经过 `bin/run.mjs`**：它按 Node 版本选调用方式（22.6–23.5 加 `--experimental-strip-types`，
> ≥23.6 直接跑），版本不够时**给出照做就能跑的 nvm / Docker 命令**，而不是丢一句
> `bad option: --experimental-strip-types`。Node 20/18 上可以直接用：
> `docker run --rm -v "$PWD:/app" -w /app node:22 node --experimental-strip-types demo/l1-demo.ts`
> （Windows PowerShell 把 `"$PWD:/app"` 换成 `"${PWD}:/app"`）。
> ⚠️ 所有命令都请在**仓库根目录**执行（`data/` 与 `.env` 都按当前目录解析）。

> ⚠️ **不要用 `node --env-file=.env …`**：`.env` 不存在时 Node 会**直接退出**（`Error: .env: not found`），
> 那样就谈不上"无 Key 优雅降级"了。本项目由 `src/analyze/llm.ts` **自己**读仓库根的 `.env`
> （会剥 BOM；已存在的真实环境变量优先），没有 `.env` 就自动降级，**不崩**。
> 想接真模型：`cp .env.example .env` 后填 Key。

其他命令：

```bash
npm run demo:persist                                     # 另起进程读回持久化数据（证明真落盘）
npm install && npm run typecheck                         # 可选：开发期静态类型自检（见 §9）
```

---

## 2. 目录结构

```
src/
  types.ts            契约：题面 trait 的 7 个方法 + 全部数据结构 + 默认值账本
  normalize.ts        名称归一化（trim / 全角转半角 / 去空白与连接符 / 小写）+ 别名表
  store.ts            JSON 持久化：原子写、保留最近 500 条、state Map←→JSON
  network.ts          SimNet：integrate / makePlan / pointRank / queryPoint / record
                      / mergePoints / 拓扑排序 / 环检测 / graph.json 序列化
  plan.ts             makePlan 的动作填充（§4.7 规则）+ 模型提议通道 proposePlan（校验/拒绝/回落）
  qa.ts               QaEngine：检索（向量/关键词）→ 充足性判定 → 带出处回答 → 记录回填
  analyze/
    parse.ts          md 解析（标题切分 / 段落切分 / 路B 关系声明）
    schema.ts         手写 JSON 校验器（不引 ajv）
    llm.ts            模型调用（chat / embedding）+ 自带 .env 加载 + 无 Key 抛错
    analyze.ts        资料 / 真题 → 结构化分析结果的四级流水线（模型 → 声明 → presets → 如实失败）
  server.ts           网页壳（原生 node:http + 手写路由表）
demo/
  l1-demo.ts          保底演示（离线，强制不走网络）
  full-demo.ts        完整演示（真调模型）
  verify-persist.ts   跨进程读回持久化，证明"真落盘"
  runtime.ts          演示运行时目录（输入只读 / 产物可写，保证演示幂等）
public/               index.html（知识体系）/ ask.html（问答）/ learn.html（计划与记录）
tests/                §8 验收用例
data/
  materials/*.md      资料（输入）
  problems/*.prob.md  真题（输入）
  aliases.json        别名表（输入）
  presets/            兜底分析结果（输入）
  .runtime/           全部运行产物（gitignore，演示前清空）
docs/
  problem-statement.md  题面原文（逐字）
  defense/              每个模块的《答辩问答》
```

---

## 3. 主要设计

### 3.1 数据模型

```
Point        { name, pid? }                  知识点；name 归一化后是全局唯一键
Edge         [Point, Point]                  单向边 from → to：学 to 之前必须先学 from
PointNode    { name, prev: Point[], resources: Resource[], dead? }
PointGraph   PointNode[]                     下标即 pid（稳定不变，合并时也不位移）
Problem      { name, content, points, kind } 真题；kind 是【题型】，缺失记 "未分类"
State        Map<归一化名, number>            知识点掌握度 [0,1]
KindState    Map<题型, number>               题型掌握度 [0,1]
AnswerRecord { at, problemName, kind, status, pointNames }   结构化作答记录
HistoryEntry { at, kind, detail, pointNames, before, after } 学习行为留痕
DecisionEntry{ at, action, reasons, draft }  模型提议的接受/拒绝留痕（§4.13）
```

🔴 **两条容易踩的坑，本项目已处理**：
- **`Map` 不能直接 `JSON.stringify`**（会得到 `{}`，状态静默丢光）⇒ 一律走 `stateToJSON` / `stateFromJSON`；
- **`pid` 必须等于数组下标**，合并知识点时**不移动**其它点的 pid（只把被合并点标 `dead`）。

### 3.2 知识体系如何构建（`integrate`）

资料进来 = `analyzeRes(资源) → AnalyzeResReq{ resource, points, edges } → integrate`：

1. **入图前合并**：每个点名先过 `aliases.json` 别名表 → 再 `normalize()` → 得到 key；
   同一个 key **复用已有 pid**，不新建（幂等）。
2. 该资源记进 `PointNode.resources`（去重）。
3. 每条边 `[from, to]` 把 from 加进 to 的 `prev`（去重、去自环）。**端点若不在 points 里会隐式建点**
   —— 这是资料抽取的容错，**只适用于 edges 端点**。
4. 全部成功后**原子写** `graph.json`（写 `.tmp` 再 `renameSync`，中途 Ctrl+C 不留半截文件）。

真题进来 = `analyzePro(题目) → AnalyzeProReq → integrate`：

- 题目按 name 去重入 `problems`；**考频 `pointMention[pid]` 由"当前题目集"决定**：
  首次入库 +1；**重入库先扣掉该题旧考点的计数、再加上新考点的计数**
  ⇒ 既幂等（同一考点集合反复入库净变化为 0、不会把考频刷高），又不会与实际问题集脱节
  （修前只在首次入库 +1，重入库改了考点后考频还停在旧值，`pointRank` 会把没题覆盖的点排到第一）。
- **合并候选**：`mergeCandidates()` 按名字的字符二元组 Jaccard ≥ **0.6** 列出疑似同义点（只提示、
  **不自动合并**），网页壳在 `/api/graph` 里一并返回；人工确认后写进 `data/aliases.json`。

### 3.3 计划如何生成（`makePlan`）

1. **拓扑分层（Kahn）**：入度 0 的点构成第 1 层，剥离后新的入度 0 点构成下一层；
2. **层内按计划键升序**：

   ```
   (已掌握 ? 0 : 1, 掌握度, -考频, normalize(name) 的码点序)
   ```

   即：**没掌握的排前面 → 掌握度低的排前面 → 考频高的排前面 → 名字码点序**（最后一项是为了**确定性**，
   保证每次跑结果一致）。已掌握的点**排到最后**，因为它只需要"巩固"，不占学习主线
   （题面 L3 完成标志③"降低已掌握内容优先级"）。
3. **每个点填充学习动作**（§4.7 规则，`plan.ts`）：
   - 前置点未掌握 → 在本点动作序列**最前**补一个前置点的 Read（拿不到资料就补 Explain）；
     ⚠️ 若该资料与本点资料**是同一份**，只保留一条（修前会出现"读同一章节两遍"）；
   - 未掌握 → `读资料 → 讲解`，再 `做真题`；
   - 选"主"真题：先看**题型是否薄弱**（`kindState < 0.8` 的题型优先，题面 L3 完成标志③"薄弱题型训练"），
     再看覆盖本点的**考频最高**那道（排除回炉题），最后用题目名保证确定性；
   - 未掌握 → 再把**回炉题**（本题答错/糊涂过的真题，据 `answers.json`）各追加一道 ⇒ **动作数增加**；
   - 已掌握 → 只留一道巩固题。

> 🔴 **"调整计划"的可行域（题面硬要求）**：`from → to` 时 from 必须**严格在** to 之前。
> 所以"薄弱点提前"只能在**拓扑序之内**做 —— 本项目只允许：① 同层换序 ② 给该点加量/提前其动作 ③ 同层内排最前。
> **绝不为让某点靠前而破坏前置约束。**

### 3.4 状态如何更新（`record`）

```
读旧值：masteryOf(state, key)  ⇒  没学过的点返回 PRIOR_MASTERY = 0.5（冷启动先验）
新值  ：clamp01(旧值 + Δ)
Δ 表  ：correct +0.15 ｜ incorrect −0.25 ｜ confuse −0.05
```

🔴 **为什么用"先验 0.5"而不是 0**：若按 0 起步，第一次答错会变成 `clamp01(0 − 0.25) = 0`，
即**状态纹丝不动**，演示时看不出任何变化。用 0.5 起步，第一次答错 → 0.25，变化可见。
`state.has(key)` 仍能区分"没学过"与"就是 0 分"。

**题型掌握度 `kindState` 用同一公式、同一幅度**，key 是 `Problem.kind`（缺失记 `"未分类"`）。
一次 `record(Do)` 会**同时**更新它涉及的每个知识点 + 该题型 —— 对应题面"更新**知识点、题型掌握度（两者）**"。

### 3.5 环处理策略

模型逐块抽取时，"块内自洽、跨块不自洽"会产生环（例：A 是 B 的前置，B 又是 A 的前置）。
处理：**打破环 + 告警，不抛异常** —— 保证每个点**恰好进计划一次**。`cycles()` 可随时列出环路构成
（独立计算，不依赖调用顺序）。

### 3.6 问答（`ask`）

```
检索（有 embedding Key → 向量；否则关键词 n-gram）
  → 取 top-5 片段
  → 充足性判定（数值阈值，可复现）
  → 充足：模型仅依据片段作答（注入只读上下文）／不充足：answer = null，明确拒答
  → 模型自述"资料不足" ⇒ 同样 answer = null（模型这一层只能降、不能升）
  → 无论充足与否，都 record({kind:"Ask"}) 回填
```

**充足性判定（可复现的数值口径）**：
- 向量模式：top1 相似度 **≥ 0.45**；
- 关键词模式：命中片段数 **≥ 1** 且 **查询词项覆盖率 ≥ 0.5**
  （词项 = 去停用虚字后的**中文二元组** + 英文/数字词；覆盖率 = 命中片段里出现过的词项比例）；
- 关键词模式 + **抽取式回答**（没配 chat Key，没有模型再把关）再加一道**话题锚点**：
  top1 片段必须命中"提问里第一个实词段的头两个汉字"。
  ⚠️ 这一条是实测补的：只按并集覆盖率算，资料里只有「小数的认识 / 小数加减」时，
  问「**小数乘除法**怎么计算」会因为"小数"命中一份资料、"乘除"命中另一份资料而被拼成 `sufficient=true`，
  答案却是一段**整数乘除法**的原文 —— 与题面"资料不足就说明资料不足"冲突。
  （有 Key 时不启用这条：模型自己会把 `sufficient` 降级，而且**只能降不能升**，没必要提前用启发式拒答。）
- **章节标题也参与匹配**：正文里可能一次都没写标题里的词（m03 的正文没写过"认识"二字，标题却叫「1 小数的认识」），
  所以匹配文本 = 章节标题（locator 最后一段） + 正文；
- **模型最终确认**：模型回答里若出现"资料不足 / 信息不足 / 无法回答 / 文中未提及 / 不足以回答"之类自述，
  一律降为 `answer = null` + `sufficient = false`（**出处照旧返回**，便于人工复核）。

🔴 **资料不足时 `answer = null`，绝不用模型自身知识补全**。有 Key 时模型**只能把 `sufficient` 降为 false，不能升高**。

**上下文包（L3 完成标志）**：除资料片段外，还**只读**注入三项（定值 N=5 / M=5）：
① 相关点的 `state` + 相关题型的 `kindState`；② 相关真题 + 该点的 `AnswerRecord`（最近 5 条）；
③ 相关 `HistoryEntry`（最近 5 条）。模型要改状态**只能走 `record`**。

### 3.7 「让 AI 决定下一步学什么、怎么学」怎么落地（L3 §2.5-1.2）

两层，缺一不可：

1. **规则版计划（默认、永远可用）**：`makePlan` + `fillActions`（§3.3）—— 拓扑序是硬约束，
   动作按"读资料 → 讲解 → 做题 / 回炉题 / 巩固题"填充，确定性、可复现、离线可跑。
2. **模型提议通道（真接线，可开关）**：`proposePlanFromModel(net)` 把"知识点清单（拓扑序 + 前置 +
   资料 + 真题 + 当前掌握度）"交给模型，让模型返回 `{"plan":[{"pointName","actions":[…]}]}`，
   再走**同一套** `proposePlan` 校验：
   - 覆盖完整（每个存活知识点**恰好一次**）、拓扑序（`from` 严格在 `to` 前）、
     `Read` 的 resource 必须属于该点、`Do` 的 problemName 必须真实存在（**禁止编造真题**）；
   - 通过 ⇒ 采用模型给的顺序与动作；不通过 ⇒ **不执行**，调用方回落规则版计划；
   - 接受/拒绝**都写** `data/decisions.json`（含原始草稿），可回放。

🔴 两道工程细节（都是实测踩出来的）：
- 模型要的是"提建议"，**执行权在后端**：模型不能直接改 `state`，也不能凭空造资料/真题；
- `response_format: json_object` 模式**顶层必须是对象** ⇒ 提示词写成 `{"plan":[…]}`，
  系统侧再剥壳（`unwrapDraft`）。修前提示词要"直接返回数组"，模型只能把它包一层，
  结果每次都被拒在"草稿必须是数组"上 —— 看着像模型乱来，其实是接口约束。

网页壳 `POST /api/propose` 两种用法：直接 POST 草稿数组（校验它）、或
`{"useModel":true}`（让真模型出草稿再校验）；`demo/full-demo.ts` 两个方向都演示。

---

## 4. 区分资料 / 真题的规则

| | 路径 | 用途 |
|---|---|---|
| **资料** | `data/materials/**/*.md` | 讲知识点的正文 → 抽出 `points` + `edges`，并作为**问答检索的唯一语料** |
| **真题** | `data/problems/**/*.prob.md` | 历年题 → 抽出 `points`（**累计考频**）+ `kind`（题型） |

两份 md 的约定格式（**路 B**，离线可用）：

```markdown
<!-- 资料：data/materials/m01-integers.md -->
## 知识点: 整数加减, 整数乘除
## 前置: 整数加减 -> 整数乘除

## 1 整数加减法
正文……
```

```markdown
<!-- 真题：data/problems/2023-期末-第1题.prob.md -->
# 2023 期末 第1题
## 题型: 计算
## 涉及知识点: 整数加减

23 + 45 = ?
```

`analyze` 有**四级路径**，逐级回退（顺序由调用方选，见下）：

1. **路 A（模型）**：真调模型逐块抽取 + 手写 schema 校验（失败重试 1 次）；
2. **路 B（声明）**：md 里有上面的显式声明 → 直接切出，**不调模型**（`l1-demo` 走这条，完全离线可跑）；
3. **兜底 presets**：`<输入目录>/presets/analyze-req.json` 里该文件的预置结果；
4. 仍拿不到 ⇒ 抛错/返回 0 点，并由调用方如实标注（**不写脏数据、不假装成功**）。

**谁来定顺序**（`analyzeResource({ forceModel, preferModel })`）：

| 调用方 | 顺序 | 理由 |
|---|---|---|
| 网页壳上传 / `/api/analyze`（`preferModel: true`） | **路 A → 路 B → presets** | 真课件转出来的 md **没有**声明，必须让模型抽；这就是题面 L2 的主路径 |
| `demo/full-demo.ts`（`forceModel: true`） | **路 A → presets** | 演示"模型不可用时的兜底" |
| `demo/l1-demo.ts` / 启动接入（默认） | **路 B → presets** | 声明齐全的资料不花 Token，批量/离线稳定 |

> 🔴 **没有 Key 时网页上传怎么办**：不会崩，也不会静默丢数据 —— 按上面的顺序回落到 presets / 声明，
> 响应里带 `extractedBy: "model" | "preset" | "rule"` 与 `note`，日志逐份打印来源，
> 一份都抽不出知识点时会 `console.warn` 提醒（**修掉了"上传成功但其实是 0 个知识点"的静默失败**）。

**输入约定**：只吃 `.md`。PDF / PPTX **不直接解析**，请先转 md。

---

## 5. 演示步骤（题面要求的 5 步）

两条命令都能走完 5 步，输出里**每步都打印"为什么这么做"**：

| 步 | 做什么 | 看什么 |
|---|---|---|
| 1 | 接入第 1 份资料 → 解析出知识点与前置关系 | 知识网络开始成形 |
| 2 | 继续接入其余资料 + 7 道真题 | 体系"长了"：新增点 / 新增边 / **考频累计**；随后打印 `queryPoint`、`pointRank(3)`、当前计划 |
| 3 | 提一个资料里有答案的问题 + 一个资料里没有的问题 | 前者**带出处**回答；后者**明确拒答**（`sufficient=false`） |
| 4 | 记录一次真题作答（做错） | 知识点掌握度 `0.50 → 0.25`、题型掌握度同步下降；然后**另起一个进程**跑 `verify-persist.ts` 读回落盘数据 |
| 5 | 重新 `makePlan()` | 该薄弱点**动作数增加**（主题 + 回炉题），并说明变化仍在拓扑序允许范围内 |
| 5·续 | **多轮**：连续答对跨过 `0.80` 阈值 → 同一道题再错一次 | ① 该点被**排到同层最后**、动作收敛为一道巩固题（"降低已掌握内容优先级"）；② 答错记录 2 条 ⇒ 判为**稳定薄弱**，回炉题继续加量 |
| 附 | **模型提议被拒 → 回落规则版计划** | 故意喂一条非法提议，打印每条拒绝理由 + 决策日志 + 回落后的计划（§4.13） |

📄 **现场演示照这份走**：`docs/演示脚本.md`（一页纸：命令 + 每步看点 + 口播要点 + 失败预案 + 8 个可能被追问的问题索引）。

🔁 **演示是幂等的**：输入读 `data/`（只读），产物写 `data/.runtime/`（每次启动前清空）
⇒ 第 N 次跑和第 1 次输出**完全一致**（`l1-demo` 另外强制 `offline`，**连"本机恰好有 Key"都不会影响输出**）。

---

## 6. 无 Key / 离线时的降级行为

| 缺什么 | 降级行为 |
|---|---|
| 无 embedding Key | 检索退化为**关键词 / n-gram**（纯本地，零依赖） |
| 无 chat Key | 问答退化为**抽取式**：直接返回命中片段 + 出处（`fallback:"extractive"`）；资料不足仍 `sufficient=false` |
| 完全离线 | 走 `demo/l1-demo.ts`（路 B 规则解析 md 得到 points / edges），**5 步照跑** |
| 模型抽取失败 | 逐级回退：路 B → presets；仍失败才跳过该文件（**不写脏数据**） |

🔴 **`sufficient` 语义不因降级而改变** —— 判定不过就是 `answer=null` + `sufficient=false`，
**不因"没配 Key"就放水或改口**。

---

## 7. 网页壳（加分项）

`src/server.ts` 用原生 `node:http` + 手写路由表（JSON 进 JSON 出，零依赖），
`public/` 三个页面用原生 HTML/JS 直接 `fetch`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` `/ask` `/learn` | 知识体系页 / 问答页 / 学习计划与记录页 |
| GET | `/api/graph` | 知识点清单 + 前置边 + 考频榜 |
| GET | `/api/point?name=…` | `queryPoint`：资料 / 真题 / 题型 |
| GET | `/api/plan` | 当前 `makePlan()` 结果 |
| GET | `/api/files` | 列出 `data/materials/`、`data/problems/` 已有文件 |
| POST | `/api/ask` | `{question}` → `AskResult`（含 citations） |
| POST | `/api/record` | `LearnRecord` → 更新并落盘，返回新 `state` / `kindState` |
| POST | `/api/analyze` | `{file}` → 对 `data/` 里已有的文件触发 analyze → integrate |
| POST | `/api/upload` | `{name, content, target}` → **真上传**：落盘 → 自动分析 |
| POST | `/api/propose` | 直接 POST 草稿数组 → 校验/拒绝；或 `{"useModel":true}` → **真模型**出草稿后走同一套校验 |

> 上传走 **JSON**（不做 `multipart/form-data`）：省的是表单解析，**不是上传功能本身**。
> `file` 只允许 `data/` 目录内的路径（防任意路径读取）；上传文件名不允许含路径分隔符或 `..`，
> 且按目录约定补后缀（真题一律 `*.prob.md`，否则文件列表与启动扫描都看不到它）。

---

## 8. 默认值账本（全部可调，集中在此，便于对照）

| 项 | 取值 |
|---|---|
| 冷启动先验 | 未学过的点 = **0.5**（`PRIOR_MASTERY`） |
| 掌握度幅度 | correct **+0.15** / incorrect **−0.25** / confuse **−0.05**，裁剪到 [0,1]；`kindState` 同公式同幅度 |
| "已掌握"阈值 | **0.8** |
| Top-k 检索条数 | **5** |
| 充足性阈值 | 向量 top1 **≥ 0.45**；关键词 命中 ≥ 1 且 覆盖率 **≥ 0.5**（词项 = 中文**二元组** + 英文词） |
| 抽取式回答加严 | 关键词模式 + 没配 chat Key（抽取式回答）⇒ top1 片段还必须命中**话题锚点**（`KEYWORD_REQUIRE_TOPIC_ANCHOR`） |
| 合并候选阈值 | 名字的字符二元组 Jaccard **≥ 0.6**（只提示，不自动合并；`MERGE_CANDIDATE_JACCARD`） |
| 上下文包注入 | AnswerRecord 最近 **N=5**、HistoryEntry 最近 **M=5** |
| 长文切分粒度 | **> 3000 字**按标题 / 段落切分 |
| 落盘保留策略 | `answers.json` / `history.json` / `decisions.json` 各保留最近 **500 条**（超出按 `at` 裁剪） |
| 计划排序键 | `(已掌握?0:1, 掌握度, -考频, normalize(name) 码点序)` 层内升序（**已掌握排最后**） |
| 薄弱题型优先 | 选主练习题 / 回炉题时，`kindState < 0.8` 的题型优先（再看考频，最后看题目名） |
| 合并时机 | 默认**入图前合并**（别名表 → 归一化）；入图后用 `mergePoints` |
| 环处理 | 打破环 + 告警（不抛异常） |
| 题型缺失值 | `"未分类"` |
| 运行产物目录 | `data/.runtime/`（可用环境变量 `T2_DATA_DIR` / `T2_RUNTIME_DIR` 覆盖） |

---

## 9. 已实现 / 未实现（如实声明）

**已实现**
- L1 知识网络（归一化 / 别名 / 拓扑排序 / 环检测 / 考频 / `queryPoint`）
- L2 模型抽取（三级路径 + schema 校验 + 重试）、带出处的问答（向量 / 关键词双模式 + 数值充足性判定）
- L2 同义点合并：别名表（`data/aliases.json`）+ 归一化 + **合并候选提示**（`mergeCandidates`，只提示不自动合并）
- L3 学习状态（`state` + `kindState`）、计划动作填充、回炉题、**真模型提议通道**
  （`proposePlanFromModel` → 校验 → 采用/拒绝 → 回落）+ 决策日志
- 持久化（`graph` / `state` / `answers` / `history` / `decisions`，原子写 + 500 条裁剪 + 载入校验）
- 合并后**旧名重定向**到合并目标（`mergedInto`）：重启后再用旧名上传资料/做题，仍归到合并目标上，不丢数据
- 网页壳（9 条 API + 3 个页面，含真上传与模型提议）
- `§8` 验收用例 **44 条**（含 6 条网页壳端到端：子进程起真实 server + 真发 HTTP，覆盖"模型挂了如何如实回落"）

**未实现 / 已知限制**
- **语义合并**（用 embedding 找同义知识点）默认**不做** —— 只做字符串归一 + 别名表 +
  二元组 Jaccard 的**候选提示**（`mergeCandidates`）。**不自动合并**（自动合并会静默吃掉一个点、不可逆）；
  所以"路 A 模型抽取"给出的近义写法（如 `分数表示整体的一部分`）仍需人工确认后才能进别名表。
- **PDF / PPTX 不直接解析**（需先转 md）。
- **不处理多进程并发写**（同一份 `data/` 被两个进程同时写，后写的覆盖先写的）。单机演示场景外不加锁。
- **路 A 的粒度问题**：模型对资料抽取的知识点粒度，可能与真题 md 里声明的粒度不一致
  ⇒ 可能出现"真题提到、资料没覆盖"的点（这类点在计划里没有 Read 动作，只有 Explain + 做题）。
- **`mergePoints` 在 demo 里不直接调用**（`data/aliases.json` + `mergeCandidates` 覆盖了常规场景），
  但它有专门用例（用例 37：合并 → 重启 → 再用旧名接入资料必须归到合并目标，不丢数据）。
- 真模型问答 / 抽取需要 Key；无 Key 走降级路径（见 §6）。

---

## 10. 静态类型自检（可选，开发期）

本项目运行时不带类型检查 —— `node --experimental-strip-types` **只做类型擦除、不做校验**。
为了不让"接口不匹配"这类错误一路裸奔到运行时，仓库带了一份**只用于开发期**的 tsconfig：

```bash
npm install          # 装 devDependencies：typescript + @types/node（运行时依赖仍为零）
npm run typecheck    # tsc --noEmit，含 noUnusedLocals / strict
```

`package.json` 的 `dependencies` 字段为空 ⇒ **演示、测试、部署都不需要 `npm install`**。

---

## 11. 每个模块的《答辩问答》

见 **`docs/defense/`**（每个模块一份：① 这段干什么 ② 关键设计决策及为什么 ③ 可能被追问的问题与要点）。
