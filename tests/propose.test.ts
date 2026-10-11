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
  assert.ok(res.rejected.some((r) => r.includes("不存在")), `应指出真题不存在：${res.rejected.join("；")}`);
});

test("用例10b：模型提议引用不存在的知识点 → 被拒", () => {
  const net = makeNetWithProblems();
  const res = proposePlan(net, [
    { pointName: "向量运算", actions: [{ kind: "Explain" }] },
  ]);
  assert.equal(res.accepted, false);
  assert.ok(res.rejected.length > 0);
});

test("用例18：提议的 Read 资源不在该点资料中 → 被拒", () => {
  const net = makeNetWithProblems();
  const res = proposePlan(net, [
    { pointName: "整数加减", actions: [{ kind: "Read", resource: "data/nope.md" }] },
  ]);
  assert.equal(res.accepted, false);
  assert.ok(res.rejected.some((r) => r.includes("Read")));
});

test("用例18b：提案违反拓扑序（把前置点排在后面）→ 被拒", () => {
  const net = makeNetWithProblems();
  // 整数乘除 依赖 整数加减；把 整数乘除 放在 整数加减 前 → 违反
  const res = proposePlan(net, [
    { pointName: "整数乘除", actions: [{ kind: "Explain" }] },
    { pointName: "整数加减", actions: [{ kind: "Explain" }] },
  ]);
  assert.equal(res.accepted, false);
  assert.ok(res.rejected.some((r) => r.includes("前置") || r.includes("约束")), `应指出拓扑约束：${res.rejected.join("；")}`);
});

test("用例18c：合法提议被接受，且回落规则版计划仍可用", () => {
  const net = makeNetWithProblems();
  const ok = proposePlan(net, [
    { pointName: "整数加减", actions: [{ kind: "Explain" }, { kind: "Do", problemName: "2023 期末 第1题" }] },
  ]);
  assert.equal(ok.accepted, true);
  assert.ok(ok.plan && ok.plan.length > 0);
  // 规则版计划（回落）仍能生成且拓扑合法
  const fallback = net.makePlan();
  assert.ok(fallback.length > 0);
});
