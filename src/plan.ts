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
  MASTERY_THRESHOLD,
  masteryOf,
} from "./types.ts";
import type { SimNet } from "./network.ts";

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
 */
export function fillActions(net: SimNet, point: { name: string; pid?: number }): LearnAction[] {
  const key = net.keyOf(point.name);
  const pid = point.pid ?? net.findPointByName(point.name)?.pid;
  const resources = pid !== undefined ? net.graph[pid].resources : [];
  const mastery = masteryOf(net.state, key);
  const mastered = mastery >= MASTERY_THRESHOLD;

  const actions: LearnAction[] = [];

  // 规则 4：前置不足 → 最前补一个前置点资料或讲解（只影响本点动作，不调整知识点顺序）
  if (pid !== undefined) {
    for (const prv of net.graph[pid].prev) {
      if (prv.pid === undefined) continue;
      if (masteryOf(net.state, net.keyOf(prv.name)) < MASTERY_THRESHOLD) {
        const prvResources = net.graph[prv.pid].resources;
        actions.push(prvResources.length > 0
          ? { kind: "Read", resource: prvResources[0] }
          : { kind: "Explain" });
        break;
      }
    }
  }

  if (!mastered) {
    // 规则 1：先读资料（优先与薄弱题型相关，简化取第一个）+ 讲解
    if (resources.length > 0) actions.push({ kind: "Read", resource: resources[0] });
    actions.push({ kind: "Explain" });
  }

  // 规则 2 + 3：选一道"主"真题（优先考频高，排除回炉题），再把"回炉"真题作为额外加量
  const reviewNames = new Set(net.reviewProblemNames({ name: point.name }));
  const primary = pickProblem(net, { name: point.name, pid }, key, reviewNames);
  if (primary) {
    actions.push({ kind: "Do", problem: primary });
  }
  if (!mastered) {
    // 回炉加量：该点答错/糊涂过的题再各追加一道（§4.2 允许的"加量/提前动作"）
    for (const probName of reviewNames) {
      const rp = net.problemByName(probName);
      if (rp && (!primary || rp.name !== primary.name)) {
        actions.push({ kind: "Do", problem: rp });
      }
    }
  }

  return actions;
}

/** 选一道"主"真题（不选回炉；回炉由 fillActions 的加量循环处理）。 */
function pickProblem(
  net: SimNet,
  point: { name: string; pid?: number },
  key: string,
  exclude: Set<string> = new Set(),
): Problem | undefined {
  // 选"主"真题：覆盖本点、且其 points 中 max(pointMention) 最高（考频最高）的题；
  // 排除回炉题（回炉题由 fillActions 的加量循环单独追加，保证做错后动作数真正增加）。
  const q = net.queryPoint({ name: point.name });
  let best: Problem | undefined;
  let bestScore = -1;
  for (const prob of q.problems) {
    if (exclude.has(prob.name)) continue;
    const mentions = prob.points
      .map((pp) => (pp.pid !== undefined ? net.pointMention[pp.pid] : 0))
      .concat([0]);
    const score = Math.max(...mentions);
    if (score > bestScore) {
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
 */
export function proposePlan(net: SimNet, draft: unknown): PlanProposalResult {
  // 1) schema 校验（字段 / 类型 / 枚举）
  const schemaErrs = validateDraftSchema(draft);
  if (schemaErrs.length > 0) {
    return { accepted: false, rejected: schemaErrs };
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

  if (rejected.length > 0) {
    return { accepted: false, rejected };
  }

  // 5) 拓扑序校验：from 必须在 to 之前（§4.2 硬要求）
  const topoErrs = validateTopoOrder(net, plan);
  if (topoErrs.length > 0) {
    return { accepted: false, rejected: topoErrs };
  }

  return { accepted: true, plan };
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
    const key = net.keyOf(plan[i].point.name);
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
