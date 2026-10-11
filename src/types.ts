// ============================================================================
// src/types.ts — 全项目契约（PLAN §3）。后续所有模块都 import 这里。
//
// ⚠️ 运行方式：node --experimental-strip-types（Node ≥ 22.6）。因此：
//   - 相对 import 必须带 .ts 后缀
//   - 禁用 enum / namespace / 装饰器 / 构造函数参数属性（用 const 对象 + union type）
//   - 不用 tsconfig 的 paths 别名
// ============================================================================

// ---------- 基础 ----------
export type Resource = string; // 资料路径，如 "data/materials/math-g2.md"

export interface Point {
  name: string; // 知识点名，唯一键（归一化后）
  pid?: number; // 单调递增 id，等于其在 PointGraph 中的下标；由 integrate 分配
}

export interface Problem {
  name: string; // 真题名，如 "2023 期末 T3"
  content: string; // 题干
  points: Point[]; // 该题考察的知识点
  kind?: string; // 【题型】如 "选择"/"填空"/"计算"/"简答"；由 analyzePro 抽取，缺失置 "未分类"
}

/** 单向边 from → to：学 to 之前必须先学 from */
export type Edge = [Point, Point];

/**
 * PointGraph[pid] = { name, prev, resources }。
 * 【对 PLAN §3 的一处必要修正】PointNode 增加 name 字段：
 *   PLAN §4.14 的 graph.json 里每个点都带 name，且 topoOrder / makePlan / queryPoint
 *   都需要"取某个 pid 的知识点名"，若 PointNode 不含 name 则该下标自描述不了（无法还原 Point）。
 *   题面 §1.3 / §0 允许自行修改不合理设计，这里补齐 name。
 */
export interface PointNode {
  name: string; // 本知识点的名字（归一化后，用于还原 Point.name）
  prev: Point[]; // 前置知识点（指向本知识点的边的起点；每个都带 pid）
  resources: Resource[]; // 哪些资料涉及本知识点
  dead?: boolean; // 被 mergePoints 合并掉的失效点（§4.5）；保留下标，避免其余 pid 位移
}
export type PointGraph = PointNode[]; // 下标即 pid
// 点族：graph[i].name + pid = i 即均成完整 Point

// ⚠️ 禁用 enum（§2.1：type stripping 不做运行时转换）⇒ 一律 const 对象 + union type
export const ProStatus = {
  Correct: "correct",
  Incorrect: "incorrect",
  Confuse: "confuse",
} as const;
export type ProStatus = (typeof ProStatus)[keyof typeof ProStatus];

/** 问答引用：可追溯到原始资料（§4.10） */
export interface Citation {
  resource: Resource; // 文件名 / 路径
  locator: string; // 定位：md 用标题路径（如 "§2.1 整数加减"）；PDF 用页码
  snippet: string; // 命中的原文片段（截断到 ≤200 字并标省略号）
  score?: number; // 相关性得分，便于演示展示
}

export type LearnRecord =
  | { kind: "Ask"; question: string; answer?: string | null; citations?: Citation[] }
  | { kind: "Read"; resource: Resource }
  | { kind: "Do"; problem: Problem; status: ProStatus }
  | { kind: "Skip"; point: Point };
// ↑ record 的 ask 分支：ask()（§4.10）结束后把结果回填成一条 Ask 记录；
//   资料不足时 answer = null —— 对应题面"Ask 的 Option 可写为 None"。

export type LearnAction =
  | { kind: "Read"; resource: Resource }
  | { kind: "Explain" } // 解释当前知识点（可由多个动作重复出现，如 intro/summary）
  | { kind: "Do"; problem: Problem };

/** 一个学习计划：按顺序学一串知识点，每个知识点带若干学习动作 */
export type LearnPlan = Array<{ point: Point; actions: LearnAction[] }>;

export interface AnalyzeResReq {
  resource: Resource;
  points: Point[];
  edges: Edge[];
}
export interface AnalyzeProReq {
  problem: Problem;
  points: Point[];
}
export type AnalyzeReq = // 判别联合：用 kind 区分，避免依赖标签推断
  | { kind: "ResReq"; data: AnalyzeResReq }
  | { kind: "ProReq"; data: AnalyzeProReq };

/** L3：学习状态。key = normalize(Point.name) */
export type State = Map<string, number>; // 知识点掌握度 [0,1]
export type KindState = Map<string, number>; // 【题型】掌握度 [0,1]，key = Problem.kind（缺失为 "未分类"）

// 🔴 冷启动先验：没学过的点按 0.5 处理，不是 0。读掌握度一律用 masteryOf()。
export const PRIOR_MASTERY = 0.5;
export const masteryOf = (m: State | KindState, normalizedName: string): number =>
  m.get(normalizedName) ?? PRIOR_MASTERY;
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------- 调参默认值（PLAN §11；须写进 README） ----------
export const MASTERY_DELTA = { correct: 0.15, incorrect: -0.25, confuse: -0.05 } as const;
export const MASTERY_THRESHOLD = 0.8; // "已掌握"阈值
export const TOP_K = 5; // 检索 top-k
export const CHUNK_SIZE = 3000; // 长文切分粒度（字）
export const VEC_SUFFICIENT_THRESHOLD = 0.45; // 向量模式：top1 相似度 >= 0.45 视为充足
export const KEYWORD_COVERAGE_THRESHOLD = 0.5; // 关键词模式：词项覆盖率 >= 0.5
export const UNCLASSIFIED_KIND = "未分类"; // 题型缺失的默认值

/** 一次真题作答的结构化记录（§4.7 规则 2 选"回炉题"要靠它，别只存人类可读文本） */
export interface AnswerRecord {
  at: string; // ISO 时间戳
  problemName: string; // 对应 Problem.name
  kind: string; // 题型（缺失为 "未分类"）
  status: ProStatus;
  pointNames: string[]; // 涉及知识点（归一化名）
}

/** 一次学习行为的留痕（进阶项"区分偶然做错 / 稳定薄弱"与"决策回放"都靠它） */
export interface HistoryEntry {
  at: string; // ISO 时间戳
  kind: LearnRecord["kind"];
  detail: string; // 人类可读摘要（问题 / 资料名 / 题目名 + 结果）
  pointNames?: string[]; // 涉及的知识点（归一化名）
  before?: number; // 变更前掌握度（仅 Do）
  after?: number; // 变更后掌握度（仅 Do）
}

/** ask() 的返回（§4.10） */
export interface AskResult {
  question: string;
  answer: string | null; // 资料不足 ⇒ null（不得用模型自身知识补全）
  citations: Citation[];
  sufficient: boolean;
  fallback?: "keyword" | "extractive"; // 无 Key 时的降级路径（§9.3）
}

// ⚠️ JSON 没有 Map：不要直接 JSON.stringify(Map)（会得到 {}，状态静默丢光）。
export const stateToJSON = (m: State | KindState): Record<string, number> =>
  Object.fromEntries(m) as Record<string, number>;
export const stateFromJSON = (o: Record<string, number> | null): State =>
  new Map(Object.entries(o ?? {}));

// ---------- 助手接口（对应题面 AIAssistant trait，7 个方法一个不少） ----------
export interface AIAssistant {
  makePlan(): LearnPlan;
  analyzeRes(resource: Resource): Promise<AnalyzeResReq>;
  analyzePro(problem: Problem): Promise<AnalyzeProReq>;
  integrate(req: AnalyzeReq): void;
  pointRank(rank: number): Point[]; // 考频前 rank
  queryPoint(point: Point): { resources: Resource[]; problems: Problem[]; kinds: string[] };
  record(learn: LearnRecord): void;
}

/** 在题面 trait 之上追加的 helper（题面明确允许自行添加，§1.3） */
export interface LearningAssistant extends AIAssistant {
  ask(question: string): Promise<AskResult>; // §4.10（L1 阶段可先按 §9.3 关键词降级实现）
  mergePoints(from: Point, into: Point): void; // §4.5
}

/** L1 的模拟知识网络（不接 AI） */
export interface SimulationNetwork extends LearningAssistant {
  resources: Resource[];
  graph: PointGraph;
  pointMention: number[]; // pointMention[pid] = 该知识点被真题提及的次数（考频）
  problems: Problem[]; // 额外保存题目本体，供 queryPoint / Do 动作使用
  state: State; // L3：知识点掌握度（由 store 载入 / 落盘）
  kindState: KindState; // L3：【题型】掌握度
  history: HistoryEntry[]; // L3：学习历史（落盘 data/history.json）
}

/** 模型提议一条计划的草稿（§4.13）：模型只允许返回"知识点名 + 动作意图"，不得直接改 state。 */
export interface PlanDraft {
  pointName: string; // 知识点名（会被归一化后查找）
  actions: Array<{ kind: "Read"; resource: string } | { kind: "Explain" } | { kind: "Do"; problemName: string }>;
}
export interface PlanProposalResult {
  accepted: boolean; // true = 全过校验；false = 有一条不过
  plan?: LearnPlan; // accepted 时给出最终计划
  rejected?: string[]; // 未过校验的理由（每一条）
}
