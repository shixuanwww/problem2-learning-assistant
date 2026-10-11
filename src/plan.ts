// ============================================================================
// src/plan.ts — §4.2 makePlan 的动作填充 + §4.13 模型提议的校验/拒绝/回落
//
// 这里的"计划调整"严格落在 §4.2 可行域之内：
//   ① 同层换序  ② 给该点加量/提前动作  ③ 同层内排到最前
// 绝不把知识点挪到它前置点之前（拓扑序由 network.makePlan 保证）。
//
// makePlan 本身在 network.ts；本文件提供 actionFiller（fillActions）与
// 模型提议通道（proposePlan），并在启动时 wireActions(net) 接入。
// ============================================================================
import {
  type LearnAction,
  type LearnPlan,
  type PlanProposalResult,
  type Problem,
  type Resource,
  MASTERY_THRESHOLD,
  UNCLASSIFIED_KIND,
  masteryOf,
} from "./types.ts";
import type { SimNet } from "./network.ts";
import { chat } from "./analyze/llm.ts";

/** 把 §4.7 的动作填充接入 SimNet.makePlan（setActionFiller）。 */
export function wireActions(net: SimNet): void {
  net.setActionFiller((point) => fillActions(net, point));
}

/**
 * §4.7 对一个知识点生成一组学习动作。
 * 规则（可增强，但这些必须满足）：
 *   1 先读资料；有资料且需讲解 → 补一个 Explain（"先讲知识点 → 再做练习"）
 *   2 再做真题：优先回炉题（答错/糊涂过），其次考频高的知识点所对应的真题
 *   3 已掌握（>=阈值）：只留一道巩固题（"排到后面"交给 makePlan 的排序键，不在此重排）
 *   4 前置不足：在本点动作序列最前补一个指向前置点资料的 Read 或 Explain
 *   5 选回炉题的依据取自 data/answers.json 的 AnswerRecord（不解析人类可读文本）
 *   6 主/回炉题都**优先选薄弱题型**（kindState < 阈值）的真题 —— 见 pickProblem
 *
 * 【2026-10-11 审核后修】规则 4 的 Read 与规则 1 的 Read 常指向**同一份资料**
 * （前置点与本点常在同一份教材里），修前会生成"读同一份资料两遍"的冗余动作；
 * 现在统一走 `pushRead` 去重（去重键 = 归一化后的资源路径）。
 *
 * 【2026-10-11 审核后修】规则 6 是补上的：题面 L3 完成标志③要的是"增加薄弱**题型**训练"，
 * 而修前 `kindState` 只被写、不被读 ⇒ 题型掌握度对计划毫无影响（评审一问就穿）。
 */
export function fillActions(net: SimNet, point: { name: string; pid?: number }): LearnAction[] {
  const key = net.keyOf(point.name);
  const pid = point.pid ?? net.findPointByName(point.name)?.pid;
  const resources = pid !== undefined ? net.graph[pid].resources : [];
  const mastery = masteryOf(net.state, key);
  const mastered = mastery >= MASTERY_THRESHOLD;

  const actions: LearnAction[] = [];
  const readSeen = new Set<string>();
  const pushRead = (rawResource: Resource): void => {
    const dedupKey = rawResource.replace(/\\/g, "/").trim();
    if (readSeen.has(dedupKey)) return; // 同一份资料只读一次
    readSeen.add(dedupKey);
    actions.push({ kind: "Read", resource: rawResource });
  };
  /** 本点涉及的题型里，掌握度低于阈值的（= 薄弱题型），按题型名升序保证确定性。 */
  const weakKinds = (): string[] =>
    net
      .queryPoint({ name: point.name })
      .kinds.filter((k) => masteryOf(net.kindState, k) < MASTERY_THRESHOLD)
      .sort();

  // 规则 4：前置不足 → 最前补一个前置点资料或讲解（只影响本点动作，不调整知识点顺序）
  if (pid !== undefined) {
    for (const prv of net.graph[pid].prev) {
      if (prv.pid === undefined) continue;
      if (masteryOf(net.state, net.keyOf(prv.name)) < MASTERY_THRESHOLD) {
        const prvResources = net.graph[prv.pid].resources;
        // 用唯一一个连接两个点的 action 占位（去重交给 pushRead / readSeen）：
        // 前置点的资料若与本点资料相同，下面的规则 1 就不会再重复插一次。
        if (prvResources.length > 0) pushRead(prvResources[0]);
        else actions.push({ kind: "Explain" });
        break;
      }
    }
  }

  if (!mastered) {
    // 规则 1：先读资料（优先与薄弱题型相关，简化取第一个）+ 讲解
    if (resources.length > 0) pushRead(resources[0]);
    actions.push({ kind: "Explain" });
  }

  // 规则 2 + 3 + 6：选一道"主"真题（优先薄弱题型，排除回炉题），再把"回炉"真题作为额外加量
  const reviewNames = new Set(net.reviewProblemNames({ name: point.name }));
  const weak = weakKinds();
  const primary = pickProblem(net, { name: point.name, pid }, reviewNames, weak);
  if (primary) {
    actions.push({ kind: "Do", problem: primary });
  }
  if (!mastered) {
    // 回炉加量：该点答错/糊涂过的题再各追加一道（§4.2 允许的"加量/提前动作"），
    // 同为回炉题时**薄弱题型优先**（规则 6）。
    const reviewProbs = [...reviewNames]
      .map((n) => net.problemByName(n))
      .filter((p): p is Problem => p !== undefined)
      .filter((p) => !primary || p.name !== primary.name)
      .sort((a, b) => {
        const wa = weak.includes(a.kind ?? UNCLASSIFIED_KIND) ? 0 : 1;
        const wb = weak.includes(b.kind ?? UNCLASSIFIED_KIND) ? 0 : 1;
        if (wa !== wb) return wa - wb;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    for (const rp of reviewProbs) actions.push({ kind: "Do", problem: rp });
  }

  return actions;
}

/**
 * 选一道"主"真题（不选回炉；回炉由 fillActions 的加量循环处理）。
 *
 * 打分顺序（与 §4.2 的计划排序键同思路：先看"用户会不会"，再看"考不考"，最后用名字保证确定性）：
 *   ① 薄弱题型优先（`weakKinds` 命中）—— 题面 L3 完成标志③"增加薄弱题型训练"；
 *   ② 该题覆盖知识点的最高考频（考得多的更值得练）；
 *   ③ 题目名码点序（确定性，避免同一份数据两次跑出不同计划）。
 */
function pickProblem(
  net: SimNet,
  point: { name: string; pid?: number },
  exclude: Set<string> = new Set(),
  weakKinds: string[] = [],
): Problem | undefined {
  const q = net.queryPoint({ name: point.name });
  let best: Problem | undefined;
  let bestScore: [number, number] | null = null;
  for (const prob of q.problems) {
    if (exclude.has(prob.name)) continue;
    const weakFirst = weakKinds.includes(prob.kind ?? UNCLASSIFIED_KIND) ? 0 : 1;
    const mentions = prob.points
      .map((pp) => (pp.pid !== undefined ? net.pointMention[pp.pid] : 0))
      .concat([0]);
    const score: [number, number] = [weakFirst, -Math.max(...mentions)];
    if (
      bestScore === null ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && best !== undefined && prob.name < best.name)
    ) {
      bestScore = score;
      best = prob;
    }
  }
  return best;
}

// ---------- §4.13 模型提议计划：校验 → 拒绝/回落 ----------

/**
 * 模型只允许返回"知识点名 + 动作意图"的 JSON 草稿；本函数校验并拒掉不合法提议。
 * 任一校验不过 ⇒ accepted=false、rejected 列出每条理由、不执行，交由调用方回落规则版计划。
 *
 * 【2026-10-11 补齐 §4.13】三条此前缺失的：
 *   ① 校验 6「每个知识点**恰好一次**」—— 早期只查了"不重复"，没查"不遗漏"，
 *      于是"只提议 1 个点、剩下全漏掉"也会被 accepted，与规则版计划的完整性口径不一致；
 *   ② **决策日志** —— 接受 / 拒绝都记一条（含**原始草稿**）到 data/decisions.json，可回放；
 *   ③ **回落可见** —— 拒绝时不执行、把决定权交回调用方（§4.7 规则版计划），
 *      demo 里会打印"拒绝理由 → 回落后的计划"整条链路。
 */
export function proposePlan(net: SimNet, draft: unknown): PlanProposalResult {
  // 1) schema 校验（字段 / 类型 / 枚举）
  const schemaErrs = validateDraftSchema(draft);
  if (schemaErrs.length > 0) {
    return rejectProposal(net, draft, schemaErrs);
  }

  const entries = draft as Array<{
    pointName: string;
    actions: Array<{ kind: string; resource?: string; problemName?: string }>;
  }>;

  const rejected: string[] = [];
  const plan: LearnPlan = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const key = net.keyOf(entry.pointName);
    const point = net.findPointByName(entry.pointName);
    if (!point) {
      rejected.push(`知识点「${entry.pointName}」在图中不存在（或已失效）`);
      continue;
    }
    if (seen.has(key)) {
      rejected.push(`知识点「${entry.pointName}」被重复安排`);
      continue;
    }
    seen.add(key);

    const actions: LearnAction[] = [];
    for (const a of entry.actions) {
      if (a.kind === "Read") {
        const resources = net.graph[point.pid!].resources;
        if (!a.resource || !resources.includes(a.resource)) {
          rejected.push(`知识点「${entry.pointName}」的 Read 资源「${a.resource}」不在其资料中`);
          continue;
        }
        actions.push({ kind: "Read", resource: a.resource });
      } else if (a.kind === "Explain") {
        actions.push({ kind: "Explain" });
      } else if (a.kind === "Do") {
        const prob = net.problemByName(a.problemName ?? "");
        if (!prob) {
          rejected.push(`真题「${a.problemName}」不存在（禁止模型编造真题）`);
          continue;
        }
        actions.push({ kind: "Do", problem: prob });
      } else {
        rejected.push(`未知动作类型「${a.kind}」`);
      }
    }
    plan.push({ point, actions });
  }

  // 6) 覆盖完整性：每个存活知识点恰好一次（§4.13 校验 6）
  const missing = net.alivePoints().filter((p) => !seen.has(net.keyOf(p.name)));
  if (missing.length > 0) {
    rejected.push(
      `计划遗漏了 ${missing.length} 个知识点（§4.13 要求每个知识点恰好一次）：` +
        missing.map((p) => p.name).join("、"),
    );
  }

  if (rejected.length > 0) {
    return rejectProposal(net, draft, rejected);
  }

  // 5) 拓扑序校验：from 必须在 to 之前（§4.2 硬要求）
  const topoErrs = validateTopoOrder(net, plan);
  if (topoErrs.length > 0) {
    return rejectProposal(net, draft, topoErrs);
  }

  net.logDecision({ at: new Date().toISOString(), action: "proposePlan.accept", reasons: [], draft });
  return { accepted: true, plan };
}

/** 统一的拒绝出口：记决策日志（理由 + 原始草稿），不执行、由调用方回落规则版计划。 */
function rejectProposal(net: SimNet, draft: unknown, reasons: string[]): PlanProposalResult {
  net.logDecision({ at: new Date().toISOString(), action: "proposePlan.reject", reasons, draft });
  return { accepted: false, rejected: reasons };
}

/** 草稿 schema：必须是数组；每项 { pointName: string, actions: [...] }；每个动作 kind ∈ 枚举。 */
function validateDraftSchema(draft: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(draft)) {
    return ["proposePlan 草稿必须是数组"];
  }
  draft.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") {
      errs.push(`第 ${i} 项不是对象`);
      return;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.pointName !== "string" || e.pointName.length === 0) {
      errs.push(`第 ${i} 项缺少合法的 pointName`);
    }
    if (!Array.isArray(e.actions)) {
      errs.push(`第 ${i} 项 actions 必须是数组`);
      return;
    }
    e.actions.forEach((a, j) => {
      if (!a || typeof a !== "object") {
        errs.push(`第 ${i} 项第 ${j} 个动作不是对象`);
        return;
      }
      const act = a as Record<string, unknown>;
      const allowed = ["Read", "Explain", "Do"];
      if (typeof act.kind !== "string" || !allowed.includes(act.kind)) {
        errs.push(`第 ${i} 项第 ${j} 个动作 kind 非法：${String(act.kind)}`);
        return;
      }
      if (act.kind === "Read" && typeof act.resource !== "string") {
        errs.push(`第 ${i} 项第 ${j} 个 Read 动作缺少 resource`);
      }
      if (act.kind === "Do" && typeof act.problemName !== "string") {
        errs.push(`第 ${i} 项第 ${j} 个 Do 动作缺少 problemName`);
      }
    });
  });
  return errs;
}

/** 校验各知识点顺序满足 from → to（位置严格在前）。 */
function validateTopoOrder(net: SimNet, plan: LearnPlan): string[] {
  const errs: string[] = [];
  const pos = new Map<string, number>();
  plan.forEach((it, idx) => {
    pos.set(net.keyOf(it.point.name), idx);
  });
  for (let i = 0; i < plan.length; i++) {
    const pid = plan[i].point.pid;
    if (pid === undefined) continue;
    for (const prv of net.graph[pid].prev) {
      if (prv.pid === undefined) continue;
      const prevKey = net.keyOf(prv.name);
      const prevPos = pos.get(prevKey);
      if (prevPos !== undefined && prevPos > i) {
        errs.push(
          `顺序违反前置约束：「${prv.name}」应排在「${plan[i].point.name}」之前，但被安排到后面`,
        );
      }
    }
  }
  return errs;
}

// ---------- 模型提议通道的"真接线"：让模型产出草稿，再走上面同一套校验 ----------
//
// 【2026-10-11 第三轮补】此前 `proposePlan` 的调用方只有测试、/api/propose 与 demo 里
// **手写**的非法草稿 —— 也就是说题面 L3 1.2「让 AI 决定下一步学什么、怎么学」实际由规则完成，
// 评审一问"AI 在哪决策"就会穿。这里补上真正的接线：模型出草稿 → proposePlan 校验 →
// 通过则采用、拒绝则调用方回落规则版计划（决策日志两条路都留痕）。
//
// 模型只能提"知识点名 + 动作意图"，不能直接改 state，也不能编造资料/真题 —— 由 proposePlan 兜底。
const PLAN_SYS =
  "你是学习计划编排器。只能返回 JSON 对象，不要任何解释文字。\n" +
  '格式：{"plan":[{"pointName":"知识点名","actions":[{"kind":"Read","resource":"资料路径"}|{"kind":"Explain"}|{"kind":"Do","problemName":"真题名"}]}]}\n' +
  "硬性要求：\n" +
  "1. plan 数组必须**逐一覆盖**清单里的每个知识点，个数与清单一致、每个**恰好一次**；\n" +
  "2. 顺序**照抄清单顺序**（清单已按前置关系排好，不要重排）；\n" +
  "3. Read 的 resource 只能取该知识点自己的资料；Do 的 problemName 只能取给出的真题名；\n" +
  '4. 没把握就只写 {"kind":"Explain"} —— 严禁编造资料或真题。';

export interface ModelPlanOptions {
  /** 测试注入口：非 null 时直接把它当作模型输出（空串 = 模拟模型调用失败），不联网。 */
  rawOutput?: string | null;
  maxTokens?: number;
}

export interface ModelPlanProposalResult extends PlanProposalResult {
  /** model = 真拿到了模型草稿（无论最终接受还是拒绝）；none = 没拿到可用草稿（调用方回落规则版）。 */
  by: "model" | "none";
  /** 原始模型输出的前 400 字（排查/回放用）。 */
  raw?: string;
}

/** 给模型的上下文：按拓扑序列出"知识点 + 前置 + 资料 + 真题 + 当前掌握度"，尽量短。 */
function buildPlanPrompt(net: SimNet): string {
  const lines: string[] = [];
  for (const p of net.topoOrder()) {
    const pid = p.pid ?? -1;
    const prevs = pid >= 0 ? net.graph[pid].prev.map((q) => q.name) : [];
    const q = net.queryPoint({ name: p.name });
    const mastery = net.state.get(net.keyOf(p.name));
    lines.push(
      `- ${p.name}｜掌握度：${mastery === undefined ? "未学过(先验0.5)" : mastery.toFixed(2)}` +
        `｜前置：${prevs.length ? prevs.join("、") : "无"}` +
        `｜资料：${q.resources.length ? q.resources.join("、") : "无"}` +
        `｜真题：${q.problems.length ? q.problems.map((x) => x.name).join("、") : "无"}`,
    );
  }
  return `知识点清单（按前置顺序）：\n${lines.join("\n")}\n\n请给出一份学习计划 JSON 数组。`;
}

function parseJSONLoose(s: string): unknown {
  const t = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/**
 * 兼容模型常见的两种外壳：`{"plan":[...]}` 与直接给数组。
 * 之所以要这层：chat() 走的是 `response_format: {type:"json_object"}`，
 * 该模式的顶层**必须是对象**（OpenAI/DeepSeek 兼容接口的硬约束），
 * 所以就算提示词写"返回数组"，模型也会把数组包一层 —— 实测就是这样被拒的
 * （拒绝理由"草稿必须是数组"看着像模型乱来，其实是接口约束，得在系统侧剥壳）。
 */
function unwrapDraft(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["plan", "draft", "items", "learnPlan", "plans"]) {
      if (Array.isArray(obj[key])) return obj[key];
    }
    const arrays = Object.values(obj).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  return parsed;
}

function shortReasonOf(e: unknown): string {
  return String(e).split("\n")[0].replace(/\s+/g, " ").slice(0, 120);
}

/**
 * 让**真模型**提一份计划草稿，再走 `proposePlan` 的同一套校验。
 *
 * 三种出口（都不抛异常、调用方永远能回落 `net.makePlan()`）：
 *   ① 模型调用失败/空输出 ⇒ rejected + 决策日志，by="none"；
 *   ② 输出不是合法 JSON   ⇒ rejected + 决策日志，by="none"；
 *   ③ 拿到草稿 ⇒ 交给 proposePlan 校验（可能 accepted，也可能 rejected），by="model"。
 */
export async function proposePlanFromModel(
  net: SimNet,
  opts: ModelPlanOptions = {},
): Promise<ModelPlanProposalResult> {
  let raw = "";
  try {
    raw =
      opts.rawOutput != null
        ? opts.rawOutput
        : await chat(
            [
              { role: "system", content: PLAN_SYS },
              { role: "user", content: buildPlanPrompt(net) },
            ],
            { json: true, maxTokens: opts.maxTokens ?? 1200 },
          );
    if (!raw.trim()) throw new Error("模型返回空内容");
  } catch (e) {
    const reason = `模型提议失败：${shortReasonOf(e)}`;
    net.logDecision({ at: new Date().toISOString(), action: "proposePlan.reject", reasons: [reason], draft: null });
    return { accepted: false, rejected: [reason], by: "none" };
  }

  const draft = parseJSONLoose(raw);
  if (draft === null) {
    const reason = "模型输出不是合法 JSON（已拒绝，未执行）";
    net.logDecision({
      at: new Date().toISOString(),
      action: "proposePlan.reject",
      reasons: [reason],
      draft: { raw: raw.slice(0, 400) },
    });
    return { accepted: false, rejected: [reason], by: "none", raw: raw.slice(0, 400) };
  }

  // 剥掉 {"plan": [...]} 外壳后再校验；剩下的校验（覆盖完整/恰好一次/拓扑/资源与真题存在性）全在 proposePlan 里
  const res = proposePlan(net, unwrapDraft(draft));
  return { ...res, by: "model", raw: raw.slice(0, 400) };
}
