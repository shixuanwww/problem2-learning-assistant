// ============================================================================
// tests/network.test.ts — 用例 1–6、7/8、4、5、6、13、14、15、17、19
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimNet } from "../src/network.ts";
import { makeNet, makeNetWithProblems, matReq, planIsValid, makeTempDir } from "./helpers.ts";
import { QaEngine } from "../src/qa.ts";
import type { AnalyzeResReq } from "../src/types.ts";

// 用例 1：同一知识点出现在 2 份资料 → 只建 1 个 Point，resources 含 2 条
test("用例1：同一知识点出现在多份资料只建一个Point，resources去重", () => {
  const net = makeNet();
  net.integrate({
    kind: "ResReq",
    data: matReq("data/materials/m04-extra.md", ["整数加减", "小数"], []) as AnalyzeResReq,
  });
  const pid = net.graph.findIndex((g) => g.name === "整数加减");
  assert.ok(pid >= 0, "整数加减应存在");
  assert.equal(net.pointMention.length, net.graph.length);
  assert.ok(
    net.graph[pid].resources.includes("data/materials/m01-integers.md") &&
      net.graph[pid].resources.includes("data/materials/m04-extra.md"),
    "resources 应含 2 条",
  );
  assert.equal(net.graph.filter((g) => g.name === "整数加减").length, 1);
});

// 用例 2：不同名同义知识点合并
test("用例2：不同名同义知识点经归一化/别名合并为一个点", () => {
  const net = new SimNet({
    dataDir: makeTempDir(),
    skipLoad: true,
    aliases: { "整数加法与减法": "整数加减" },
  });
  net.integrate({ kind: "ResReq", data: matReq("data/material/a.md", [" 整数加减 ", "整数乘除"], []) as AnalyzeResReq });
  net.integrate({ kind: "ResReq", data: matReq("data/material/b.md", ["整数加法与减法"], []) as AnalyzeResReq });
  assert.equal(net.graph.length, 2, "应合并为：整数加减 + 整数乘除");
  const merged = net.graph.find((g) => net.keyOf(g.name) === "整数加减")!;
  assert.ok(merged, "应有的合并点（规范名 整数加减）");
  assert.deepEqual(merged.resources, ["data/material/a.md", "data/material/b.md"]);
});

// 用例 3：5 道真题覆盖 3 个知识点 → pointRank 顺序正确（考频高的在前）
test("用例3：pointRank 按考频降序", () => {
  const net = makeNetWithProblems();
  const rank = net.pointRank(3);
  assert.equal(rank[0].name, "整数加减"); // 默认课程中频次最高
  assert.ok(rank.length <= 3);
});

// 用例 4：前置边 A→B→C → 计划中 A 在 B 前、B 在 C 前
test("用例4：makePlan 满足前置约束（from 在 to 前）", () => {
  const net = new SimNet({ dataDir: makeTempDir(), skipLoad: true });
  net.integrate({ kind: "ResReq", data: matReq("m.md", ["A", "B", "C"], [["A", "B"], ["B", "C"]]) as AnalyzeResReq });
  const plan = net.makePlan();
  const order = plan.map((p) => p.point.name);
  assert.ok(order.indexOf("A") < order.indexOf("B"), "A 在 B 前");
  assert.ok(order.indexOf("B") < order.indexOf("C"), "B 在 C 前");
  assert.ok(planIsValid(net, plan));
});

// 用例 5：每个知识点恰好出现一次
test("用例5：每个存活知识点恰好出现一次且覆盖全部", () => {
  const net = makeNet();
  assert.ok(planIsValid(net, net.makePlan()));
});

// 用例 6：再上传一份新资料 → 体系更新成功，原计划仍合法
test("用例6：继续上传新资料，体系更新且原顺序仍合法", () => {
  const net = makeNet();
  assert.ok(planIsValid(net, net.makePlan()));
  net.integrate({
    kind: "ResReq",
    data: matReq("data/materials/m05-new.md", ["整数乘除", "几何初步"], [["整数乘除", "几何初步"]]) as AnalyzeResReq,
  });
  assert.ok(planIsValid(net, net.makePlan()));
  assert.ok(net.makePlan().some((p) => p.point.name === "几何初步"), "新点几何初步已并入");
});

// 用例 7 / 8：带引用问答 + 资料不足拒绝
test("用例7/8：带引用问答 + 资料不足拒绝", async () => {
  const net = makeNet();
  const text = "整数加减法是四则运算的基础。加法逢十进一，减法借一当十。";
  const qa = new QaEngine([{ resource: "m.md", locator: "§1", text }]);
  const ok = await qa.ask("整数加减法是什么", net);
  assert.equal(ok.sufficient, true);
  assert.ok(ok.answer && ok.answer.length > 0);
  assert.ok(ok.citations.length >= 1);

  const absent = await qa.ask("二次根式怎么化简", net);
  assert.equal(absent.sufficient, false);
  assert.equal(absent.answer, null);
});

// 用例 13：做错一个带前置约束的知识点 → 计划仍满足 from→to
test("用例13：做错后计划仍满足前置约束", () => {
  const net = makeNet();
  net.record({ kind: "Do", problem: { name: "第1题", content: "", kind: "计算", points: [{ name: "整数加减" }] }, status: "incorrect" });
  net.record({ kind: "Do", problem: { name: "第2题", content: "", kind: "计算", points: [{ name: "整数乘除" }] }, status: "incorrect" });
  assert.ok(planIsValid(net, net.makePlan()));
});

// 用例 14：做错前后对比 → 该点动作数增加（主题 + 回炉题）
test("用例14：做错后薄弱点动作数增加（加量回炉）", () => {
  const net = makeNetWithProblems();
  const before = net.makePlan().find((p) => p.point.name === "整数加减")!.actions.filter((a) => a.kind === "Do").length;
  const wrongProblem = net.problemByName("2023 期末 第1题")!;
  net.record({ kind: "Do", problem: wrongProblem, status: "incorrect" });
  const after = net.makePlan().find((p) => p.point.name === "整数加减")!.actions.filter((a) => a.kind === "Do").length;
  assert.ok(after > before, `做错后薄弱点 Do 动作数应增加：${before} -> ${after}`);
});

// 用例 15：做错一道 kind=计算 的真题 → kindState[计算] 同步下降且落盘
test("用例15：题型掌握度 kindState[计算] 同步下降", () => {
  const net = makeNet();
  const kBefore = net.kindState.get("计算") ?? 0.5;
  net.record({ kind: "Do", problem: { name: "第1题", content: "", kind: "计算", points: [{ name: "整数加减" }] }, status: "incorrect" });
  const kAfter = net.kindState.get("计算") ?? 0.5;
  assert.ok(kAfter < kBefore, "题型掌握度应下降");
  assert.ok(net.answers.some((a) => a.kind === "计算" && a.status === "incorrect"));
});

// 用例 17：首次答错一个从未学过的点 → 掌握度从 0.5 降到 0.25
test("用例17：首次答错从未学过的点，掌握度从先验0.5降", () => {
  const net = makeNet();
  const before = net.state.get("分数") ?? 0.5;
  assert.equal(before, 0.5, "冷启动先验应为 0.5");
  net.record({ kind: "Do", problem: { name: "第4题", content: "", kind: "填空", points: [{ name: "分数" }] }, status: "incorrect" });
  assert.equal(net.state.get("分数") ?? 0.5, 0.25, "0.5 - 0.25 = 0.25");
});

// 用例 19：归一化撞车（括号编号不同）→ 保留两个独立点并记 warning
test("用例19：括号编号不同的点保留为两个独立点（不自动合并）", () => {
  const net = new SimNet({ dataDir: makeTempDir(), skipLoad: true, aliases: {} });
  net.integrate({ kind: "ResReq", data: matReq("a.md", ["整数加减(一)"], []) as AnalyzeResReq });
  net.integrate({ kind: "ResReq", data: matReq("b.md", ["整数加减(二)"], []) as AnalyzeResReq });
  assert.equal(net.graph.length, 2, "应保留两个独立点");
  assert.ok(net.getWarnings().length > 0, "应产生撞车提示");
});
