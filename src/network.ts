// ============================================================================
// src/network.ts — §4.1–4.6 的实现（SimNet），以及 §4.8 record、§4.5 mergePoints、
//                  §4.14 graph.json 序列化/载入。
//
// ⚠️ 不是"不接 AI"的玩具：record / 持久化 / queryPoint 这些 L2/L3 的能力也在这里，
//    因为它们是"知识网络"自身的语义（PLAN §4.4 说 queryPoint 就是网络的职责）。
//
// 依赖方向：network.ts → types/normalize/store（不 import plan.ts，避免环形依赖；
//           action 填充由外部注入 actionFiller，实际实现见 plan.ts）。
// ============================================================================
import path from "node:path";
import {
  type AnalyzeProReq,
  type AnalyzeReq,
  type AnalyzeResReq,
  type AnswerRecord,
  type DecisionEntry,
  type HistoryEntry,
  type KindState,
  type LearnAction,
  type LearnPlan,
  type LearnRecord,
  type Point,
  type PointGraph,
  type Problem,
  type Resource,
  type SimulationNetwork,
  type State,
  KEEP_RECENT,
  MASTERY_DELTA,
  MASTERY_THRESHOLD,
  UNCLASSIFIED_KIND,
  clamp01,
  masteryOf,
} from "./types.ts";
import { canonicalize, loadAliases, type AliasTable } from "./normalize.ts";
import {
  analyzeProblem,
  analyzeProblemDetailed,
  analyzeResourceDetailed,
  type ExtractSource,
} from "./analyze/analyze.ts";
import {
  atomicWrite,
  keepRecent,
  loadAnswers,
  loadDecisions,
  loadHistory,
  loadState,
  readJSON,
  saveAnswers,
  saveDecisions,
  saveHistory,
  saveState,
} from "./store.ts";

/** 注入一个知识点的一组学习动作（由 plan.ts 的 fillActions 提供；null = L1 空动作）。 */
export type ActionFiller = (point: Point) => LearnAction[];

export interface SimNetOptions {
  /** **可写产物**目录：graph / state / answers / history / decisions 落在这里。 */
  dataDir?: string;
  /**
   * **只读输入**目录：aliases.json、presets/analyze-req.json 在这里。
   * 默认 = dataDir（单目录部署时二者相同）。
   *
   * 【2026-10-11 修 bug】以前 analyzeRes 把 dataDir 当预设目录用 —— 而网页壳的 dataDir
   * 是 `data/.runtime`，于是它去读 `data/.runtime/presets/analyze-req.json`（永远不存在），
   * **presets 兜底在网页壳里实际不可达**。输入与产物是两个目录，必须分开传。
   */
  inputDir?: string;
  aliases?: AliasTable;
  skipLoad?: boolean; // 测试用：跳过已持久化的 graph/state，从空体系开始
}

export class SimNet implements SimulationNetwork {
  // —— SimulationNetwork 公开字段 ——
  resources: Resource[] = [];
  graph: PointGraph = [];
  pointMention: number[] = [];
  problems: Problem[] = [];
  state: State = new Map<string, number>();
  kindState: KindState = new Map<string, number>();
  history: HistoryEntry[] = [];

  // —— 内部 / 扩展 ——
  answers: AnswerRecord[] = [];
  /** §4.13 决策日志：模型提议的接受 / 拒绝留痕（含原始草稿），落盘 data/decisions.json */
  decisions: DecisionEntry[] = [];
  private aliases: AliasTable;
  private dataDir: string;
  /** 只读输入目录（预设 / 别名表）。见 SimNetOptions.inputDir 的注释。 */
  private inputDir: string;
  private nameToPid = new Map<string, number>(); // canonical name → pid
  private warnings: string[] = [];
  actionFiller: ActionFiller | null = null;

  constructor(opts: SimNetOptions = {}) {
    this.dataDir = opts.dataDir ?? "data";
    this.inputDir = opts.inputDir ?? this.dataDir;
    this.aliases = opts.aliases ?? loadAliases(path.join(this.inputDir, "aliases.json"));
    if (!opts.skipLoad) {
      const ps = loadState(path.join(this.dataDir, "state.json"));
      this.state = ps.state;
      this.kindState = ps.kindState;
      this.answers = loadAnswers(path.join(this.dataDir, "answers.json"));
      this.history = loadHistory(path.join(this.dataDir, "history.json"));
      this.decisions = loadDecisions(path.join(this.dataDir, "decisions.json"));
      this.loadGraph(path.join(this.dataDir, "graph.json"));
    }
  }

  setActionFiller(fn: ActionFiller | null): void {
    this.actionFiller = fn;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  // ---------- 名称 → pid 查找 / 建点 ----------
  /** 归一化名（含别名表）作为全局唯一键的查找函数。所有比较口径统一走它（§4.4）。 */
  private lookupKey(name: string): string {
    return canonicalize(name, this.aliases);
  }

  private findPid(name: string): number {
    const pid = this.nameToPid.get(this.lookupKey(name));
    return pid === undefined ? -1 : pid;
  }

  private pointByPid(pid: number): Point {
    return { name: this.graph[pid].name, pid };
  }

  private alivePids(): number[] {
    const pids: number[] = [];
    for (let i = 0; i < this.graph.length; i++) {
      if (!this.graph[i].dead) pids.push(i);
    }
    return pids;
  }

  /** 存活知识点的 Point 列表（供 §4.13 的"恰好一次"校验 / 对外展示）。 */
  alivePoints(): Point[] {
    return this.alivePids().map((pid) => this.pointByPid(pid));
  }

  /** §4.13 决策日志：记一条（proposePlan 接受/拒绝都走它），并落盘 data/decisions.json。 */
  logDecision(entry: DecisionEntry): void {
    this.decisions.push(entry);
    this.decisions = keepRecent(this.decisions, KEEP_RECENT);
    saveDecisions(path.join(this.dataDir, "decisions.json"), this.decisions);
  }

  /**
   * 确保知识点在图中，返回 pid。已存在（归一化后同 key）则复用，不新建（幂等）。
   * 撞车提示：若一个新点的名字与既有某个点仅在括号编号上不同，记一条 warning（不合并）。
   */
  private ensurePoint(rawName: string, warnVariant = true): number {
    const key = this.lookupKey(rawName);
    const existing = this.nameToPid.get(key);
    if (existing !== undefined) return existing;

    const pid = this.graph.length;
    this.graph.push({ name: rawName, prev: [], resources: [], dead: false });
    this.pointMention.push(0);
    this.nameToPid.set(key, pid);

    if (warnVariant) this.warnIfVariableVariant(rawName);
    return pid;
  }

  /** 启发式：若新点名字去掉括号编号后，与某个既有点相同，提示可用别名（§4.5 / 用例 19）。 */
  private warnIfVariableVariant(rawName: string): void {
    const stripped = stripParens(rawName);
    if (!stripped) return;
    for (let i = 0; i < this.graph.length; i++) {
      if (i === this.findPid(rawName)) continue;
      const other = this.graph[i];
      if (other.dead) continue;
      if (stripParens(other.name) === stripped && other.name !== rawName) {
        this.warn(
          `名称「${rawName}」与既有知识点「${other.name}」去掉括号编号后相同，` +
            `可能是一组同义点；若要合并请在 data/aliases.json 显式声明别名（当前未自动合并）。`,
        );
        return;
      }
    }
  }

  private warn(msg: string): void {
    this.warnings.push(msg);
    console.warn(`[simnet] ${msg}`);
  }

  // ---------- §4.1 integrate ----------
  integrate(req: AnalyzeReq): void {
    if (req.kind === "ResReq") this.integrateRes(req.data);
    else this.integratePro(req.data);
    this.persistGraph(); // §4.14：integrate 成功后原子写
  }

  private integrateRes(data: AnalyzeResReq): void {
    const resource = data.resource;
    if (!this.resources.includes(resource)) this.resources.push(resource);

    // points：入图前合并（同一资源内 / 跨资源同 key 复用 pid）
    for (const p of data.points) {
      const pid = this.ensurePoint(p.name);
      const node = this.graph[pid];
      if (!node.resources.includes(resource)) node.resources.push(resource);
    }

    // edges：[from, to] ⇒ from 加入 to 的 prev（去重、去自环）。端点可能在 points 未列 → 隐式建点。
    for (const [from, to] of data.edges) {
      const fpid = this.ensurePoint(from.name, false);
      const tpid = this.ensurePoint(to.name, false);
      if (fpid === tpid) continue;
      const node = this.graph[tpid];
      if (!node.prev.some((q) => q.pid === fpid)) {
        node.prev.push(this.pointByPid(fpid));
      }
    }
  }

  private integratePro(data: AnalyzeProReq): void {
    const problem = data.problem;
    for (const p of data.points) this.ensurePoint(p.name, false);

    const idx = this.problems.findIndex((x) => x.name === problem.name);
    const isNew = idx === -1;
    if (isNew) this.problems.push(problem);
    else this.problems[idx] = problem;

    // 考频只在"这道题首次入库"时 +1（§4.1 幂等要求）
    if (isNew) {
      for (const p of problem.points) {
        const pid = this.findPid(p.name);
        if (pid >= 0) this.pointMention[pid] += 1;
      }
    }
  }

  // ---------- §4.3 拓扑排序 / 环 ----------
  private inDegree(pid: number, aliveSet: Set<number>): number {
    return this.graph[pid].prev.filter((q) => q.pid !== undefined && aliveSet.has(q.pid)).length;
  }

  /** 拓扑分层（Kahn）：同一次入队的点属同一层。返回的是 pid 顺序。 */
  private topoPids(): number[] {
    const alive = this.alivePids();
    const aliveSet = new Set(alive);
    const indeg = new Map<number, number>();
    for (const pid of alive) indeg.set(pid, this.inDegree(pid, aliveSet));

    // 邻接（后继）：for 每个 node v，列出所有以 v 为前驱的 w
    const succ = new Map<number, number[]>();
    for (const pid of alive) {
      for (const q of this.graph[pid].prev) {
        const ppid = q.pid;
        if (ppid !== undefined && aliveSet.has(ppid)) {
          if (!succ.has(ppid)) succ.set(ppid, []);
          succ.get(ppid)!.push(pid);
        }
      }
    }

    const ordered: number[] = [];
    const used = new Set<number>();
    let frontier = alive.filter((pid) => (indeg.get(pid) ?? 0) === 0);

    while (frontier.length > 0) {
      frontier.sort((a, b) => this.compareByPlanKey(a, b));
      for (const pid of frontier) {
        if (used.has(pid)) continue;
        used.add(pid);
        ordered.push(pid);
        for (const s of succ.get(pid) ?? []) {
          if (used.has(s)) continue;
          indeg.set(s, (indeg.get(s) ?? 0) - 1);
        }
      }
      frontier = alive.filter((pid) => !used.has(pid) && (indeg.get(pid) ?? 0) === 0);
    }

    // 环：剩余未处理 → 打破环补齐输出（保证每个点恰好一次），并告警
    const remaining = alive.filter((pid) => !used.has(pid));
    if (remaining.length > 0) {
      remaining.sort((a, b) => this.compareByPlanKey(a, b));
      for (const pid of remaining) {
        used.add(pid);
        ordered.push(pid);
      }
      this.warn(
        `知识点之间存在环（${remaining.length} 个点未能在拓扑前排出），已打破环并补齐输出；` +
          `环的构成见 cycles()。`,
      );
    }
    return ordered;
  }

  /** 拓扑序的点列表。返回顺序即 makePlan 的 Point 顺序（跳过 dead 点）。 */
  topoOrder(): Point[] {
    return this.topoPids().map((pid) => this.pointByPid(pid));
  }

  /**
   * 环检测：返回若干环路（每个是一组 Point）。仅用于 README / 日志说明。
   * 【2026-10-11 修正】早期实现依赖 `lastCycleNodes`（由 topoPids() 写入）⇒ 必须先调
   * `topoOrder()` / `makePlan()` 再调本方法，否则恒返回 []，是隐蔽的顺序耦合。
   * 现在独立计算：在"存活点子图"上做迭代式 DFS（白/灰/黑染色），遇到灰点即回边 ⇒ 提环。
   * 与调用顺序无关，可随时单独调用。
   */
  cycles(): Point[][] {
    const alive = this.alivePids();
    const aliveSet = new Set(alive);
    const result: Point[][] = [];
    const color = new Map<number, number>(); // 0 未见 / 1 在栈上 / 2 已完成
    const seenCycle = new Set<string>(); // 规范化后的环签名，避免同一个环被重复收录

    // 后继表（v → 以 v 为前驱的所有点），只在存活子图上建
    const succ = new Map<number, number[]>();
    for (const pid of alive) {
      for (const q of this.graph[pid].prev) {
        if (q.pid === undefined || !aliveSet.has(q.pid)) continue;
        if (!succ.has(q.pid)) succ.set(q.pid, []);
        succ.get(q.pid)!.push(pid);
      }
    }

    for (const start of alive) {
      if (color.get(start)) continue;
      const stack: number[] = [start];
      const frames: Array<{ pid: number; idx: number }> = [{ pid: start, idx: 0 }];
      color.set(start, 1);
      while (frames.length > 0) {
        const cur = frames[frames.length - 1];
        const nbrs = succ.get(cur.pid) ?? [];
        if (cur.idx < nbrs.length) {
          const nxt = nbrs[cur.idx++];
          if (!color.get(nxt)) {
            color.set(nxt, 1);
            stack.push(nxt);
            frames.push({ pid: nxt, idx: 0 });
          } else if (color.get(nxt) === 1) {
            // 灰点 ⇒ 回边，从栈里截出 [nxt … cur] 这一段
            const i = stack.indexOf(nxt);
            if (i >= 0) {
              const ring = stack.slice(i);
              const sig = [...ring].sort((a, b) => a - b).join(",");
              if (!seenCycle.has(sig)) {
                seenCycle.add(sig);
                result.push([...ring, nxt].map((p) => this.pointByPid(p)));
              }
            }
          }
        } else {
          color.set(cur.pid, 2);
          stack.pop();
          frames.pop();
        }
      }
    }
    return result;
  }

  /** 计划键（§4.2 🔑）：(已掌握?1:0, 掌握度, -考频, 规范化名码点序) 层内升序。 */
  private compareByPlanKey(a: number, b: number): number {
    const ka = this.lookupKey(this.graph[a].name);
    const kb = this.lookupKey(this.graph[b].name);
    const ma = masteryOf(this.state, ka) >= MASTERY_THRESHOLD ? 1 : 0;
    const mb = masteryOf(this.state, kb) >= MASTERY_THRESHOLD ? 1 : 0;
    if (ma !== mb) return ma - mb;
    const sa = masteryOf(this.state, ka);
    const sb = masteryOf(this.state, kb);
    if (sa !== sb) return sa - sb;
    if (this.pointMention[a] !== this.pointMention[b]) return this.pointMention[b] - this.pointMention[a];
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  }

  // ---------- §4.2 makePlan ----------
  makePlan(): LearnPlan {
    const ordered = this.topoPids();
    const plan: LearnPlan = ordered.map((pid) => {
      const point = this.pointByPid(pid);
      const actions = this.actionFiller ? this.actionFiller(point) : [];
      return { point, actions };
    });
    return plan;
  }

  // ---------- §4.6 pointRank ----------
  pointRank(rank: number): Point[] {
    const all = this.alivePids();
    all.sort((a, b) => {
      if (this.pointMention[b] !== this.pointMention[a]) return this.pointMention[b] - this.pointMention[a];
      const na = this.lookupKey(this.graph[a].name);
      const nb = this.lookupKey(this.graph[b].name);
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
    return all.slice(0, rank).map((pid) => this.pointByPid(pid));
  }

  // ---------- §4.4 queryPoint ----------
  queryPoint(point: Point): { resources: Resource[]; problems: Problem[]; kinds: string[] } {
    const key = this.lookupKey(point.name);
    const pid = this.nameToPid.get(key);
    if (pid === undefined || this.graph[pid].dead) {
      return { resources: [], problems: [], kinds: [] };
    }
    const resources = [...this.graph[pid].resources];
    // 真题匹配：problems[].points[].name 也先归一化再比（§4.4 口径）
    const matched = this.problems.filter((prob) =>
      prob.points.some((q) => this.lookupKey(q.name) === key),
    );
    const kinds = Array.from(new Set(matched.map((p) => p.kind ?? UNCLASSIFIED_KIND))).sort();
    return { resources, problems: matched, kinds };
  }

  // ---------- §4.5 mergePoints（入图后合并；保持 pid = 下标不变） ----------
  mergePoints(from: Point, into: Point): void {
    const fromPid = this.findPid(from.name);
    const intoPid = this.findPid(into.name);
    if (fromPid < 0 || intoPid < 0) {
      throw new Error(`mergePoints 失败：知识点不存在（from=${from.name}, into=${into.name}）`);
    }
    if (fromPid === intoPid) return;

    const fromNode = this.graph[fromPid];
    const intoNode = this.graph[intoPid];

    // prev 并集，去掉 from 自身与自环，去重
    const mergedPrev: Point[] = [];
    const seenPrev = new Set<number>();
    for (const p of [...intoNode.prev, ...fromNode.prev]) {
      if (p.pid === undefined || p.pid === fromPid || p.pid === intoPid) continue;
      if (seenPrev.has(p.pid)) continue;
      seenPrev.add(p.pid);
      mergedPrev.push(p);
    }
    intoNode.prev = mergedPrev;

    // resources 并集
    const resSet = new Set<Resource>();
    for (const r of [...intoNode.resources, ...fromNode.resources]) resSet.add(r);
    intoNode.resources = [...resSet];

    // 考频合并
    this.pointMention[intoPid] += this.pointMention[fromPid];
    this.pointMention[fromPid] = 0;

    // problems[].points 里指向 from 的改写为 into
    for (const prob of this.problems) {
      prob.points = prob.points.map((q) => {
        if (q.pid === fromPid) return { name: intoNode.name, pid: intoPid };
        return q;
      });
    }

    // 其余节点 prev 里指向 from 的改写为 into
    for (const node of this.graph) {
      if (node.dead || node === fromNode) continue;
      node.prev = node.prev.map((q) => {
        if (q.pid === fromPid) return { name: intoNode.name, pid: intoPid };
        return q;
      });
    }

    // 掌握度合并（加权平均；两边都无记录时取 max），随后删除 fromKey
    const fromKey = this.lookupKey(fromNode.name);
    const intoKey = this.lookupKey(intoNode.name);
    const fromVal = masteryOf(this.state, fromKey);
    const intoVal = masteryOf(this.state, intoKey);
    const fromCnt = this.answers.filter((a) => a.pointNames.includes(fromKey)).length;
    const intoCnt = this.answers.filter((a) => a.pointNames.includes(intoKey)).length;
    let combined: number;
    if (fromCnt + intoCnt === 0) combined = Math.max(fromVal, intoVal);
    else combined = (fromVal * fromCnt + intoVal * intoCnt) / (fromCnt + intoCnt);
    this.state.set(intoKey, clamp01(combined));
    this.state.delete(fromKey);

    // history / answers 里指向 from 的改写为 into（保留可回放）
    for (const h of this.history) {
      if (h.pointNames) h.pointNames = h.pointNames.map((n) => (n === fromKey ? intoKey : n));
    }
    for (const a of this.answers) {
      a.pointNames = a.pointNames.map((n) => (n === fromKey ? intoKey : n));
    }

    // 标记 from 失效（保留下标），并把 from 从 nameToPid 移除
    fromNode.dead = true;
    this.nameToPid.delete(fromKey);

    // 【2026-10-11 修正】早期用 kind:"Ask" 记这条，会污染 §8 用例 16 的 Ask 计数。
    // 合并知识点会改写掌握度（属"决策"而非"学习行为"）⇒ 用专用 kind "Merge"。
    this.history.push({
      at: new Date().toISOString(),
      kind: "Merge",
      detail: `合并知识点「${fromNode.name}」→「${intoNode.name}」`,
      pointNames: [intoKey],
      before: fromVal,
      after: this.state.get(intoKey),
    });
    this.history = keepRecent(this.history, KEEP_RECENT);

    this.persistState(); // state / answers / history / decisions 一起落盘
    this.persistGraph();
  }

  // ---------- §4.9 analyzeRes / analyzePro（委托 analyze.ts 流水线） ----------
  /**
   * 分析一份资料。**带来源标注**（model / rule / preset）：调用方只看"有没有 points"
   * 是分不清"模型抽的"还是"回落到 md 声明抽的"（§4.9 补注）。
   */
  async analyzeResDetailed(
    resource: Resource,
  ): Promise<{ req: AnalyzeResReq; by: ExtractSource; note?: string }> {
    // 🔴 传 inputDir（只读输入），**不是** dataDir（可写产物）：presets 在输入侧。
    const d = await analyzeResourceDetailed(resource, { dataDir: this.inputDir, preferModel: true });
    return { req: d.req, by: d.by, note: d.note };
  }

  async analyzeRes(resource: Resource): Promise<AnalyzeResReq> {
    return (await this.analyzeResDetailed(resource)).req;
  }

  async analyzePro(problem: Problem): Promise<AnalyzeProReq> {
    return analyzeProblem(problem);
  }

  /** 真题抽取 + **来源标注**（网页壳要如实区分 model / rule，见 analyze.ts 的说明）。 */
  async analyzeProDetailed(problem: Problem): Promise<{ req: AnalyzeProReq; by: ExtractSource; note?: string }> {
    const d = await analyzeProblemDetailed(problem, { preferModel: true });
    return { req: d.req, by: d.by, note: d.note };
  }

  // ---------- §4.8 record（L3） ----------
  record(learn: LearnRecord): void {
    const at = new Date().toISOString();
    if (learn.kind === "Do") {
      const { problem, status } = learn;
      const delta = MASTERY_DELTA[status];
      const pointKeys = problem.points.map((p) => this.lookupKey(p.name));

      // 一致性检查：题目提到的知识点若不在图中（既无资料也未被任何真题引入过），
      // 说明这条 record 来自体系之外。仍然记状态（学习确实发生了），但明确告警，
      // 不静默留下"图中查不到的 state key"。
      for (const p of problem.points) {
        if (this.findPid(p.name) < 0) {
          this.warn(
            `record(Do) 的题目「${problem.name}」提到知识点「${p.name}」，但它不在当前知识体系中` +
              `（无资料/真题引入过）。已照常记录掌握度，但该点不会出现在 makePlan 里。`,
          );
        }
      }

      // 知识点掌握度（用 masteryOf 读旧值，冷启动 0.5）
      let before = 0;
      let after = 0;
      for (const key of pointKeys) {
        before = masteryOf(this.state, key);
        after = clamp01(before + delta);
        this.state.set(key, after);
      }
      // 题型掌握度（同公式同幅度）
      const kindKey = problem.kind ?? UNCLASSIFIED_KIND;
      const kindBefore = masteryOf(this.kindState, kindKey);
      const kindAfter = clamp01(kindBefore + delta);
      this.kindState.set(kindKey, kindAfter);

      // 结构化作答记录（§4.7 规则2 的回炉题筛选依据）
      this.answers.push({ at, problemName: problem.name, kind: kindKey, status, pointNames: pointKeys });

      this.history.push({
        at,
        kind: "Do",
        detail: `做真题「${problem.name}」→ ${status}（题型 ${kindKey}）`,
        pointNames: pointKeys,
        before: pointKeys.length ? before : undefined,
        after: pointKeys.length ? after : undefined,
      });
    } else if (learn.kind === "Read") {
      this.history.push({ at, kind: "Read", detail: `读资料「${learn.resource}」` });
    } else if (learn.kind === "Skip") {
      const key = this.lookupKey(learn.point.name);
      this.history.push({
        at,
        kind: "Skip",
        detail: `跳过知识点「${learn.point.name}」`,
        pointNames: [key],
      });
    } else if (learn.kind === "Ask") {
      const ans = learn.answer ?? null;
      this.history.push({
        at,
        kind: "Ask",
        detail: ans
          ? `提问「${learn.question}」→ 有回答（${(learn.citations ?? []).length} 条出处）`
          : `提问「${learn.question}」→ 资料不足，未作答`,
        pointNames: undefined,
      });
    }
    // §11 保留策略：answers / history 只留最近 500 条
    this.answers = keepRecent(this.answers, KEEP_RECENT);
    this.history = keepRecent(this.history, KEEP_RECENT);
    this.persistState();
  }

  // ---------- §4.14 graph.json 序列化 / 载入 ----------
  private persistGraph(): void {
    const points = this.graph.map((n) => ({
      name: n.name,
      resources: n.resources,
      prevPids: n.prev.map((q) => q.pid).filter((p): p is number => p !== undefined),
      dead: n.dead ?? false,
    }));
    const problems = this.problems.map((p) => ({
      name: p.name,
      content: p.content,
      kind: p.kind,
      pointPids: p.points.map((q) => this.findPid(q.name)).filter((x) => x >= 0),
    }));
    atomicWrite(path.join(this.dataDir, "graph.json"), {
      version: 1,
      resources: this.resources,
      points,
      problems,
      pointMention: this.pointMention,
    });
  }

  private persistState(): void {
    saveState(path.join(this.dataDir, "state.json"), this.state, this.kindState);
    saveAnswers(path.join(this.dataDir, "answers.json"), this.answers);
    saveHistory(path.join(this.dataDir, "history.json"), this.history);
    saveDecisions(path.join(this.dataDir, "decisions.json"), this.decisions);
  }

  private loadGraph(file: string): void {
    const raw = readJSON(file);
    if (!raw) return;
    const g = raw as {
      version?: number;
      resources?: string[];
      points?: Array<{ name: string; resources?: string[]; prevPids?: number[]; dead?: boolean }>;
      problems?: Array<{ name: string; content: string; kind?: string; pointPids?: number[] }>;
      pointMention?: number[];
    };
    const points = g.points ?? [];
    const pointMention = g.pointMention ?? [];
    if (points.length !== pointMention.length) {
      this.warn("graph.json 非法（points 与 pointMention 长度不一致），丢弃重建");
      return;
    }
    const maxIdx = points.length;
    const idxOk =
      points.every((p) => (p.prevPids ?? []).every((x) => Number.isInteger(x) && x >= 0 && x < maxIdx)) &&
      (g.problems ?? []).every((p) => (p.pointPids ?? []).every((x) => Number.isInteger(x) && x >= 0 && x < maxIdx));
    if (!idxOk) {
      this.warn("graph.json 非法（prevPids / pointPids 越界），丢弃重建");
      return;
    }

    this.resources = g.resources ?? [];
    this.graph = points.map((p) => ({
      name: p.name,
      prev: (p.prevPids ?? []).map((x) => ({ name: points[x].name, pid: x })),
      resources: p.resources ?? [],
      dead: p.dead ?? false,
    }));
    this.pointMention = pointMention.map((n) => n);
    this.problems = (g.problems ?? []).map((p) => ({
      name: p.name,
      content: p.content,
      kind: p.kind ?? UNCLASSIFIED_KIND,
      points: (p.pointPids ?? []).map((x) => ({ name: points[x].name, pid: x })),
    }));
    this.nameToPid = new Map();
    for (let i = 0; i < this.graph.length; i++) {
      this.nameToPid.set(this.lookupKey(this.graph[i].name), i);
    }
  }

  // ---------- 提供给 plan.ts 的公开查询（action 填充用） ----------
  /** 规范化名称（含别名表）；这是所有跨模块比较的统一口径（§4.4）。 */
  keyOf(name: string): string {
    return this.lookupKey(name);
  }
  /** 取某知识点已答错/糊涂过的真题名（§4.7 规则 2 的回炉题依据）。 */
  reviewProblemNames(point: Point): string[] {
    const key = this.lookupKey(point.name);
    return this.answers
      .filter((a) => a.pointNames.includes(key) && a.status !== "correct")
      .map((a) => a.problemName);
  }

  problemByName(name: string): Problem | undefined {
    return this.problems.find((p) => p.name === name);
  }

  findPointByName(name: string): Point | undefined {
    const pid = this.findPid(name);
    return pid >= 0 ? this.pointByPid(pid) : undefined;
  }
}

/** 去掉括号及内容，仅用于"撞车提示"启发式（不是归一化）。 */
function stripParens(s: string): string {
  return s.replace(/[（(][^）)]*[）)]/g, "").trim();
}
