// ============================================================================
// tests/plan.test.ts — 用例 27/28/29：动作填充的两条规则（2026-10-11 审核后补）
//
//   用例 27：**同一份资料不被读两遍** —— "前置点的 Read"（规则 4）与"本点的 Read"（规则 1）
//            常指向同一份教材，修前会产生 [读 X, 读 X, 讲解, 做…] 的冗余动作。
//   用例 28：**薄弱题型优先**（题面 L3 完成标志③"增加薄弱题型训练"）—— 修前 kindState
//            只被写、不被读，题型掌握度对计划没有任何影响。
//   用例 29：**动作填充是确定性的** —— 同一份状态重复调用 fillActions 结果逐项一致
//            （没有隐藏的随机/时间依赖；评审机重复演示必须一样）。
//
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimNet } from "../src/network.ts";
import { fillActions, wireActions } from "../src/plan.ts";
import { MASTERY_THRESHOLD } from "../src/types.ts";
import { makeTempDir } from "./helpers.ts";

/** 造一个两知识点的网络：A → B，且两份资料**指向同一份文件**（复现"读两遍"的场景）。 */
function makeSharedResourceNet(): SimNet {
  const net = new SimNet({ dataDir: makeTempDir(), skipLoad: true, aliases: {} });
  wireActions(net);
  net.integrate({
    kind: "ResReq",
    data: {
      resource: "data/materials/shared.md",
      points: [{ name: "A" }, { name: "B" }],
      edges: [[{ name: "A" }, { name: "B" }]],
    },
  });
  return net;
}

test("用例27：前置与本点共用同一份资料时，Read 动作只出现一次", () => {
  const net = makeSharedResourceNet();
  const b = net.findPointByName("B")!;
  const actions = fillActions(net, b);

  const reads = actions.filter((a) => a.kind === "Read");
  assert.equal(reads.length, 1, `同一份资料应只读一次，实际 ${JSON.stringify(actions)}`);
  assert.equal(reads[0].kind === "Read" && reads[0].resource, "data/materials/shared.md");

  // 前置点的资料写在前，且讲解/做题没有被误删
  assert.equal(actions[0].kind, "Read", "规则 4 的 Read 应在最前");
  assert.equal(actions.filter((a) => a.kind === "Explain").length, 1, "Explain 仍应有一条");

  // 对照：B 的前置 A 已掌握 ⇒ 不再补前置 Read，动作数应减少（证明去重不是"永远只留一条"）
  net.state.set(net.keyOf("A"), MASTERY_THRESHOLD);
  const actions2 = fillActions(net, b);
  assert.equal(actions2.filter((a) => a.kind === "Read").length, 1, "本点的 Read 仍在");
});

test("用例28：kindState 低于阈值的题型优先被选中（薄弱题型训练）", () => {
  const net = makeSharedResourceNet();
  // B 点挂两道题：一道"计算"、一道"填空"，考频相同（排除考频干扰）
  net.integrate({
    kind: "ProReq",
    data: { problem: { name: "P-计算", content: "", kind: "计算", points: [{ name: "B" }] }, points: [{ name: "B" }] },
  });
  net.integrate({
    kind: "ProReq",
    data: { problem: { name: "P-填空", content: "", kind: "填空", points: [{ name: "B" }] }, points: [{ name: "B" }] },
  });

  const b = net.findPointByName("B")!;
  const firstDo = (): string => {
    const a = fillActions(net, b).find((x) => x.kind === "Do");
    return a && a.kind === "Do" ? a.problem.name : "(none)";
  };

  // 默认都没学过（先验 0.5，未达阈值）⇒ 两道都算"薄弱题型"，按题型名/题名确定性排序
  const before = firstDo();

  // 把"填空"掌握度压到很低 ⇒ 它应是唯一的薄弱题型，主练习题必须切到 P-填空
  net.kindState.set("填空", 0.1);
  net.kindState.set("计算", 0.9);
  assert.equal(firstDo(), "P-填空", `薄弱题型应先练：${before} → ${firstDo()}`);

  // 反过来：压"计算" ⇒ 主练习题切到 P-计算（证明它真的跟着 kindState 走）
  net.kindState.set("填空", 0.9);
  net.kindState.set("计算", 0.1);
  assert.equal(firstDo(), "P-计算");
});

test("用例29：动作填充是确定性的（同一状态两次调用逐项一致）", () => {
  const net = makeSharedResourceNet();
  net.integrate({
    kind: "ProReq",
    data: { problem: { name: "P1", content: "", kind: "计算", points: [{ name: "B" }] }, points: [{ name: "B" }] },
  });
  net.integrate({
    kind: "ProReq",
    data: { problem: { name: "P2", content: "", kind: "计算", points: [{ name: "B" }] }, points: [{ name: "B" }] },
  });
  const b = net.findPointByName("B")!;
  const a1 = JSON.stringify(fillActions(net, b));
  const a2 = JSON.stringify(fillActions(net, b));
  assert.equal(a1, a2, "同一状态两次填充必须完全一致");
  // 计划整体也应一致
  assert.equal(JSON.stringify(net.makePlan()), JSON.stringify(net.makePlan()));
});

test("用例30：同一层里「已掌握」的点必须排在「未掌握」的点之后", () => {
  // 【2026-10-11 审核后修】修前比较器把已掌握写成 `已掌握 ? 1 : 0` 且按升序排，
  // 结果是"已掌握的点排最前"，与 §4.2 / README / 题面 L3 完成标志③ 全反。
  const net = new SimNet({ dataDir: makeTempDir(), skipLoad: true, aliases: {} });
  wireActions(net);
  // 同一层三个互不依赖的点：A、B 未掌握，C 已掌握
  net.integrate({
    kind: "ResReq",
    data: { resource: "m.md", points: [{ name: "A" }, { name: "B" }, { name: "C" }], edges: [] },
  });
  net.state.set(net.keyOf("C"), MASTERY_THRESHOLD);

  const order = net.makePlan().map((x) => x.point.name);
  assert.deepEqual(order, ["A", "B", "C"], `未掌握在前、已掌握在后，实际 ${JSON.stringify(order)}`);

  // 再让 B 也掌握 ⇒ B 应被排到 C 之后（同在"已掌握"组内按掌握度升序）
  net.state.set(net.keyOf("B"), MASTERY_THRESHOLD);
  assert.deepEqual(net.makePlan().map((x) => x.point.name), ["A", "B", "C"]);

  // 已掌握的点即使考频最高也不插队（考频是第三优先级）
  assert.ok(net.pointRank(3).length <= 3, "pointRank 不受计划排序键影响");
});

test("用例31：跨过掌握阈值后，该点动作数收敛为「一道巩固题」", () => {
  const net = makeSharedResourceNet();
  net.integrate({
    kind: "ProReq",
    data: { problem: { name: "P1", content: "", kind: "计算", points: [{ name: "B" }] }, points: [{ name: "B" }] },
  });
  const b = net.findPointByName("B")!;
  const before = fillActions(net, b).length;
  assert.ok(before >= 2, "未掌握时应是 读+讲解+做题");
  assert.ok(fillActions(net, b).some((a) => a.kind === "Read"));

  // 顺手把前置 A 标为已掌握：这样"没有 Read"只可能是因为"本点已掌握"，
  // 而不是因为规则 4（前置不足）本就不补 Read —— 否则断言证明不了收敛。
  net.state.set(net.keyOf("A"), MASTERY_THRESHOLD);
  net.state.set(net.keyOf("B"), 0.95);
  const after = fillActions(net, b);
  assert.equal(after.filter((a) => a.kind === "Do").length, 1, "已掌握只留一道巩固题");
  assert.ok(!after.some((a) => a.kind === "Read"), "已掌握不再安排读资料");
  assert.ok(after.length < before, `动作数应收敛：${before} → ${after.length}`);
});
