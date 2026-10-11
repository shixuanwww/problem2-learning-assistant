# 题 2《AI 学习辅助网页》· 实施计划书

> **本文件写给执行者（DSH）看。** 执行者看不到需求方与助手之间的对话，因此本文件是**唯一的上下文来源**，所有必要信息在此自包含。  
> **范围**：只覆盖熬测第 2 题。其余三题（`.gmd` 衍生文档管理器 / Agent 工具调用安全网关 / 自建 SillyTavern）另有计划书，不在本文件范围。  
> **本文件不做的事**：不写实现代码。执行者按本文件的规格产出代码。

---

## 0. 执行约定（先读）

1. **交付形态**：可以是网页 / CLI / 跑测试的脚本——**任选**。本计划书默认「**CLI 演示脚本 + 本地网页**」双形态（网页是加分项，CLI 保证能跑通演示）。
2. **语言/栈**：**TypeScript + Node 22**，**零第三方运行时依赖**（HTTP 用内置 `node:http`，文件用 `node:fs`，网络用内置 `fetch`）。运行方式：
   ```bash
   node --experimental-strip-types src/xxx.ts
   ```
   （Node ≥ 22.6 支持 `--experimental-strip-types` 直接跑 TS，无需 tsc/tsx。**本机实测 v22.14.0 可用，但该 flag 必须显式带上**（22.18 起才默认开启）。若目标机 Node < 22.6：优先**退化为 JS**（保持零依赖）；万不得已用 `npx tsx` —— ⚠️ **它需要联网装包，与"零依赖 / 离线可跑"冲突**，只在评审机允许联网时用，并写进 README。）
3. **不得引入**：数据库服务、Docker、前端框架构建链（React/Vue 构建）。原因见 §2。
4. **每完成一层（L1/L2/L3）必须**：① 能独立跑通该层的验收脚本；② 追加一次 git commit。
5. **接口风格可自定**，但 §4 给出的**语义与边界不可改**——那是题面的硬要求。
6. **输入约定（必须先声明，别留白）**：本工具吃的是 **md**。题面的 pptx / pdf **不直接解析**，需先转成 md（PPT 导出为文本；PDF 用 `pdftotext` 或本机 `知识库助手\src\extract.js` 的做法）。这条要**同时**写进 README 的"输入约定"和"未实现"两处，不要让评审自己猜。

---

## 1. 题目原文要点（逐条摘录，不可漏）

> 📄 **题面原文已落盘：`docs/problem-statement.md`**（350 行，来源 PDF 第 1 页 + 第 4–11 页，逐字摘录，未改一字）。**凡是本计划书与原文冲突，一律以原文为准**；演示 5 步、交付与范围、评分口径的原话都在那份文件里，动手前先读它。
>
> ⚠️ 本节是**转述导航**，为的是让你快速定位；不要用本节替代原文核对。

### 1.1 场景

学姐要期末复习，手上有：老师 PPT（pptx）、课本 PDF、往年真题（pdf）、考试时间。资料太多没时间整理。要一个基于 AI 的学习辅助工具，工作流：

```
上传资料或记录真题作答情况 → 后台解析资料 → 构建知识/题型体系
→ AI 按需查询资料与学习状态 → 更新学习计划 → 用户学习/问答/做题
→ 继续上传 → 更新知识体系 → 调整学习计划 → AI 再次决策
```

### 1.2 核心概念（题面定义，全部要落地）

- **原始资料(输入)**：PPT、教材，**统一抽象成一堆本地的 md 文件**，是**所有知识和回答的事实来源**。
- **知识点**：课程中需要理解和掌握的**最小知识单元**。
- **真题**：考察知识点的具体实例，是判断考试重点和用户掌握情况的依据。
- **知识体系**：知识点之间、以及知识点-真题-原始资料之间的关系网络。
- **学习记录**：用户实际发生过的学习行为（提问、看过内容、做真题、答对答错、跳过等）。
- **学习计划**：结合知识体系 + 真题分布 + 学习状态，决定接下来学什么、怎么学；**可简化为"学习一串不重复的知识点，每个知识点的学习过程由多个学习动作组成"**。
- **学习动作**：计划真正落地的一步（看资料 / 解释知识点 / 做一道题 / 继续下一项）。
- **AI 学习助手**：负责理解用户表现、调用已有知识和真题、选择下一步学习动作，**不取代底层数据本身**。

### 1.3 题目给定的参考数据结构（Rust 风格，需等价翻译到 TS）

```
type Resource = String;
struct Point { name: String, /* pid: u32，单调递增 id，表示 graph 的 index，可选 */ }
struct Problem { name: String, content: String, points: Vec<Point> }
type Edge = (Point, Point);                       // from -> to：学 to 前要先学 from
type PointGraph = Vec<(Vec<Point>, Vec<Resource>)>;  // (该知识点的前置知识点, 涉及该知识点的资料)
enum ProStatus { Correct, Incorrect, Confuse }
enum LearnRecord { Ask(String), Read(Resource), Do(Problem, ProStatus), Skip(Point) }
enum LearnAction { Read(Resource), Explain, Do(Problem) }
type LearnPlan = Vec<(Point, Vec<LearnAction>)>
struct AnalyzeResReq { resource: Resource, points: Vec<Point>, edges: Vec<Edge> }
struct AnalyzeProReq { problem: Problem, points: Vec<Point> }
enum AnalyzeReq { ResReq(AnalyzeResReq), ProReq(AnalyzeProReq) }
trait AIAssistant {
  fn makePlan(&self) -> LearnPlan;
  fn analyzeRes(&self, resource: Resource) -> Result<AnalyzeResReq, _>;
  fn analyzePro(&self, problem: Problem) -> Result<AnalyzeProReq, _>;
  fn integrate(&mut self, req: AnalyzeReq);
  fn pointRank(&self, rank: u32) -> Vec<Point>;
  fn queryPoint(&self, point: Point) -> (Vec<Resource>, Vec<Problem>);
  fn record(&mut self, learn: LearnRecord);
}
```

注：题面明说「**可以自行添加其他 helper method**」「**如果你认为题目给出的某些设计不合理，也可以自行修改**」，但 §4 的语义要求要在。

### 1.4 三个 Level 的要求（摘要）

- **L1 知识网络 SIMULATION**：**不接 AI**。假定已拿到 AI 的分析结果 `AnalyzeReq`。定义 `SimulationNetwork` 并实现 `integrate` + `makePlan`（`queryPoint` 可放 L2）。
  - `SimulationNetwork { resources: Vec<Resource>, graph: PointGraph, pointMention: Vec<u32> }`
  - **`makePlan` 完成标志**：返回的 `LearnPlan` 里 `LearnAction` 可以为空 Vec，但 **Point 必须有序**（学 B 要先学 A ⇒ B 排在 A 之后），且**每个 Point 出现且仅出现一次**。即：**给出一个合理的知识点学习顺序**。
  - 还要能自动整理出：① 知识点总结 + 联系（前置关系）② 历年知识点考频 ③ 知识点-真题-资料三者关系；**继续上传新资料时能把新内容整合进已有体系**。
- **L2 接 AI**：
  - **1.1 从原始资料构建可持续更新的知识体系**：解析 md（资料 + 真题混在 md 里）；AI 输出要满足格式 ⇒ 需要 **schema 校验或配置 tool**；**真题与资料按路径或自定义后缀区分**；**文件较长时做合理切分**；**不同名称但本质相同的知识点要合并**。
  - **1.2 基于资料可靠问答**：自然语言提问；**回答必须以用户上传的资料为依据、可追溯到原始资料**；**资料不足时必须提示不足（`Ask` 的载荷可为 `None`），不得用模型自身知识补全**。
  - L2 完成标志：① 上传多份资料+真题后形成统一的知识与题型体系 ② 查一个知识点能同时看到资料来源、真题、题型 ③ 问答能返回资料依据，资料不足时拒绝无依据补全。
- **L3 学习状态与动态计划**：
  - **1.1** 维护抽象的**学习状态**（如各知识点掌握度），参考 `type State = Map<Point, f32>`；**学习状态必须持久化，不能只存在于一次模型上下文**。用户反馈抽象为「主动调用 `record`」。
  - **1.2** `makePlan` 里的 `LearnAction` **要真正填充**（结合各种上下文决定"学什么、怎么学"）。
  - L3 完成标志：① 根据课程数据 + 用户状态选下一步学什么/怎么学 ② 用户上传一个 record 后状态**合理变化** ③ 新作答结果能影响后续计划（增加薄弱题型训练 / 回到相关知识点 / 降低已掌握内容优先级）④ AI 能按需获取知识/真题/作答/学习历史 ⑤ **模型做出不合法操作时后端不直接执行**。
- **进阶项（可选取若干，作加分）**：AI 主动出题检验是否真掌握；区分"概念不会 / 前置不足 / 会概念不会做题"；区分偶然做错与稳定薄弱；分析主观题作答过程；控制调用次数/Token 成本；保存每次决策依据支持回放；自动评估下一步决策；不同任务用不同模型/Prompt；提升语义相近但关键词不同的检索效果；优化大量资料下的检索/更新/存储性能。

### 1.5 交付与演示（题面原文要求）

- 交付：① 能直接操作的**网页或 CLI 或跑 test 的脚本**，任意形式，**只要能展现成果**；② **README**（启动方式 + 主要设计）；③ **可用于演示的测试资料或样例数据**。
- **演示时至少完整跑通 5 步**：
  1. 上传资料并由后台处理；
  2. 根据多份资料构建并继续更新知识体系、学习计划；
  3. 基于资料进行**带来源**的问答；
  4. 上传/记录一份真题作答情况，并据此更新知识点、题型掌握度；
  5. 用户经过多轮学习和做题后，AI 根据学习表现调整之后的行为计划。

---

## 2. 已定设计决策（执行者直接采用，不要重新选型）

| 决策          | 取值                                               | 理由                                    |
| ----------- | ------------------------------------------------ | ------------------------------------- |
| 语言          | **TypeScript**（零运行时依赖）                           | 题面允许自选；TS 的类型能直接承载题面的 `Vec<(...)>` 结构 |
| 运行          | `node --experimental-strip-types`                | 免构建、免装包，评审机器上最容易跑起来                   |
| HTTP / 前端   | 内置 `node:http` + 原生 HTML/CSS/JS（放 `public/`）     | **不引入 React 构建链**，保证"一条命令跑起来"         |
| 资料载体        | **本地 md 文件**（题面就要求这样抽象）                          | 题面明确"统一抽象成一堆本地的 md 文件"                |
| 资料 vs 真题 区分 | **按目录 + 文件名后缀**（见 §7）                            | 题面允许"按路径或者自己定义后缀"，选最简单可判的             |
| 持久化         | **JSON 文件**（`data/state.json`、`data/graph.json`） | 题面只要求"学习状态持久化"，不要求数据库；零依赖优先           |
| 结构学习顺序      | **拓扑排序**（Kahn 或 DFS），前置边 `from → to`             | 直接对应 L1 的 `makePlan` 完成标志             |
| 知识点合并       | **名称归一化 + 别名表**（见 §4.5）                          | 题面要求"名字不同但本质相同要合并"                    |

### 2.1 🔴 运行环境硬约束（写错就"跑不起来"）

`node --experimental-strip-types` **只做类型擦除、不做任何语法转换**，因此：

| 约束                                                           | 说明                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Node ≥ 22.6**（建议 ≥ 22.18，该版本起默认启用该 flag）                   | README **必须写明版本要求**；⚠️ **不要**再写"评审机器上最容易跑起来" —— 那是**假设**，评审机版本未知                                                                         |
| **相对 import 必须带 `.ts` 后缀**（`import { X } from './types.ts'`） | 否则运行时报模块找不到，这是最常见的翻车点                                                                                                                    |
| **禁用** `enum` / `namespace` / 装饰器 / 构造函数参数属性                 | 这些需要运行时转换；`enum` 改用 `const` 对象 + union type                                                                                              |
| 禁用 `tsconfig` 的 `paths` 路径别名（`@/…`）                          | type stripping 不解析别名                                                                                                                     |
| **`.env` 不会自动加载**                                            | 零依赖下**不要装 dotenv**：用 Node 自带的 `node --env-file=.env --experimental-strip-types …`（Node ≥20.6），或手写 ~10 行解析（`readFileSync` + 按行 split `=`） |
| **`.env` 必须 UTF-8 无 BOM**                                      | **实测**：`.env` 带 BOM（PowerShell `Set-Content -Encoding UTF8` 的默认产物，前 4 字节 `EF BB BF`）时 `--env-file` **静默失效**，`process.env.X` 为 undefined ⇒ 演示会悄悄走降级路径而没人发现。**启动时必须打一行 Key 自检**（如 `console.log('chat key:', !!process.env.DEEPSEEK_API_KEY)`) |
| **网页端不要手写 `multipart/form-data`**                          | 但**要支持真上传**：前端 `fetch` 读文件文本 → `POST /api/upload`（JSON `{name, content, target}`）→ 后端落盘并触发分析（§4.12） |

> ⚠️ 上表第 3 条（禁 `enum`）**同样适用于 §3 的数据契约**——契约里已改为 `const` 对象 + union type，照抄即可。
>
> **兜底**：README 的"启动方式"里放一条 `node --version` 自检；若评审机 Node < 22.6，按 §9.3 的降级说明处理。

---

## 3. 数据模型（完整 TypeScript 定义，直接落地）

> 文件：`src/types.ts`。**这是全项目的契约**，后续所有模块都 import 它。

```ts
// ---------- 基础 ----------
export type Resource = string;   // 资料路径，如 "data/materials/math-g2.md"

export interface Point {
  name: string;      // 知识点名，唯一键（归一化后）
  pid?: number;      // 单调递增 id，等于其在 PointGraph 中的下标；由 integrate 分配
}

export interface Problem {
  name: string;      // 真题名，如 "2023 期末 T3"
  content: string;   // 题干
  points: Point[];   // 该题考察的知识点
  kind?: string;     // 【题型】如 "选择"/"填空"/"计算"/"简答"；由 analyzePro 抽取，缺失置 "未分类"
}

/** 单向边 from → to：学 to 之前必须先学 from */
export type Edge = [Point, Point];

/** PointGraph[pid] = { prev, resources }；（前置知识点列表, 涉及该知识点的资料） */
export interface PointNode {
  prev: Point[];         // 前置知识点（指向本知识点的边的起点）
  resources: Resource[]; // 哪些资料涉及本知识点
  dead?: boolean;        // 被 mergePoints 合并掉的失效点（§4.5）；**保留下标**，避免其余 pid 位移
}
export type PointGraph = PointNode[];   // 下标即 pid

// ⚠️ 禁用 enum（§2.1：type stripping 不做运行时转换）⇒ 一律 const 对象 + union type
export const ProStatus = {
  Correct: "correct",
  Incorrect: "incorrect",
  Confuse: "confuse",
} as const;
export type ProStatus = (typeof ProStatus)[keyof typeof ProStatus];

/** 问答引用：可追溯到原始资料（§4.10） */
export interface Citation {
  resource: Resource;   // 文件名 / 路径
  locator: string;      // 定位：md 用标题路径（如 "§2.1 整数加减"）；PDF 用页码
  snippet: string;      // 命中的原文片段（截断到 ≤200 字并标省略号）
  score?: number;       // 相关性得分，便于演示展示
}

export type LearnRecord =
  | { kind: "Ask"; question: string; answer?: string | null; citations?: Citation[] }
  | { kind: "Read"; resource: Resource }
  | { kind: "Do"; problem: Problem; status: ProStatus }
  | { kind: "Skip"; point: Point };
// ↑ record 的 ask 分支：ask()（§4.10）结束后把结果**回填**成一条 Ask 记录；
//   资料不足时 answer = null —— 对应题面"Ask 的 Option 可写为 None"。

export type LearnAction =
  | { kind: "Read"; resource: Resource }
  | { kind: "Explain" }                        // 解释当前知识点（可由多个动作重复出现，如 intro/summary）
  | { kind: "Do"; problem: Problem };

/** 一个学习计划：按顺序学一串知识点，每个知识点带若干学习动作 */
export type LearnPlan = Array<{ point: Point; actions: LearnAction[] }>;

export interface AnalyzeResReq { resource: Resource; points: Point[]; edges: Edge[]; }
export interface AnalyzeProReq { problem: Problem; points: Point[]; }
export type AnalyzeReq =
  | { kind: "ResReq"; data: AnalyzeResReq }
  | { kind: "ProReq"; data: AnalyzeProReq };

/** L3：学习状态。key = normalize(Point.name) */
export type State = Map<string, number>;       // 知识点掌握度 [0,1]
export type KindState = Map<string, number>;   // 【题型】掌握度 [0,1]，key = Problem.kind（缺失为 "未分类"）

/** 🔴 冷启动先验：**没学过的点按 0.5 处理，不是 0**。
 *  读掌握度一律用 masteryOf()，**不要 `state.get()` 直接参与算术**：
 *  取到 undefined 会算出 NaN；若当 0 处理，则"做错一次"（−0.25）会被裁剪回 0，
 *  掌握度纹丝不动 ⇒ §8 用例 9 与 §9.2 第 4 步直接失败。
 *  要区分"没数据"和"就是 0"，用 `state.has(key)`。 */
export const PRIOR_MASTERY = 0.5;
export const masteryOf = (m: State, normalizedName: string): number =>
  m.get(normalizedName) ?? PRIOR_MASTERY;

/** 一次真题作答的结构化记录（§4.7 规则 2 选"回炉题"要靠它，别只存人类可读文本） */
export interface AnswerRecord {
  at: string;            // ISO 时间戳
  problemName: string;   // 对应 Problem.name
  kind: string;          // 题型（缺失为 "未分类"）
  status: ProStatus;
  pointNames: string[];  // 涉及知识点（归一化名）
}

/** 一次学习行为的留痕（进阶项"区分偶然做错 / 稳定薄弱"与"决策回放"都靠它） */
export interface HistoryEntry {
  at: string;                // ISO 时间戳
  kind: LearnRecord["kind"];
  detail: string;            // 人类可读摘要（问题 / 资料名 / 题目名 + 结果）
  pointNames?: string[];     // 涉及的知识点（归一化名）
  before?: number;           // 变更前掌握度（仅 Do）
  after?: number;            // 变更后掌握度（仅 Do）
}

/** ask() 的返回（§4.10） */
export interface AskResult {
  question: string;
  answer: string | null;     // 资料不足 ⇒ null（**不得**用模型自身知识补全）
  citations: Citation[];
  sufficient: boolean;
  fallback?: "keyword" | "extractive";   // 无 Key 时的降级路径（§9.3）
}

// ⚠️ JSON 没有 Map：**不要直接 JSON.stringify(Map)**（会得到 `{}`，状态静默丢光）。
//    统一走这两个函数落盘 / 载入：
export const stateToJSON   = (m: State) => Object.fromEntries(m) as Record<string, number>;
export const stateFromJSON = (o: Record<string, number> | null) => new Map(Object.entries(o ?? {}));

// ---------- 助手接口（对应题面 AIAssistant trait，7 个方法一个不少） ----------
export interface AIAssistant {
  makePlan(): LearnPlan;
  analyzeRes(resource: Resource): Promise<AnalyzeResReq>;
  analyzePro(problem: Problem): Promise<AnalyzeProReq>;
  integrate(req: AnalyzeReq): void;
  pointRank(rank: number): Point[];                 // 考频前 rank
  queryPoint(point: Point): { resources: Resource[]; problems: Problem[]; kinds: string[] };
  record(learn: LearnRecord): void;
}

/** 在题面 trait 之上追加的 helper（题面明确允许自行添加，§1.3） */
export interface LearningAssistant extends AIAssistant {
  ask(question: string): Promise<AskResult>;       // §4.10（L1 阶段可先按 §9.3 关键词降级实现）
  mergePoints(from: Point, into: Point): void;     // §4.5（可选；不实现则抛错并写进 README）
}

/** L1 的模拟知识网络（不接 AI） */
export interface SimulationNetwork extends LearningAssistant {
  resources: Resource[];
  graph: PointGraph;
  pointMention: number[];   // pointMention[pid] = 该知识点被真题提及的次数（考频）
  problems: Problem[];      // 额外保存题目本体，供 queryPoint / Do 动作使用
  state: State;             // L3：知识点掌握度（由 store 载入 / 落盘）
  kindState: KindState;     // L3：【题型】掌握度
  history: HistoryEntry[];  // L3：学习历史（落盘 data/history.json）
}
```

---

## 4. 模块与接口规格（**语义 + 边界，不可改**）

> 文件：`src/network.ts`（实现类 `SimNet`）、`src/plan.ts`（§4.2 / §4.7）。类型契约见 §3。

### 4.1 `integrate(req)`

把一份分析结果合并进已有知识体系。**必须幂等、可重复调用（模拟"继续上传"）。**

- **ResReq**：对 `req.data.points` 中每个 Point：
  - 若名称已存在（§4.5 归一化后相同）→ 复用已有 pid，**不新建**；
  - 否则追加到 `graph` 末尾，`pid = graph.length`，同时 `pointMention.push(0)`。
  - 把 `req.data.resource` 追加到该知识点的 `resources`（**去重**）。
  - 对 `req.data.edges` 里的每条 `[from, to]`：把 `from` 加进 `to` 的 `prev`（**去重**）；同时确保两端 Point 都已入图。
- **ProReq**：把 `req.data.problem` 存入 `problems`（按 `name` 去重）；对其每个 Point 确保入图。
  **考频只在"这道题首次入库"时 +1** —— `if (该 problem.name 是新插入的) for (pid of 它的 points) pointMention[pid] += 1`。
  ⚠️ 重复 `integrate` 同一份 `AnalyzeProReq` **不得重复计数**，否则 §4.1 开头承诺的"幂等"就是假的，§8 用例 3（`pointRank` 顺序）与用例 6（再上传）会被污染。
- **边界**：`edges` 两端可能在 `points` 里没出现 → 先隐式建点再加边；自环 / 重复边要**去重**；出现环时**不抛异常**，记录下来（见 §4.3）。

### 4.2 `makePlan()`

返回**拓扑有序**的 `LearnPlan`。

- **必须满足**（题面硬要求）：
  1. `graph` 中**每个存活知识点出现且仅出现一次**；
  2. 若存在 `from → to`，则 `from` 的位置严格在 `to` **之前**；
  3. 同一层内（无前置约束的点之间）用**唯一的排序键函数**决定顺序（见下方 🔑），保证同一输入**逐字节可复现**。
- **环处理**（题面未规定；**按 §11 拍板：打破环 + 日志告警**，写进 README）：检测到环时，**打破环继续输出**（保证"每个点恰好一次"这条硬要求不被违反），并**在日志里告警**，同时由 `cycles()`（§4.3）暴露。⚠️ **不要写"在返回值里标出环"** —— `LearnPlan` 的类型（§3）装不下环信息；也不要因为环而少输出点。
- **失效点（`dead: true`，§4.5 合并产生）不算知识点**：`topoOrder` 必须跳过它们，§8 用例 5 的"恰好一次"只统计**存活点**。

> 🔑 **排序键（唯一定义，别处不得再排一遍）**
>
> 1. `topoOrder()` 先给出**拓扑分层**（Kahn：同一次入队的点属同一层）；
> 2. 层内按下列键**升序**排列，即 `makePlan` 的顺序：
>    `(已掌握 ? 0 : 1, masteryOf(state,key), -pointMention[pid], normalize(name) 码点序)`
>    —— "**未掌握的在前 → 掌握度低的在前 → 考频高的在前 → 名称码点小的在前**"；
>    🔴 **第一项必须让"已掌握"排在后面**（题面 L3 完成标志③"降低已掌握内容优先级"）。
>    ⚠️ 实现里**修过一次反向**：写成 `已掌握 ? 1 : 0` 且升序，结果已掌握的点排到最前，与本条正好相反（§8 用例 30 钉住）。
> 3. **"名称升序"= JS 字符串码点比较**（`a < b`），**不要用 `localeCompare`** —— 它受 locale 影响，跨机器结果会不同，承诺的"可复现"就没了；
> 4. §4.6 的 `pointRank` 与 §4.7 都用这个口径；**§4.7 规则 3 的"已掌握排后面"已包含在本键第 1 项里，不要再单独排一次**；
> 5. 演示里说"薄弱点被前移"，指的就是这个键把它在**同层内**提前了（§8 用例 13/14 据此判定）。
- **L1 时**：每个 `point` 的 `actions` 可为**空数组**。
- **L3 时**：`actions` 要按 §4.7 填充。

> 🔴 **「根据学习表现调整计划」的可行域 = 拓扑序之内**（最容易做错的一条，务必看）
>
> 学习顺序受 `from → to` 约束，**不能把一个知识点挪到它的前置点之前**。所以"调整计划"只允许这三种动作（**下列编号仅为列举，优先级顺序以 §11 为准**）：
>
> 1. **同层换序** —— 无前置约束（或前置已满足）的点之间调换先后；
> 2. **给该点加量/提前动作** —— 例如把 `Do` 从"一道巩固题"变成"两道回炉题"，或把该点的 `Read` / `Explain` 排到动作序列最前；
> 3. **同层内排到最前**。
>
> ⚠️ **禁止**为了"让薄弱点靠前"而违反 `from → to`。演示时若要说"薄弱点被前移"，**必须落在上面 3 种之内**，不能表述成"移到前置点前面"。

### 4.3 检测辅助

- `topoOrder(): Point[]` —— 内部用；Kahn 算法。返回顺序即 `makePlan` 的 Point 顺序（**跳过 `dead` 点**）。
- `cycles(): Point[][]` —— 返回检测到的环（供 README / 日志说明）。

### 4.4 `queryPoint(point)`

返回该知识点**出现在哪些资料 + 哪些真题 + 涉及哪些题型**（题面 L2 完成标志②）。

- 🔴 **比较口径（必须照做）**：一律用 **`normalize(point.name)` 得到的 key** 去比 ——
  ① 查 `graph` 走"归一化名 → pid"的索引；② 比对 `problems[].points[].name` 时**也要先归一化**。
  **禁止**用对象引用或原始字符串直接比，否则 `"整数加减"` / `"整数加减 "` / `"整数加减(一)"` 会漏查。
- 资料来自 `graph[pid].resources`；真题来自 `problems.filter(p => p.points.some(q => normalize(q.name) === key))`；
  题型 = 这些真题的 `kind`（缺失记 `"未分类"`）**去重后升序**。
- 知识点不存在、或已失效（`dead`）→ 返回 `{ resources: [], problems: [], kinds: [] }`（**不抛异常**）。

### 4.5 知识点合并（名称归一化）

`normalize(name)`（**纯字符串函数，只做这些，不碰括号**）：`trim` → 全角转半角 → 去空白与常见连接符（`-` / `_` / `·`）→ 英文小写。

- 🔴 **括号消歧不自动做**。`"整数加减(一)"` 与 `"整数加减(二)"` 若自动去括号，会**静默并成一个点**：另一个点连同它的资料 / 真题 / 考频一起消失，而 §8 用例 5 的"每个点恰好一次"**仍然会通过**（那个点压根没进图）。所以括号形式的等价关系**只允许通过 `data/aliases.json` 显式声明**：
  ```json
  { "整数加减(一)": "整数加减", "整数加减(二)": "整数加减" }
  ```
- 🔴 **撞车检测（必须实现）**：`integrate` 处理一批 points 时，若两个**原本不同**的名字归一化后得到同一个 key，**保留为独立的两个点**（不去重），并记 warning 到日志 / README。宁可多一个点，也不要静默丢一个点。
- 另维护 `data/aliases.json`（`{ "别名": "标准名" }`），`integrate` 时**先过别名表再归一化**。
- 归一化后同名的点视为同一点。**L2 可再加"语义相近"合并**（用 embedding 相似度生成**候选对**，见文末待办 4），但**核心版先做字符串归一 + 别名表**（语义合并**默认不做**，见 §11）。

#### 4.5.1 合并时机（硬约束：pid = 数组下标，删点会毁掉全部下标）

1. **默认只做"入图前合并"（见 §11）**：`integrate` 时先过别名表 + 归一化，命中已有归一化名就**复用已有 pid**。别名表必须在点入图之前生效，**已入图的点不回溯合并** —— 这样 pid 天然稳定。
2. 确实要合并两个**已入图**的点（L2 语义合并 / 别名表后补）时，必须实现 `mergePoints(from, into)`，并严格按下列语义做：
   - `into.prev` = 两者 `prev` 的并集，去掉 `from` 自身与自环，去重；
   - `into.resources` = 两者并集，去重；
   - `pointMention[into.pid] += pointMention[from.pid]`，然后 `pointMention[from.pid] = 0`；
   - 遍历 `problems[].points`，把指向 `from` 的项**改写为 `into`**；
   - 遍历其余节点的 `prev`，把指向 `from` 的项**改写为 `into`**；
   - `from` **不要 `splice` 删除**，而是 `graph[from.pid].dead = true`（保留下标）；`topoOrder` / `makePlan` / `queryPoint` / 计数一律跳过 `dead` 点（§4.2）；
   - **掌握度合并**：`state` 的键是知识点名，所以合并后必须一并处理 —— `state.set(intoKey, combine(state.get(fromKey), state.get(intoKey)))`，随后 `state.delete(fromKey)`。`combine` 取**作答次数加权平均**（该次数取自 `answers.json` 的**窗口内**记录 —— 最近 500 条，见 §11）；两边都无记录时取 `max`（保守，不因合并虚高）。**`kindState` 不迁移** —— 它的键是题型，不是知识点。
   - **历史 / 作答改写**：`history[].pointNames` 与 `answers[].pointNames` 里指向 `from` 的项改写为 `into`，保留可回放。
   - 记一条 `HistoryEntry`（可回放）。
3. 不打算实现 `mergePoints` 时，**在该方法里抛错，并在 README 写明"不支持入图后合并"** —— 不要留一个静默只做一半的实现。

### 4.6 `pointRank(rank)`

按 `pointMention` **降序**取前 `rank` 个知识点（并列时按名称升序）。`rank > 总数` 时返回全部。

### 4.7 `makePlan` 的 action 填充（L3）

对计划中的每个知识点 `p`，按下列**规则**生成 actions（可自行增强，但必须满足这些）：

1. **先读资料**：若 `p` 有 sources，插入 `{kind:"Read", resource: 第一个（或与薄弱题型相关的）}`；若既有资料又需要讲解，插入 `{kind:"Explain"}`（解释当前知识点）—— **"先讲知识点 → 再做练习"**。
2. **再做真题**：`{kind:"Do", problem}`，选法：
   - 优先选"该知识点答题结果为 `Incorrect` / `Confuse` 的真题"（**回炉**）；
   - 其次选考频高的知识点所对应的真题（**重点**）。
3. **跳过已掌握**：若 `masteryOf(state, key) >= 阈值`（**0.8，定值见 §11**），**只留一道巩固题**。"排到后面"这件事**统一交给 §4.2 的排序键**，**不要在这里另排一遍**（两处排序会打架）。
4. **前置不足**：若某前置点的 `masteryOf(state, prevKey)` 低于阈值，**只影响本点的动作取舍**（例如在本点动作序列最前补一个 `{kind:"Read"}` 指向该前置点的资料，或补一个 `{kind:"Explain"}` 提醒）。⚠️ **不要在这里尝试调整知识点顺序** —— 前置顺序已由拓扑序保证（§4.2），"前移"只能在同层内做。
   - ✅ **已修（2026-10-11 审核）**：本条的 Read 与规则 1 的 Read 若是**同一份资料**，只保留一条（统一走 `pushRead` 去重，键 = 归一化资源路径）。修前会生成 `[读 X, 读 X, 讲解, 做…]`。
6. 🔴 **薄弱题型优先**（题面 L3 完成标志③"增加薄弱**题型**训练"）：选主练习题与回炉题时，
   先看该题 `kind` 的 `kindState` 是否低于阈值（`MASTERY_THRESHOLD`），薄弱题型排在前面；
   之后才是"该题覆盖知识点的最高考频"，最后用题目名码点序保证确定性。
   ⚠️ **修前 `kindState` 只被写、不被读** ⇒ 题型掌握度对计划毫无影响，这一条是补的。
5. 🔴 **选"回炉题"的依据**：规则 2 要的"该知识点答错过的真题"，从 `data/answers.json` 的 `AnswerRecord[]`（§3）里筛 —— `answers.filter(a => a.pointNames.includes(key) && a.status !== "correct").map(a => a.problemName)`。**不要靠解析 `HistoryEntry.detail` 这种人类可读文本**。

### 4.8 `record(learn)`（L3）

- `Do(problem, status)`：
  - 对**每个** `problem.points`：`const key = normalize(p.name); state.set(key, clamp01(masteryOf(state, key) + delta(status)))`（`delta` 与先验见 §11）—— **必须用 `masteryOf()` 读旧值**（冷启动为 0.5，做错才真的下降）；
  - 同时写一条结构化 `AnswerRecord`（§3）到 `data/answers.json` —— §4.7 规则 2 的"回炉题"靠它筛；
  - 更新 **`kindState[problem.kind ?? "未分类"]`，用同一条公式、同一幅度**（也用 `masteryOf(kindState, kind)` 读旧值）—— 这就是题面演示第 4 步要求的"**题型掌握度**"；
  - 记一条 `HistoryEntry`（带 `before` / `after`），供"区分偶然做错与稳定薄弱"与决策回放使用。
- `Read(resource)` / `Skip(point)` / `Ask(question)`：各记一条 `HistoryEntry`；`Skip` **不改**掌握度；`Ask` 标"有疑问"（`makePlan` 可据此给该点加 `Explain` 或提前）。
- **ask 分支回填**：`ask()`（§4.10）结束后必须把结果作为一条 `Ask` 记录写进 `history`，**资料不足时 `answer = null`**（§3）。
- **必须持久化**：`data/state.json`（结构 `{ "state": Record<string,number>, "kindState": Record<string,number> }`）+ `data/history.json`。**落盘一律走 §3 的 `stateToJSON` / `stateFromJSON`，不要直接 stringify Map**。
- **状态更新公式要写进 README**（评审会问"为什么这么变"）。

### 4.9 `analyzeRes` / `analyzePro`（L2，需要模型）

- 读 md → 切分 → 调模型 → **拿结构化结果** → 过 **schema 校验** → 返回 `AnalyzeResReq` / `AnalyzeProReq`。
- **格式保障**：优先用 **JSON Schema 校验**（不引入 ajv 的话，手写校验函数）；校验失败**重试一次**，再失败则**报错并跳过该文件**（不要写入脏数据）。
- **切分**：> 3000 字按标题/段落切，逐块分析后**合并**（同一次分析的 points / edges 取并集）。
- **必须区分资料与真题**（按 §7 目录规则）。

> 🔴 **补注（2026-10-11 修 P0，实现期把两点定死了）**：
> 1. **路径是四级、且顺序由调用方选**：`路 A 模型 → 路 B 声明 → presets 兜底 → 报错/如实 0 点`。
>    - **网页壳的上传 / `/api/analyze` 用"模型优先"**（`preferModel`）：真课件转出来的 md **没有** `## 知识点:` 声明，只走规则就是"上传成功但静默 0 点"，L2 主路径等于没接线；
>    - `l1-demo` 与启动接入用"声明优先"（不花 Token、离线稳定）；`full-demo` 用 `forceModel` 演兜底。
> 2. 🔴 **`SimNet.analyzeRes()` 查 presets 必须用 `inputDir`（输入侧），不是 `dataDir`（产物侧）**：网页壳的 `dataDir` 是 `data/.runtime` ⇒ 修前它去读 `data/.runtime/presets/…`（永远不存在），**presets 兜底在网页里实际不可达**。响应/日志要带 `extractedBy: "model" | "preset" | "rule"`，一份都抽不出时给 `note` 说明原因。
>
> ⚠️ **presets 的键 = 资源名字符串**（与 `T2_DATA_DIR` 写法同形）：相对 `data` ⇒ 键写 `data/materials/x.md`；绝对路径 ⇒ 键写 `<绝对路径>/materials/x.md`（反斜杠已换成 `/`）。键不匹配时**静默不命中**，改目录口径时要一起改（§8 用例 21 就是钉这个的）。

### 4.10 问答（L2 1.2）

`ask(question): Promise<AskResult>`（签名见 §3；返回 `{ question, answer, citations, sufficient, fallback? }`）

- 检索（关键词 / FTS + 可选向量）→ 取 top-k 片段（默认 5，§11）→ 让模型**仅依据片段**作答 → 返回**带引用**：每条引用给 `resource` + `locator`（md 用标题路径）+ `snippet`。
- **资料不足时 `sufficient=false`、`answer=null`**，明确提示"资料不足，无法回答"，**不得用模型自身知识补全**。
- 🔴 **"不足"必须是可复现的数值判定**（否则无 Key 时全靠感觉，答辩一问就穿）：
  - **向量模式**：`top1 相似度 >= 0.45`（**定值见 §11，非临时可调项**，需写进 README）；
  - **关键词模式**：`命中片段数 >= 1` **且** `查询词项覆盖率 >= 0.5`（覆盖率 = 查询去停用词后的词项出现在命中片段里的比例；**定值见 §11**）；
  - 两条都不满足 ⇒ `sufficient=false`、`answer=null`；
  - **有 Key 时**：先跑上述判定当下界，模型仍可判"片段与问题无关"把 `sufficient` **降**为 false，**但不得升高**。
    ✅ **已实现（2026-10-11 审核后补）**：模型返回文本里若自述"资料不足 / 信息不足 / 无法回答 / 文中未提及 / 资料不足以回答"等，
    一律**降**为 `sufficient=false` 且 `answer=null`（出处照旧返回，便于人工复核，Ask 记录照旧回填）。
    ⚠️ 修前只判了检索阈值 ⇒ 模型自己说"资料不足"也会被当成有效回答返回（§8 用例 32/33）。
- **上下文包（L3 完成标志④）**：除资料片段外，模型上下文**必须**再注入一份**只读**摘要 —— ① 相关点的 `state` / `kindState`（走 `masteryOf()`）；② 相关真题（`queryPoint`）与结构化作答记录（`data/answers.json` 里该点的 `AnswerRecord`，取最近 **N=5** 条）；③ 相关 `HistoryEntry`（最近 **M=5** 条）。**N=5 / M=5 为定值，见 §11。**这三项**只读**，模型要改只能走 `record`。README 写明注入了哪些字段。
- **回填记录**：无论充足与否，都要 `record({kind:"Ask", question, answer, citations})`（§4.8）—— 这样"提问"也是可追溯的学习行为。
- **降级**：无 chat Key 走抽取式（直接返回命中片段 + 出处，`fallback:"extractive"`）；无 embedding Key 时检索退化为关键词（`fallback:"keyword"`）。两条降级路径下 **`sufficient` 语义不变**（§9.3）。

### 4.11 接入流水线（资料 / 真题各自怎么进来）

⚠️ **先有鸡还是先有蛋**：`analyzePro(problem)` 的入参已经是带 `points` 的 `Problem`，但真题 md 里只有题面 —— `points` 恰恰要靠模型抽出来。所以**必须先有一个纯文本解析步骤**，再调模型。

**资料（`data/materials/*.md`）**

1. `parse.ts` 读文件 → 按标题/段落切分（>3000 字，§11）→ 得到 `chunk[]`（**每块带标题路径**，供引用定位）；
2. 逐 chunk 调模型 → 过 schema 校验（§4.9）→ 得到 `{ points, edges }`；
3. 合并同一文件各 chunk 的结果（`points` / `edges` 取并集、去重）；
4. 组装 `AnalyzeResReq { resource, points, edges }` → `integrate`。

**真题（`data/problems/*.prob.md`）—— 两条路任选一条（**本计划书默认走路 B；有 Key 的 `full-demo` 走路 A —— 见 §11**），README 写明选了哪条**

- **路 A（有 Key / 联网时走这条，见 §11）**：约定文件格式

  ```
  # 2023 期末 T3            ← 题名（Problem.name）
  ## 题型: 计算             ← 可选；缺失则 "未分类"

  3 + 2 * 3 = ?             ← 题干（Problem.content），至下一个 # 或文末
  ```

  `parse.ts` 先解出 `{ name, content, kind, points: [] }`（**points 留空**）→ 调 `analyzePro` 补 `points` → `integrate(ProReq)`。
- **路 B（离线友好，`l1-demo` 走这条）**：md 里**显式写关系声明**，`parse.ts` 直接切出，**跳过模型调用**：
  - 真题 md：`## 涉及知识点: 整数加减, 整数乘除` → `Problem.points`
  - 资料 md：`## 知识点: 整数加减, 整数乘除` → 该资料的 points；`## 前置: 整数加减 -> 整数乘除`（**每行一条**）→ edges

  这样"资料 → 知识体系"这条链在**完全离线**时也能真跑（题面演示第 1 步）；`data/presets/analyze-req.json` **只作兜底**（md 里没写约定时才用）。
- ⚠️ 两条路都要求：`analyzePro` 的返回值里 **`problem` 必须原样带回**（含 `name` / `content` / `kind`），只补 `points`。

### 4.12 网页壳的 API 路由（**加分项**，CLI 不依赖它）

> 原生 `node:http` + 手写路由表，JSON 进 JSON 出；前端用 `fetch` 直接调。
> 💡 **可参考 `D:\HUST\知识库助手\src\server.js` 的写法**（`send()` / `readBody()` / 静态文件 + MIME / SSE / Range 这几段值得照思路重写）。⚠️ **不能直接拷**：它是 **CJS**（`require`）且 `require` 了 7 个本地模块（`config` / `store` / `embed` / `extract` / `deadline` / `tunnel` / `search`，其中 `store` 又依赖 better-sqlite3），而本项目是 `type: module` 的 **ESM + 零依赖**。前端复用见 §6.3。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/` `/ask` `/learn` | 三个静态页（`public/`） |
| `GET` | `/api/graph` | 知识点清单 + 前置边 + 考频榜（`pointMention`） |
| `GET` | `/api/point?name=…` | `queryPoint`：资料 / 真题 / 题型 |
| `GET` | `/api/plan` | 当前 `makePlan()` 结果 |
| `POST` | `/api/ask` | `{question}` → `AskResult`（含 citations） |
| `POST` | `/api/record` | `LearnRecord` → 更新并落盘，返回新 `state` / `kindState` |
| `GET` | `/api/files` | 列出 `data/materials/`、`data/problems/` 已有文件 |
| `POST` | `/api/analyze` | `{file}` → 触发 `analyze → integrate`（对已在 `data/` 里的文件） |
| `POST` | `/api/upload` | `{name, content, target:"materials"\|"problems"}` → **真上传**：落盘 → 自动触发分析（§2.1） |

⚠️ **不做 `multipart/form-data`**（§2.1）：省的是 multipart 解析，**不是上传功能本身**。前端 `fetch` 读到文件文本后走 `POST /api/upload`（JSON）即可实现**真上传**，成本极低 —— §8 用例 7/8 本来就要在网页上跑，别把它降级成"只能选已有文件"。

### 4.13 模型提议学习动作 → 校验 → 拒绝（L3 完成标志⑤ / §8 用例 10）

§4.7 的动作填充是**纯规则**的；要让"模型做出不合法操作时后端不直接执行"这条**可测**，必须真的存在一条模型提议通道，否则用例 10 没有可跑路径。

- **接口**：`proposePlan(draft: unknown): { accepted: boolean; plan?: LearnPlan; rejected?: string[] }` —— 模型只允许返回"知识点名 + 动作意图"的 JSON 草稿，**不得直接改 `state`**。
- **必须全过的校验（任一不过 = 拒绝）**：
  1. schema 校验（字段 / 类型 / 枚举，复用 §4.9 的手写校验器）；
  2. 每个知识点名按**归一化名**能在 graph 里查到（`dead` 点不算）；
  3. `{kind:"Read"}` 的 resource 必须在该点的 `resources` 里；
  4. `{kind:"Do"}` 的 `problem.name` 必须已在 `problems` 里 —— **禁止模型编造真题**；
  5. 顺序必须满足 `from → to` 拓扑约束；
  6. 每个知识点**恰好一次**（同 §4.2）。
- **拒绝行为**：**不执行**、记一条决策日志（拒绝原因 + 原始草稿），并**回落到 §4.7 的规则版计划** —— 演示时这条回落必须能看见。
- ⚠️ **§4.1 的"隐式建点"只适用于 `AnalyzeResReq.edges` 的端点补全**（那是资料抽取的容错），**绝不适用于本条**：模型提议里引用不存在的知识点 / 真题 = 直接拒绝。

### 4.14 `graph.json` 的序列化与载入（别只做 `state` 就完事）

- **结构**（`pid` 必须等于数组下标；`prev` 落盘时存 **pid 数组**，避免"同一份真相存两遍"）：
  ```json
  {
    "version": 1,
    "resources": ["data/materials/a.md"],
    "points": [{ "name": "整数加减", "resources": ["data/materials/a.md"], "prevPids": [0], "dead": false }],
    "problems": [{ "name": "2023 期末 T3", "content": "...", "kind": "计算", "pointPids": [0, 2] }],
    "pointMention": [3, 1]
  }
  ```
- **何时写**：`integrate` 成功后**原子写**（写 `graph.json.tmp` → `fs.renameSync` 覆盖），避免演示中途 Ctrl+C 留下半截文件。
- **何时载入**：进程启动时若文件存在则载入，并**重建"归一化名 → pid"索引**（§4.4 的比较口径依赖它）。载入时校验 ① `points.length === pointMention.length`；② 每条 `prevPids` / `pointPids` 都落在合法下标内；③ `pid` 与下标一致。**任一不过 ⇒ 丢弃该文件、按空体系重建**（打 warning），**不要带着错位的 pid 继续跑**。
- **建议**：内存里也直接用 `pid[]` 表示前置关系，导出时再用 `mapPidToPoint()` 还原成 §3 的 `Point[]` —— 这样合并 / 查询 / 改名都不用同步两份真相。
- `demo/verify-persist.ts` **要同时校验 `state.json` 与 `graph.json`**（重启后"掌握度"和"知识体系"都还在）。

---

## 5. 分层实施计划与验收

### L1（先做，最小可用）

**产出**：`src/types.ts`、`src/network.ts`、`src/normalize.ts`、**`src/qa.ts`（关键词 / 抽取式降级版）**、`src/analyze/parse.ts`（**只用到 §4.11 路 B 的规则解析部分**）、`demo/l1-demo.ts`、样例数据。
> 为什么 L1 就要 `qa.ts` + `parse.ts`：§8 用例 12 与 §9.2 第 3 步要求**离线**也能"解析资料 + 带引用问答 + 资料不足拒绝"，这两块不能留到 L2。  
**验收（可执行）**：

- `demo/l1-demo.ts`：构造 ≥3 份 `AnalyzeResReq`（含跨资料共享知识点、含不同名同义知识点）+ ≥5 道 `AnalyzeProReq` → 依次 `integrate` → `makePlan()` → 打印计划。
- 断言：① 计划里每个知识点**恰好一次**；② 所有前置关系都满足（`from` 在 `to` 前）；③ 再 integrate 一份新资料后，**新知识点并入且原顺序仍合法**；④ `pointRank(3)` 返回考频前 3；⑤ `queryPoint` 能同时给出资料与真题。
- 输出人类可读的：知识点清单、前置关系、考频榜、计划顺序。

### L2

**产出**：`src/analyze/*`（接模型）、`src/qa.ts`（L1 的降级版升级为向量 / 模型版）、`src/server.ts` + `public/`。  
**验收**：

- 放 3 份资料 md + 3 份真题 md 到 `data/` → 跑 `analyze → integrate` → 知识体系落盘到 `data/graph.json`（§7），内容为统一体系。
- 网页能：上传/选择资料 → 看到知识点、考频、三者关系；提问 → 回答带引用；问一个**资料里没有的问题** → 明确返回"资料不足"。
- 断言："资料不足"用例**不得**返回模型自造答案。

### L3

**产出**：`src/store.ts`、`src/plan.ts`（拓扑序 + §4.2 可行域内的计划调整）、`demo/verify-persist.ts`、网页的学习/做题界面。  
**验收（对应题面 5 条完成标志）**：

- 走一遍：选知识点 → 做真题 → 记作答 → `state` / `kindState` 变化**落盘**（用 `demo/verify-persist.ts` **另起进程**读回 `state.json` 验证，**别在同一进程里读内存冒充**）→ 再 `makePlan`，计划**发生可解释的变化**（**该点动作加量 或 同层内前移 —— 两者都在拓扑序内，见 §4.2**）。
- 断言：模型返回不合法动作（如引用不存在的真题）时，**后端拒绝执行**并记录。

### 进阶（任选，按剩余时间）

建议优先：**保存每次 AI 决策依据（可回放）** + **控制 Token/调用次数** + **"概念不会 vs 会概念不会做题"的区分**。这三项最容易在答辩时讲出彩。

---

## 6. 可复用资源映射（**参考，不强制依赖**）

> ⚠️ 下面路径存在于需求方本机；**执行者若拿不到这些文件，按 §3/§4 规格从零实现即可**，不要因此阻塞。

| 需求                    | 参考实现  | 位置                                                                                                     | 复用什么                                |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 资料解析（PDF/md → 文本）     | 知识库助手 | `D:\HUST\知识库助手\src\extract.js`                                                                         | 解析流水线的做法（**核心版只要 md 解析**，PDF 可后续加）  |
| 切片 + embedding + 向量检索 | 知识库助手 | `.../src/embed.js`、`store.js`、`search.js`                                                              | 切片策略、智谱 `embedding-3` 调法、FTS+向量混合检索 |
| **带引用出处的问答**          | 知识库助手 | `.../src/server.js` + `public/`                                                                        | "回答 + 引用出处 + 相似度 + 点引用跳原文"的交互       |
| 知识树 + 前置边数据模型         | kids  | `D:\qihong\qihong-cloud\web\kids\js\knowledge-tree-browse.js`（`kp.prerequisites`）                      | `PointGraph` 的前置边表达方式               |
| **掌握度 / SRS / 推荐逻辑**  | kids  | `ai_knowledge_mastery`（`mastery` / `srs_box` / `next_review_at`）、`/api/ai-practice/{submit,recommend}` | L3 学习状态与"下一步学什么"的算法骨架               |
| 讲解文案（Explain 动作）      | kids  | `cloud/people/services/ai-teacher-service.js`                                                          | 讲解/TTS 的提示词风格                       |

**关键不可复用点（必须新写）**：**"资料 → 知识体系的自动抽取"**。kids 的知识树是**教材预编排**的（前端硬编码 `UNIT_LESSON`），题 2 要求的是**上传资料后自动构建**——这正是 L2 的核心考点。

### 6.2 开源参考项目（GitHub API 实查，2026-10-11；★/许可为查询时快照）

> ⚠️ **两条纪律**：① **无 LICENSE 的仓库 = 默认"保留所有权利"，法律上不能抄代码**，只能读设计/思路；② **抄来的代码在答辩时更答不出**——本题评审会深挖细节，因此**只借"设计、提示词思路、Schema"，不整体引入外部代码**。凡下表标注"无许可"的，一律**只看不抄**（含提示词原文）。
>
> **本次核查更正**：`flyboat403` 上一版被标为 MIT，实为**无许可**，其提示词路径也更正为 `references/extraction-prompt.md`。
>
> 🔒 **硬约束**：本表许可是 2026-10-11 的快照，**仅供选题参考；执行者不得据本表判断许可**。凡未明确标注宽松许可（MIT / Apache-2.0 等）的仓库，**一律禁止复制其代码与提示词原文**（"只改一点"的改写也算）。表内结论以仓库当前 `LICENSE` 文件为准。

**第一梯队：TypeScript + MIT ⇒ 可直接读实现（照实现思路自己写，并在 README 注明来源）**

| 项目                                                                                                                 | ★ / 语言 / 许可                | 借什么                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Wanjin5508/vault-coach**<br />`github.com/Wanjin5508/vault-coach`                                                | ★8 / TypeScript / **MIT**  | **本表最贴合题 2 全流水线的项目**（Obsidian 插件、本地优先、497 文件）：md/文本 PDF 切片并**保留标题层级 / 文件路径 / 页码用于引用** → **带证据的概念与关系候选抽取** → 确认/驳回式概念审查 + **合并与别名** → **掌握度** → **自适应测验靶向**（诊断 / 薄弱复习 / **前置知识** / 混合）→ Learning Map 有向关系浏览。重点对照：`src/app/semantic-graph/concept-extraction-service.ts`、`concept-similarity-index.ts`、`src/app/mastery/mastery-service.ts`、`src/app/exam/adaptive-exam-planner.ts`。**§4.5 合并、§4.7 动作选择、§4.10 引用口径**三处据它校准 |
| **Kaiji-Z/LookatStudy**<br />`github.com/Kaiji-Z/LookatStudy`                                                      | ★6 / TypeScript / **MIT**  | **L3 学习状态层最佳参考**（已核实源码存在）：`src/main/services/pure/bkt.ts`（BKT 掌握度）、`pure/sm2.ts` + `srs.ts`（SM-2 复习调度）、课程门控；仓库还有 `scripts/verify-bkt.mjs`、`verify-srs-bkt-loop.mjs` **可借鉴的验证脚本写法**                                                                                                                                                                                                                                       |
| **Kaiji-Z/dsh-plugin-lookatstudy**<br />`github.com/Kaiji-Z/dsh-plugin-lookatstudy`（npm: `dsh-plugin-lookatstudy`） | ★18 / TypeScript / **MIT** | 上面那套的 **DSH 插件版**，**本机这套 harness 能真装真跑**（`dsh plugin add dsh-plugin-lookatstudy`）：每课派生 2–7 个知识点(KC)、按 KC 记录作答、**课掌握度 = 最弱知识点**、掌握度驱动解锁（≥50% 提前解锁 / ≥90% 毕业并排 SM-2）、**propose→apply 的提议卡（用户批准才生效）**、摩擦点记录、学习者记忆三槽。**当"L3 做对了长什么样"的活样板**；虽为 MIT，仍建议只读设计                                                                                                                                                                    |


**第二梯队：设计参考（许可多数受限，只读）**

| 项目                                                                                                            | ★ / 语言 / 许可                                                       | 借什么                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PPixie/thinkraph**<br />`github.com/PPixie/thinkraph`                                                       | ★2 / TypeScript / **无许可**（已核实：仓库树内**无 LICENSE 文件**）               | 数据模型最贴：知识点组成 **DAG**，每节点带"对话 / 笔记 / 资料 / 掌握状态"，**JSON 本地存储**，要求 Node ≥ 22.21.1（**与我们的 Node 22 选型一致**）。读 `docs/architecture.md`、`docs/product-design.md`、`shared/domain/graph.js`、`tests/graph.test.js`，校验我们的 `PointGraph` 是否漏字段。⚠️ 只比对字段，不抄代码                                                                                             |
| **MysterionRise/adaptive-knowledge-graph**<br />`github.com/MysterionRise/adaptive-knowledge-graph`           | ★17 / Python / **MIT**                                            | 场景最像（开放教材 AI 导师）：**BKT 掌握度**（README 中 BKT 5 处，IRT 仅 1 处提及）、**带编号引用的问答**、`PREREQ`/`RELATED`/`COVERS` 三类关系、KG 扩检索与普通 RAG 对比页。⚠️ **但依赖 Neo4j + OpenSearch + Ollama，本机跑不起来也不该跑**——只读 `docs/` 的架构设计，**不要试图部署**                                                                                                                                 |
| **moaaz-ae/plcourse**<br />`github.com/moaaz-ae/plcourse`                                                     | ★9 / TypeScript / **MIT**                                         | 比我们 §11 更进一步的调度设计：DAG 的**前置边带 0–1 权重**（"前置练到什么程度算够"）+ **FSRS v6** 复习调度（比 SM-2 新）。若要把 §11 固定 ±0.15 的掌握度公式升级为证据加权，参照它                                                                                                                                                                                                                       |
| **wttwins/wrong-notebook**<br />`github.com/wttwins/wrong-notebook`                                           | ★745 / TypeScript / **无许可**                                       | 中文**错题本**最高星：真题 → AI 生成解析 + **知识点标签**、按**掌握状态 / 知识点**多维筛选、薄弱项同类题生成、掌握情况统计。**"真题作答 → 知识点掌握度"的产品形态与统计口径**可参照。⚠️ 只读设计；技术栈 React19 + SQLite/Prisma + Docker，与本项目零依赖目标不一致                                                                                                                                                                      |
| **himanshu-nakrani/Knowledge-Weaver**<br />`github.com/himanshu-nakrani/Knowledge-Weaver`                     | ★3 / TypeScript / **无许可**                                         | 文档摄入（PDF/MD/URL/repo）+ BM25 + LLM 查询扩展 + 实体抽取（Mermaid 可视化）+ 闪卡间隔重复，与 L2 摄入/抽取同构。Postgres + Groq，只读设计                                                                                                                                                                                                                                      |
| **flyboat403/knowledge-graph-extraction-skill**<br />`github.com/flyboat403/knowledge-graph-extraction-skill` | ★5 / Python / **无许可**（已核实：license API 404，无 LICENSE 文件）           | ⚠️ **许可已由 MIT 更正为无许可**。实为 14 文件的 Claude-skill 提示词包：`SKILL.md`、`references/extraction-prompt.md`（**不是** `prompts/extraction_prompt.md`）、`references/relation-prompt.md`、`references/quality-check-prompt.md`、`references/output-format.md`、`scripts/extract_knowledge_graph.py`。**读懂它"层次化节点 + 前置/后置/关联关系"的输出 Schema 应该长什么样，提示词按 §4.9 自己写** |
| **iyysa/ai-knowledge-graph-assistant**<br />`github.com/iyysa/ai-knowledge-graph-assistant`                   | ★0 / Python / **无许可**                                             | 四模块划分（知识点抽取 / 图谱构建 / 关联出题 / **学习路径推荐**）+ 用 DeepSeek。其 README 的"传统做法 vs AI 做法"论证表，**答辩可直接借用**                                                                                                                                                                                                                                              |
| **Jia-Yee/elementary-math-tutor**<br />`github.com/Jia-Yee/elementary-math-tutor`                             | ★1 / Python / **无许可**                                             | **同学科场景**（小学数学，与题面"整数加减法"示例一致）：知识图谱 + Fastify API + 4 个 skill（讲解/出题/可视化）。只作场景参考                                                                                                                                                                                                                                                           |
| **mayankjndl/vidyamind**<br />`github.com/mayankjndl/vidyamind`                                               | ★4 / TypeScript / **无许可**（README 挂 MIT 徽章，但 license API 与仓库树均无许可） | Next.js/React19 全栈：KG 诊断 + **BKT** + 间隔重复学习计划 + rubric 评分。徽章与许可不一致，**用前必须核实**；只读设计                                                                                                                                                                                                                                                        |
| microsoft/graphrag · HKUDS/LightRAG                                                                           | ★36k / ★40k / 均 MIT、Python                                        | **不建议引入**（重、需额外服务）。只借"实体-关系抽取 + 社区摘要"的思路                                                                                                                                                                                                                                                                                                  |

**落到本计划的动作**（执行者按此做）：

1. L2 的**抽取与概念审查** → 对照 `vault-coach` 的 `concept-extraction-service.ts` / `concept-similarity-index.ts`：候选关系带证据、确认后才入图、**别名与合并**。提示词与输出 Schema 按 §3/§4.9 自己写（`flyboat403` 只用来对齐 Schema 形状）；
2. L2 的**引用式问答** → 参考 `vault-coach` 的"标题层级 + 文件路径 + 页码"引用口径 + 本机知识库助手；
3. L3 的**掌握度与复习调度** → 参考 `LookatStudy` 的 `bkt.ts` / `sm2.ts`（MIT，**README 需注明借鉴来源**）；要把 §11 的固定公式做扎实，再看 `plcourse` 的加权前置 + FSRS v6；
4. L3 的**状态机与交互** → 用 `dsh-plugin-lookatstudy` 当活样板（本机可装可跑），验证"掌握度驱动解锁 / 薄弱点优先 / 改档案必须用户批准"这条流程；
5. 数据模型 → 对照 `thinkraph` 的 `docs/architecture.md` 与 `shared/domain/graph.js` 校验 `PointGraph` 是否遗漏字段（无许可，只比对字段不抄代码）。

**核查留痕**：`flyboat403` 许可 MIT→**无许可**、提示词路径更正；`thinkraph`（树内无 LICENSE）、`vidyamind`（徽章≠许可）"无许可"结论**成立**；`LookatStudy` 的 BKT/SM-2 与 `MysterionRise` 的 BKT/引用问答**已在源码或 README 中核实**；**新增 4 个候选**：`vault-coach`、`dsh-plugin-lookatstudy`、`wrong-notebook`、`plcourse`。

### 6.3 本机前端复用清单（**网页壳专用**，2026-10-11 实查）

> 这两个都是**需求方自己的项目** ⇒ **无第三方许可问题**（与 §6.2 的 GitHub 项目不同），可以直接搬代码。
> ⚠️ 但**只搬前端**：两者的后端都依赖 SQLite 原生模块 / 鉴权服务，与 §0 的"零第三方依赖"冲突。

#### 6.3.1 `D:\HUST\知识库助手` —— **ask.html 的最佳来源，建议直接用** ✅

形态完全同构：`public/` 是原生 HTML/CSS/JS、**无构建、无模块**（`index.html` 用 `<script src="/public/core.js">` 引全局函数），`src/server.js` 是**纯 `require('http')`、无框架**（616 行）。

| 我们要的 | 它已经有的 | 位置 |
| --- | --- | --- |
| §4.10 带引用的问答渲染 | `renderSources()`：`📎 引用出处（N 个文件 · 合并自 M 处命中）` 折叠面板 + 相似度 + 片段 + `打开原文` | `public/core.js` 的 `mergeSources` / `renderSources` |
| 引用编号可点、跳回原文 | `[n]` → `<button class="cite" data-cite>`，事件委托跳到对应出处（含 PDF 定位） | `public/core.js` |
| §3 的 `Citation{resource, locator, snippet, score}` | 它的 `sources[]` 是 `{path, heading, chunkId, snippet, score}` —— **几乎一一对应** | — |
| 流式回答 | `POST /api/ask/stream`：SSE 事件里带 `sources`，边流边渲染 | `public/core.js` |
| §4.12 服务端骨架 | `send()` / `readBody()` / 静态文件 + MIME / SSE / 二进制 Range | `src/server.js` |
| 资料树 + 全文搜索 + 定位到段/页 | `/api/tree` 懒加载树、`/api/search/full`、`/api/file/text` + 页码大纲 | `public/docs.js` |

**做法（推荐）**：把它当**组件库**——复制 `public/core.js`、`public/core.css` 到本项目的 `public/`（§7 目录已列），并在 §4.12 里**加一层兼容端点**（把 §4.10 的 `AskResult.citations` 包装成它的 `sources` 形状、SSE 事件名对齐）。
**不要改原项目**；也**不要**把它的 `store.js` / `search.js` / `embed.js` / `better-sqlite3` 搬过来（那是它自己的 SQLite 后端，与零依赖目标冲突）。

**它没有、只能新写的部分**：知识点 / 考频 / 前置关系 / 学习计划 —— 它整站是"文件树 + 全文搜索 + 问答"，**没有"知识点"这个维度**。

#### 6.3.2 `D:\qihong\qihong-cloud\web\kids` —— **不建议复用前端，只借信息架构** ⚠️

- **强依赖登录态**：每个页面首屏就 `getQhToken()`（读 `localStorage` 的 `qihong-auth` / `qh_token`）+ `Authorization: Bearer` 调 `/api/brain/*`、`/api/ai-teacher/*`、`/api/ai-practice/*` ⇒ **脱开后端连首屏都渲染不出来**。
- **体量**：`js/knowledge-tree-browse.js` **150KB**、`js/lesson.js` **205KB** 单文件，混着语音评测、错题本、进度同步等大量业务，**剥离成本高于重写**。
- **视觉不符**：儿童闯关风（coral 配色、徽章、能量条），与题 2"期末复习工具"的调性不搭。
- **值得借的（只借结构 / 思路，不搬代码）**：
  - `knowledge-tree-browse.js`：前置关系树 + **掌握度条** + **推荐卡（`/api/ai-practice/recommend` → accept）** 的交互 → 给 `learn.html` 参考；
  - `progress.html`：**错题本 / 学习次数 / 复习计划** 三块信息架构 → `learn.html` 可照这个排。

#### 6.3.3 三个页面的复用结论

| 页面 | 结论 | 省力程度 |
| --- | --- | --- |
| `public/ask.html`（问答带引用） | **复用知识库助手**：`core.js` + `core.css` + §4.12 兼容端点 | 🟢 §4.10 的 UI 基本白送 |
| `public/index.html`（知识点 / 考频 / 关系总览） | **新写**；沿用 `core.css` 的样式变量与 `docs.js` 的树形懒加载写法，但数据是"知识点 / 考频 / 前置边"，两边都没有现成页 | 🟡 半天量级 |
| `public/learn.html`（学习 / 做题 / 计划） | **新写**；信息架构参考 kids 的 `progress.html` + `knowledge-tree-browse.js` 的掌握度条 / 推荐卡，视觉不照搬 | 🟡 半天量级 |

> 🔴 **纪律**：复用仅限 `public/` 的**前端文件**与 `server.js` 的**路由写法**；知识库助手的 `better-sqlite3` / `pinyin-pro` / `ssh2` 三个依赖**一个都不许进本项目**（README 里注明哪些文件是从本机项目搬来的）。

---

## 7. 目录结构

```
D:\aoce\problem2-learning-assistant\
├── README.md                  ← 交付物（§10）
├── PLAN.md                    ← 本文件
├── package.json               ← 仅声明 type:module 与 scripts，无依赖
├── docs/                      ← problem-statement.md（题面原文）+ defense/（《答辩问答》，见 §10）
├── src/
│   ├── types.ts               ← §3（全项目契约）
│   ├── network.ts             ← §4.1–4.6（SimNet：integrate / queryPoint / pointRank / 拓扑）
│   ├── plan.ts                ← §4.2 + §4.7（拓扑序 + action 填充 + 计划调整）
│   ├── store.ts               ← §4.8 + §4.14 持久化（state / kindState / answers / history / graph）
│   ├── normalize.ts           ← §4.5 归一化 + 别名表 + mergePoints
│   ├── analyze/
│   │   ├── parse.ts           ← §4.11 md 解析 + 切分 + 真题解析
│   │   ├── schema.ts          ← AI 输出校验（§4.9）
│   │   └── llm.ts             ← 模型调用（chat / embedding）+ §9.3 降级
│   ├── qa.ts                  ← §4.10
│   └── server.ts              ← §4.12 本地 HTTP + 静态文件 + API 路由
├── public/                    ← 原生 HTML/CSS/JS（无构建）
│   ├── index.html             ← 知识点/考频/关系 总览（新写）
│   ├── ask.html               ← 问答（带引用）— **基于 §6.3.1 的 core.js / core.css 改**
│   ├── learn.html             ← 学习/做题/计划（新写；信息架构参考 §6.3.2）
│   ├── core.js                ← 从 `D:\HUST\知识库助手\public\core.js` 复制（引用渲染 §6.3.1）
│   └── core.css               ← 从 `D:\HUST\知识库助手\public\core.css` 复制
├── data/
│   ├── materials/*.md         ← 资料（后缀 .md）
│   ├── problems/*.prob.md     ← 真题（后缀 .prob.md ⇒ 区分规则）
│   ├── aliases.json           ← 别名表（§4.5）—— **括号消歧只能靠它**
│   ├── presets/analyze-req.json  ← **兜底**：md 里没写关系约定时才用（§4.11 路 B）
│   ├── graph.json             ← 运行时生成：知识体系（结构见 §4.14）
│   ├── state.json             ← 运行时生成：{ state, kindState }（§4.8）
│   ├── answers.json           ← 运行时生成：AnswerRecord[]（§3 / §4.8）
│   └── history.json           ← 运行时生成：HistoryEntry[]（§4.8）
├── demo/
│   ├── l1-demo.ts             ← 5 步离线演示（§9.1，读 presets/）
│   ├── full-demo.ts           ← 5 步完整演示（§9.1，真调模型）
│   └── verify-persist.ts      ← 另起进程读回 state.json，证明真落盘（§9.2 第 4 步）
└── tests/
    └── *.test.ts              ← 验收断言（可用 node:test）
```

**区分规则（写进 README）**：`data/problems/**/*.prob.md` = 真题；`data/materials/**/*.md` = 资料。

---

## 8. 验收与测试清单（执行者必须逐条覆盖）

跑法（写进 README）：

```bash
node --experimental-strip-types --test tests/*.test.ts
```

| #  | 用例                          | 期望                                          |
| -- | --------------------------- | ------------------------------------------- |
| 1  | 同一知识点出现在 2 份资料              | 只建 1 个 Point，`resources` 含 2 条              |
| 2  | 不同名同义知识点（如"整数加减"/"整数加法与减法"） | 合并为 1 个点                                    |
| 3  | 5 道真题覆盖 3 个知识点              | `pointRank(3)` 顺序正确                         |
| 4  | 前置边 A→B→C                   | 计划中 A 在 B 前、B 在 C 前                         |
| 5  | 每个知识点是否恰好出现一次               | 断言计数 == 1                                   |
| 6  | 再上传一份新资料                    | 体系更新成功，原计划仍合法                               |
| 7  | 问资料里有答案的问题                  | 返回答案 + 引用，`sufficient=true`                 |
| 8  | 问资料里**没有**的问题               | 明确提示资料不足，`sufficient=false`，**不编**          |
| 9  | 做错一道真题                      | `state` 下降且**落盘**；下次计划针对该点加题                |
| 10 | 模型返回不合法动作                   | 后端拒绝执行并记录                                   |
| 11 | **另起一个进程**（`node --experimental-strip-types demo/verify-persist.ts`）                        | 学习状态仍在（持久化生效）                               |
| 12 | **无 Key / 完全离线**跑 `l1-demo` | 5 步全部走完；用例 7 / 8 仍通过（§9.3 降级生效）             |
| 13 | 做错一个**带前置约束**的知识点           | 调整后的计划**仍满足 `from → to`**（未因"前移"破坏拓扑序）      |
| 14 | 对比做错前后的计划                   | 该点**动作数增加**或**同层内前移**（§4.2 允许的 3 种动作之一，可观测） |
| 15 | 做错一道 `kind:"计算"` 的真题 | **`kindState["计算"]` 同步下降**且落盘（题型掌握度，§4.8） |
| 16 | `ask` 一个资料不足的问题 | 返回 `answer=null` + `sufficient=false`，**且 `history` 新增一条 `Ask` 记录**（§4.10 回填） |
| 17 | 首次答错一道**从未学过**的点 | 掌握度从**先验 0.5 降到 0.25**（不是原地不动）—— 验证 §3 的 `PRIOR_MASTERY` 生效 |
| 18 | 模型提议里引用**不存在的真题 / 知识点** | **被拒**、记录拒绝原因、**回落规则版计划**（§4.13） |
| 19 | 归一化撞车（`整数加减(一)` / `整数加减(二)`，别名表未配） | **保留两个独立点**并记 warning，**不得静默合并掉一个**（§4.5） |
| 20 | 重启后再载入 `graph.json` | 知识点数 / 前置边 / 考频与重启前**完全一致**（§4.14，`verify-persist.ts` 一并校验） |
| 21 | **网页壳**上传一份"**没有关系声明**的资料"（有 presets 预置） | 走 `presets` 兜底、`extractedBy="preset"`、`points>0`，落盘并进 `/api/graph`（修掉"上传成功但静默 0 点"，见 §4.11 补注） |
| 22 | **网页壳**上传一份带 `## 涉及知识点:` 的真题 | `extractedBy="rule"`、点数与声明一致，且进体系可查 |
| 23 | 上传既**无声明**、presets 也**没有**的资料 | 如实返回 `points=0` + 可诊断的 `note`（**不假装成功、不写脏数据**） |
| 24 | `SimNet.analyzeRes()` 的预设兜底目录 | 读的是 **`inputDir`**（输入侧），不被 `dataDir`（产物侧）带偏 |
| 25 | **模型调用失败** + md **有**声明（把 `DEEPSEEK_BASE_URL` 指向不可达地址制造失败） | 来源如实标 **`rule`**（**不得**因为"回落结果也有 points"而谎报 `model`） |
| 26 | 模型调用失败 + md **无**声明 + presets **有**命中 | 来源如实标 **`preset`**（不是 model、也不是 rule） |
| 27 | 前置点与本点**共用同一份资料** | `Read` 动作**只出现一次**（修前是 `[读 X, 读 X, 讲解, 做…]`） |
| 28 | 同一知识点挂两道**不同题型**的题，压其中一种题型的 `kindState` | 主练习题切到**薄弱题型**那道（修前 `kindState` 对计划零影响） |
| 29 | 同一状态连续两次 `fillActions` / `makePlan` | 逐项一致（确定性，无隐藏随机/时间依赖） |
| 30 | 同一层里一个点已掌握（`>= 0.8`）、其余未掌握 | **已掌握排最后**（修前第一项反向，已掌握排最前 —— 与题面 L3 完成标志③相反） |
| 31 | 某点跨过阈值 | 动作用收敛为"一道巩固题"，不再安排读资料/讲解 |
| 32 | 模型回答里自述"资料不足"（用 `answerOverride` 注入，不联网） | 转成 `answer=null` + `sufficient=false`，且仍回填 `Ask` 记录 |
| 33 | 模型正常回答 / 模型调用失败（注入） | 正常回答原样返回；失败走抽取式降级；`isModelInsufficient` 判定边界（"足够"不得误判） |

---

## 9. 演示脚本（§1.5 的 5 步）

### 9.1 两个入口，**必须都能跑**

| 脚本                  | 依赖                                       | 用途                               |
| ------------------- | ---------------------------------------- | -------------------------------- |
| `demo/l1-demo.ts`   | **零外部依赖、离线可跑**：真读 `data/` 下的 md，按 §4.11 **路 B** 的规则解析出 points / edges（充当模型输出的替身） | **保底**。任何机器、任何网络、没有 Key 都能跑完 5 步，**且第 1 步"接入资料并解析"是真跑的** |
| `demo/full-demo.ts` | 需要 `.env` 里的 DeepSeek + 智谱 Key           | **完整版**，第 1 步真调模型做抽取             |

命令（写进 README，两条以内）：

```bash
node --experimental-strip-types demo/l1-demo.ts     # 离线保底
node --experimental-strip-types demo/full-demo.ts   # 需 Key
```

> ⚠️ **措辞对齐形态**：CLI 形态下没有"上传"这个动作 —— 说"把资料放入 `data/materials/`"。只有网页壳才有真正的上传。演示台词别混。

### 9.2 5 步（顺序打印）

1. **接入资料** → `parse → integrate`（**两个 demo 都真读 `data/` 的 md**：`l1-demo` 用 §4.11 路 B 的规则解析，`full-demo` 真调模型补 points / edges）—— 题面演示第 1 条要的就是这一步，**别用预置结果把它跳过去**
2. **再接入一份** → 展示体系"长了"：新增点 / 新增边
3. **提问**（一个资料够答 + 一个资料不足，对比展示来源引用与"资料不足"拒绝）
4. **记录一次真题作答（做错）** → 展示该知识点与**题型**掌握度变化，然后**另起一个进程**跑 `demo/verify-persist.ts` 读回 `state.json`，证明真的落盘（**不要在同一进程里读内存冒充**）
5. **重新 `makePlan`** → 展示计划因表现而变化：**该薄弱点的动作被加量/提前（在拓扑序允许的范围内）**，并追加一道回炉题
6. 🔴 **第 5 步·续：多轮**（题面演示第 5 条原话是"用户经过**多轮**学习和做题后"）——
   ① 连续答对直到跨过 `0.80` 阈值 ⇒ 该点被**排到同层最后**、动作收敛为一道巩固题
   （题面 L3 完成标志③"降低已掌握内容优先级"）；
   ② 同一道题**再错一次** ⇒ 掉出已掌握、`AnswerRecord` 里答错记录达到 2 条
   ⇒ 判定"**稳定薄弱**"（不是偶然做错），回炉题继续加量。
   ⚠️ 单轮（只做错一次）演不出第 5 步的"多轮"；这两个方向（做对 / 反复做错）都要演。

> 🔴 第 4 步的"重启再读"是**持久化的硬证据**，别省（`demo/verify-persist.ts` 就是干这个的；**不是在同一进程里读内存冒充**）。
>
> 🎤 **每一步都要打印"为什么这么做"**：用了哪些状态 / 数据 → 得出什么结论（例如"整数乘除掌握度 0.25 < 0.8 且考频最高 ⇒ 同层前移 + 加一道回炉题"）。题面明说会深挖细节、答不出可能被认为过度使用 AI，**演示脚本自带决策理由**能把这个风险前置消掉。

### 9.3 降级路径（无 Key / 无网时，演示不能崩）

| 缺什么             | 降级行为                                                        |
| --------------- | ----------------------------------------------------------- |
| 无 embedding Key | 检索退化为**关键词 / FTS**（纯本地，零依赖）                                 |
| 无 chat Key      | 问答退化为**抽取式**：把命中的原文片段直接返回 + 标出处；资料不足时仍返回 `sufficient=false` |
| 完全离线            | 走 `l1-demo`（**路 B 规则解析** md 得到 points / edges），5 步照跑                          |

> 🔑 **「资料不足」的判定规则见 §4.10（数值阈值，可复现）**：降级路径下必须输出**同样的 `sufficient` 语义** —— 判定不过就是 `answer=null` + `sufficient=false`，**不能因为"没 Key"就放水或改口**。

> 🔑 **要求：§8 的用例 7 / 8（带出处问答、资料不足拒绝）必须在"无 Key"下也能通过** —— 否则评审机没配 Key 就看不到这两个核心能力。

---

## 10. README 要求（交付物）

必须包含：① 一句话定位；② **启动方式**（两条命令以内 + 一条 `node --version` 自检）；③ **主要设计**（数据模型图、知识体系如何构建、计划如何生成、状态如何更新）；④ `区分资料/真题`的规则；⑤ **状态更新公式**与**环处理策略**的说明；⑥ 已实现 / 未实现（如实声明兼容范围）；⑦ 演示步骤；⑧ **Node 版本要求（≥22.6）**；⑨ **无 Key / 离线时的降级行为**；⑩ **每个模块的《答辩问答》**，放在 `docs/defense/`（题面"答不出细节 = 过度使用 AI"是唯一评分门，见 `D:\aoce\docs\handoff-to-dsh.md` §2.4）。

### 10.1 交付时一并带上的（题面第 1 页通用要求，最容易漏）

- **git 分阶段 commit** —— 每完成一个阶段提交一次，"方便我们了解你的动态"；**不用 git 则按小时在飞书文档同步**（写清：完成内容 / 背后思路 / 难点 / 解决方式）
- **留下 session** —— 与 AI 的对话记录或分享链接
- ⚠️ 题面原话：**"会对项目细节深入提问，如果答不出细节可能会被认为过度使用 AI"** ⇒ 交付前必须能讲清：状态公式为何这么定、抽取提示词为何这么写、降级为何这么设计

---

## 11. 默认值账本（正文取值一律以本节为准）

| 项          | 默认                                                                   |
| ---------- | -------------------------------------------------------------------- |
| **口径说明** | 📒 **本表是 §2–§10 全部默认值 / 阈值 / 可调参数 / 我方决定的汇总账本。凡正文写"未定 / 由 §11 拍板 / 可调"的项，取值一律以本表为准；正文与本节不一致属 PLAN 自身缺陷，须回报修正。** |
| 模型服务       | 聊天用 DeepSeek，向量用智谱 `embedding-3`；Base URL/Key 走环境变量 `.env`（**不硬编码**） |
| Top-k 检索条数 | 5                                                                    |
| 掌握度更新幅度    | 正确 +0.15、错误 −0.25、confuse −0.05，裁剪到 [0,1]（可调，需写进 README）；**`kindState` 用同一公式、同一幅度**（§4.8）             |
| **冷启动先验**   | **未学过的点 = 0.5**（`PRIOR_MASTERY`，§3）。读一律走 `masteryOf()`；`state.has()` 区分"没学过"与"就是 0" |
| 已掌握阈值      | 0.8                                                                  |
| 长文切分粒度     | **> 3000 字**按标题/段落切分（**以二级标题为主**），逐块分析后合并 points / edges（§4.9 / §4.11）                                                         |
| 环处理        | 打破环 + 日志告警（不抛异常）                                                     |
| 无 Key / 离线 | 检索退化为关键词、问答退化为抽取式（§9.3）；**演示仍须走完 5 步**                               |
| 「调整计划」可行域 / 优先级  | ① 同层内前移 → ② 加量回炉题 → ③ 同层换序（**只在拓扑序之内**：禁止把点移到其前置点之前；见 §4.2）                       |
| `.env` 加载方式 | `node --env-file=.env --experimental-strip-types …`（零依赖，**不装 dotenv**，§2.1）；`.env` 必须 **UTF-8 无 BOM**（带 BOM 会**静默失效**）⇒ **启动必须打一行 Key 自检** |
| 「题型」口径 | 从真题抽 `Problem.kind`；`kindState` 与知识点掌握度**同公式同幅度**；缺失记 `"未分类"`（§4.8） |
| 合并时机 | 默认**只做 integrate 时的入图前合并**；入图后合并用 `mergePoints`，不实现就抛错并在 README 声明（§4.5.1）；点入图前**先过 `data/aliases.json` 别名表再归一化**；合并产生的 `dead` 点不再算知识点（`topoOrder` / `makePlan` / `queryPoint` / 计数一律跳过） |
| 网页「上传」 | `POST /api/upload`（JSON，非 multipart）**真上传**；`/api/files` + `/api/analyze` 用于分析已有文件（§4.12） |
| 检索「不足」阈值 | 向量 `top1 >= 0.45`；关键词 `命中片段 >= 1 且 词项覆盖率 >= 0.5`（§4.10，需写进 README）；**有 Key 时模型只能把 `sufficient` 降为 false，不得升高** |
| 掌握度排序键 | `(已掌握 ? 1 : 0, 掌握度, -考频, normalize(name) 码点序)`，层内升序（§4.2 🔑） |
| **`state` / `kindState` 落盘** | **不得直接 `JSON.stringify(Map)`**（会得到 `{}`，状态静默丢光）；一律走 `stateToJSON` / `stateFromJSON`（§3 / §4.8） |
| **`answers.json` 保留策略** | 存 `AnswerRecord[]`；与 `history.json` 同策略：**保留最近 500 条**（超出按 `at` 裁剪）并在 README 写明（附二 3） |
| 上下文包注入条数 | 该点的 `AnswerRecord` 取**最近 5 条**（N=5）、`HistoryEntry` 取**最近 5 条**（M=5）（§4.10 已同步写定 N=5 / M=5，与本表一致） |
| **「回炉题」依据** | 从 `data/answers.json` 的 `AnswerRecord[]` 筛 `pointNames.includes(key) && status !== "correct"` → `problemName`；**禁止解析 `HistoryEntry.detail` 文本**（§4.7 规则 5） |
| 归一化「撞车」 | 同批 points 里两个**原本不同**的名字归一化后同 key ⇒ **保留两个独立点** + 记 warning，**不得静默合并**（§4.5；§8 用例 19） |
| 括号消歧 | `normalize()` **不碰括号**；`"整数加减(一)"` / `"整数加减(二)"` 的等价**只能靠 `data/aliases.json` 显式声明**（§4.5） |
| 语义合并（embedding） | 核心版**默认不做**，只做字符串归一 + 别名表；要做只产**候选对**、按阈值 / 人工确认，**不得自动合并**（§4.5 / 附二 4） |
| 真题解析路线 | **默认走路 B**（md 里显式 `## 涉及知识点:` / `## 知识点:` / `## 前置:` 声明，可离线，`l1-demo` 走它）；有 Key 时 `full-demo` 走路 A（`# 题名` + 可选 `## 题型:`）；README 写明选了哪条（§4.11） |
| **`graph.json` 载入校验** | 校验 ① `points.length === pointMention.length` ② `prevPids` / `pointPids` 均在合法下标内 ③ `pid` 与下标一致；**任一不过 ⇒ 丢弃该文件、按空体系重建 + warning**；写盘用 `.tmp` → `renameSync` **原子写**（§4.14） |
| 模型输出校验失败 | **重试 1 次**；再失败 ⇒ 报错并**跳过该文件**，不写脏数据（§4.9） |
| `Citation.snippet` 长度 | 截断到 **≤ 200 字**并标省略号（§3） |
| 资料 / 真题区分 | `data/materials/**/*.md` = 资料；`data/problems/**/*.prob.md` = 真题；写进 README（§2 / §7） |
| 输入约定 | **只吃 md**；pptx / pdf **不直接解析**，需先转 md（§0 第 6 条）—— 写进 README 的"输入约定"与"未实现"两处 |
| 样例数据规模 | 最少满足 §5 L1 的 ≥3 份资料 + ≥5 道真题、L2 的 3 份资料 + 3 份真题；**建议** `data/materials/` 3–4 份（每份 500–1500 字）、`data/problems/` 5–8 道；另备 1 个"**故意资料不足**"的问题供 §8 用例 8（§5 / 附二 2） |
| **《答辩问答》产出位置** | **`docs/defense/`**（每个模块一份；§10 ⑩ / §7） |

---

## 附：给执行者的第一步

1. 建 `types.ts`（§3 原样）+ `network.ts` 骨架；
2. 写 `normalize.ts`（§4.5）；
3. 造 3 份样例资料 + 5 道真题（`data/`），跑 `demo/l1-demo.ts`；
4. 通过 §8 的用例 1–6 后再进 L2。

---

## 附二：已知待办（不影响开工，交付前要处理）

1. ✅ **§10.1 的通用要求出处（已完成 2026-10-11）** —— git 分阶段 commit / 留 session / "过度使用 AI 会被追问" 三条的**原文已收入 `docs/problem-statement.md` §1**（PDF 第 1 页全局要求逐字），不再需要人工核实。
2. **样例数据的主题与规模** —— 建议与题面示例一致（小学数学：整数加减、整数乘除、分数…）：`data/materials/` 3–4 份（每份 500–1500 字），`data/problems/` 5–8 道；另备一个"**故意资料不足**"的问题供 §8 用例 8 使用。
3. **`history.json` 的保留策略** —— 目前无上限，长期跑会变大；**保留最近 500 条（超出按 `at` 裁剪），并与 `answers.json` 同策略 —— 定值，见 §11**，并在 README 写明。
4. **语义合并是否做** —— 当前只做归一化 + 别名表；若要冲题面"尽量合并"的加分，用 embedding 产**候选对**再按阈值/人工确认，**不要自动合并**（参考 §6.2 的 `vault-coach`）。
5. ✅ **题面原文归档（已完成 2026-10-11）** —— 已落盘 **`docs/problem-statement.md`**（350 行；来源 PDF 第 1 页 + 第 4–11 页，逐字摘录；含"演示至少完整跑通 5 步""交付与范围""评分口径"三段原话）。§1 顶部已改为指针。**遗留**：附二第 1 条随之闭环（见下）。
