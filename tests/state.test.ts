// ============================================================================
// tests/state.test.ts — 用例 9：做错一道真题 → state 下降且**落盘**；下次计划针对该点加题
//   跑法：node --experimental-strip-types --test tests/*.test.ts
//
//   为什么单独补这一条：§8 用例 9 的三件事此前被 13/14/15/17 分摊着覆盖，但——
//     - 13/14 只看"计划仍合法 / 动作数增加"，不验掌握度数值；
//     - 15/17 只看"掌握度下降"，不验**落盘**、也不验"下次计划针对该点加题"。
//   于是"做错一次 → 掌握度下降 → 真落盘 → 计划据此加题"这条端到端链路没有独立用例。
//   本用例把它一次跑全，且"落盘"用**另建实例从磁盘载入**验证（不是读内存冒充）。
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimNet } from "../src/network.ts";
import { wireActions } from "../src/plan.ts";
import { masteryOf } from "../src/types.ts";
import { makeNetWithProblems, makeTempDir } from "./helpers.ts";

test("用例9：做错一道真题 → 掌握度下降并落盘，且下次计划为该点加题", () => {
  const dir = makeTempDir();
  const net = makeNetWithProblems(dir);
  const key = net.keyOf("整数加减");

  // 基线：冷启动先验 0.5；做错前该点的 Do 动作数
  const before = masteryOf(net.state, key);
  assert.equal(before, 0.5, "冷启动先验应为 0.5");
  const doBefore = net
    .makePlan()
    .find((p) => net.keyOf(p.point.name) === key)!
    .actions.filter((a) => a.kind === "Do").length;

  // 做错一道覆盖该点的真题
  const prob = net.problemByName("2023 期末 第1题")!;
  net.record({ kind: "Do", problem: prob, status: "incorrect" });

  // ① 掌握度下降（数值可复现）
  const after = net.state.get(key)!;
  assert.ok(after < before, `掌握度应下降：${before} -> ${after}`);
  assert.equal(after, 0.25, "0.5 - 0.25 = 0.25");

  // ② 落盘：另建实例从同一临时目录载入（真读盘，非内存冒充）
  const reloaded = new SimNet({ dataDir: dir });
  wireActions(reloaded);
  assert.equal(reloaded.state.get(key), after, "另起实例应读回落盘后的掌握度");

  // ③ 下次计划针对该薄弱点加题：载入后该点 Do 动作数增加（主题 + 回炉题）
  const doAfter = reloaded
    .makePlan()
    .find((p) => reloaded.keyOf(p.point.name) === key)!
    .actions.filter((a) => a.kind === "Do").length;
  assert.ok(doAfter > doBefore, `落盘重载后该点 Do 动作数应增加：${doBefore} -> ${doAfter}`);
});
