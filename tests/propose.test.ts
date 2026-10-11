// ============================================================================
// tests/propose.test.ts — 用例 10、18：模型提议的校验/拒绝/回落
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposePlan } from "../src/plan.ts";
import { makeNetWithProblems } from "./helpers.ts";

test("用例10：模型提议引用不存在的真题 → 被拒", () => {
  const net = makeNetWithProblems();
  const res = proposePlan(net, [
    { pointName: "整数加减", actions: [{ kind: "Do", problemName: "不存在的题" }] },
  ]);
  assert.equal(res.accepted, false);
  const why1 = res.rejected ?? [];
  assert.ok(why1.some((r) => r.includes("不存在")), `应指出真题不存在：${why1.join("；")}`);
});

test("用例10b：模型提议引用不存在的知识点 → 被拒", () => {
  const net = makeNetWithProblems();
  const res = proposePlan(net, [
    { pointName: "向量运算", actions: [{ kind: "Explain" }] },
  ]);
  assert.equal(res.accepted, false);
  assert.ok((res.rejected ?? []).length > 0);
});

test("用例18：提议的 Read 资源不在该点资料中 → 被拒", () => {
  const net = makeNetWithProblems();
  const res = proposePlan(net, [
    { pointName: "整数加减", actions: [{ kind: "Read", resource: "data/nope.md" }] },
  ]);
  assert.equal(res.accepted, false);
  assert.ok((res.rejected ?? []).some((r) => r.includes("Read")));
});

test("用例18b：提案违反拓扑序（把前置点排在后面）→ 被拒", () => {
  const net = makeNetWithProblems();
  // 覆盖**全部**知识点（先过"恰好一次"检查），但把 整数乘除 排在它的前置 整数加减 之前 ⇒ 只剩拓扑一处不过
  const names = net.alivePoints().map((p) => p.name);
  const bad = ["整数乘除", ...names.filter((n) => n !== "整数乘除")];
  const res = proposePlan(
    net,
    bad.map((n) => ({ pointName: n, actions: [{ kind: "Explain" as const }] })),
  );
  assert.equal(res.accepted, false, "违反拓扑序应被拒");
  assert.ok(
    res.rejected?.some((r) => r.includes("前置") || r.includes("约束")),
    `应指出拓扑约束：${res.rejected?.join("；")}`,
  );
});

test("用例18c：合法且**覆盖全部知识点**的提议被接受；拒绝时回落规则版计划仍可用", () => {
  const net = makeNetWithProblems();
  // 按规则版计划的顺序（天然满足拓扑序）逐点给出 Explain 动作 ⇒ 覆盖完整
  const draft = net.makePlan().map((it) => ({
    pointName: it.point.name,
    actions: [{ kind: "Explain" as const }],
  }));
  const ok = proposePlan(net, draft);
  assert.equal(ok.accepted, true, `应被接受，实际拒绝：${(ok.rejected ?? []).join("；")}`);
  assert.equal(ok.plan?.length, net.alivePoints().length, "应覆盖全部存活知识点");
  // 规则版计划（回落）仍能生成且拓扑合法
  const fallback = net.makePlan();
  assert.ok(fallback.length > 0);
});

// 【2026-10-11 新增】§4.13 校验 6：每个知识点恰好一次 —— 遗漏必须被拒
test("用例18d：提议**遗漏**了知识点 → 被拒（§4.13 校验6）", () => {
  const net = makeNetWithProblems();
  const full = net.makePlan().map((it) => ({ pointName: it.point.name, actions: [{ kind: "Explain" as const }] }));
  const partial = full.slice(0, 1); // 只留 1 个点，其余全漏
  const res = proposePlan(net, partial);
  assert.equal(res.accepted, false, "遗漏知识点应被拒");
  assert.ok(
    res.rejected?.some((r) => r.includes("遗漏")),
    `应明确指出遗漏：${res.rejected?.join("；")}`,
  );
});

// 【2026-10-11 新增】§4.13 决策日志：接受 / 拒绝都要留痕（含原始草稿）
test("用例18e：提议被拒时记入决策日志（理由 + 原始草稿）", () => {
  const net = makeNetWithProblems();
  const before = net.decisions.length;
  const draft = [{ pointName: "不存在的知识点", actions: [{ kind: "Explain" }] }];
  const res = proposePlan(net, draft);
  assert.equal(res.accepted, false);
  assert.equal(net.decisions.length, before + 1, "应新增一条决策日志");
  const last = net.decisions[net.decisions.length - 1];
  assert.equal(last.action, "proposePlan.reject");
  assert.ok(last.reasons.length > 0, "应记录拒绝理由");
  assert.deepEqual(last.draft, draft, "应原样保留模型草稿，便于回放");
});
