// ============================================================================
// tests/audit3.test.ts — 2026-10-11 第三轮代码审计后的修复用例（34–39）
//
//   用例34：关键词充足性不能"跨片段拼凑" —— 资料没覆盖的问题必须拒答；
//           同一批资料里，真正讲到了的问题仍要能回答（不能一刀切全拒）。
//   用例35：章节标题（"1 小数的认识"）也参与匹配 —— 标题只在 locator 里、正文一次不写该词时，
//           问标题里的词也要能命中（修前会被误判"资料不足"）。
//   用例36：同一道真题重入库（考点变了）后，考频 pointMention 必须与题目集一致；
//           重复入库同一考点集合不得把考频刷高（幂等）。
//   用例37：mergePoints → 重启（新建实例读回 graph.json）→ 再用**旧名**接入资料 ⇒
//           资料必须归到合并目标上（修前会挂到一个查不到的 dead 点，静默丢数据）。
//   用例38：合并候选 mergeCandidates 能把同义写法列出来，但**不自动合并**；
//           "整体-部分"关系（分数 / 分数加减）不该被误报为候选。
//   用例39：proposePlanFromModel —— 模型草稿走同一套校验；非法草稿被拒且留决策日志；
//           模型输出不是 JSON 时如实标 by="none"（调用方回落规则版计划）。
//
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimNet } from "../src/network.ts";
import { proposePlanFromModel } from "../src/plan.ts";
import { QaEngine } from "../src/qa.ts";
import { makeNet, makeNetWithProblems, makeTempDir } from "./helpers.ts";

// ---------- 真实语料（取自 data/materials/，locator 也用真实标题路径） ----------
const CHUNK_INT_MULDIV = {
  resource: "data/materials/m01-integers.md",
  locator: "二年级数学 · 整数运算 / 2 整数乘除法",
  text:
    "整数乘法是求几个相同加数的简便运算，例如 3 × 4 表示 3 个 4 相加（3 × 4 = 12）。除法是乘法的逆运算。\n" +
    "掌握整数乘除之前应熟练掌握整数加减，因为乘除的竖式计算依赖加减的进位与退位。",
};
const CHUNK_DECIMAL_BASIC = {
  resource: "data/materials/m03-decimals.md",
  locator: "三年级数学 · 小数 / 1 小数的认识",
  text: "小数由整数部分、小数点与小数部分组成。例如 3.14 中，3 是整数部分，14 是小数部分。小数点右边依次是十分位、百分位、千分位。",
};
const CHUNK_DECIMAL_ADD = {
  resource: "data/materials/m03-decimals.md",
  locator: "三年级数学 · 小数 / 2 小数加减",
  text: "小数加减法的要点：小数点对齐，从末位算起。\n例如 0.5 + 0.3 = 0.8；2.5 - 1.2 = 1.3。",
};
test("用例34：资料未覆盖的问题必须拒答（不能靠多片段拼成『充足』）", async () => {
  const net = makeNet();
  // 资料里只有「小数的认识」「小数加减」「整数乘除」——没有"小数的乘除法"
  const qa = new QaEngine([CHUNK_INT_MULDIV, CHUNK_DECIMAL_BASIC, CHUNK_DECIMAL_ADD], net, { offline: true });

  const bad = await qa.ask("小数乘除法怎么计算");
  assert.equal(bad.sufficient, false, "资料没讲小数的乘除法 ⇒ 必须判资料不足");
  assert.equal(bad.answer, null, "资料不足时不得给出答案");

  const bad2 = await qa.ask("分数的乘除法怎么算");
  assert.equal(bad2.sufficient, false, "资料里完全没有分数 ⇒ 必须判资料不足");
  assert.equal(bad2.answer, null);

  // 反面对照：同一批资料里真正讲到的问题仍要能回答（修完不能变成"什么都拒"）
  const ok = await qa.ask("小数加减法怎么做");
  assert.equal(ok.sufficient, true, "资料确实讲了小数加减 ⇒ 应能回答");
  assert.ok(ok.answer && ok.answer.includes("小数点对齐"));
});

test("用例35：章节标题参与匹配（问小节标题里的词要能命中）", async () => {
  const net = makeNet();
  // 正文里一次都没写"认识"二字，只有小节标题「1 小数的认识」有
  const qa = new QaEngine([CHUNK_DECIMAL_BASIC, CHUNK_DECIMAL_ADD], net, { offline: true });
  const r = await qa.ask("小数的认识是什么");
  assert.equal(r.sufficient, true, `标题词应参与匹配（修前这里是资料不足）`);
  assert.ok(r.answer && r.answer.includes("小数由整数部分"));
  assert.equal(r.citations[0].locator, CHUNK_DECIMAL_BASIC.locator);
});

test("用例36：真题重入库后考频与题目集一致，且重复入库不刷高考频", () => {
  const net = new SimNet({ dataDir: makeTempDir(), skipLoad: true, aliases: {} });
  net.integrate({
    kind: "ResReq",
    data: { resource: "m.md", points: [{ name: "整数加减" }, { name: "整数乘除" }], edges: [] },
  });
  const pro = (points: string[]) => ({
    kind: "ProReq" as const,
    data: { problem: { name: "T1", content: "x", kind: "计算", points: points.map((n) => ({ name: n })) }, points: points.map((n) => ({ name: n })) },
  });

  net.integrate(pro(["整数加减"]));
  assert.deepEqual(net.pointMention, [1, 0], "首次入库：只有 整数加减 被覆盖");

  // 同一道题重入库、考点改成 整数乘除 ⇒ 考频要跟着改（修前仍是 [1,0]）
  net.integrate(pro(["整数乘除"]));
  assert.deepEqual(net.pointMention, [0, 1], "重入库后考频必须与题目集一致");
  assert.equal(net.pointRank(1)[0].name, "整数乘除", "考频第一必须是真正被覆盖的点");

  // 幂等：同一考点集合再入库两次，考频不变（不能刷高）
  net.integrate(pro(["整数乘除"]));
  net.integrate(pro(["整数乘除"]));
  assert.deepEqual(net.pointMention, [0, 1], "重复入库不得把考频刷高");
});

test("用例37：合并 → 重启 → 再用旧名接入资料，必须归到合并目标（不丢数据）", () => {
  const dir = makeTempDir();
  const net = new SimNet({ dataDir: dir, skipLoad: true, aliases: {} });
  net.integrate({
    kind: "ResReq",
    data: { resource: "a.md", points: [{ name: "整数加减" }, { name: "整数加减法" }], edges: [] },
  });
  net.mergePoints({ name: "整数加减法" }, { name: "整数加减" });
  assert.deepEqual(net.alivePoints().map((p) => p.name), ["整数加减"]);

  // 模拟重启：新建实例从 graph.json 读回（修前 dead 点的名字会被重新注册成"活的查不到"）
  const reloaded = new SimNet({ dataDir: dir });
  assert.deepEqual(reloaded.alivePoints().map((p) => p.name), ["整数加减"], "重启后仍只有合并后的一个点");

  // 用**旧名**再接入一份资料 ⇒ 必须记到合并目标上
  reloaded.integrate({
    kind: "ResReq",
    data: { resource: "b.md", points: [{ name: "整数加减法" }], edges: [] },
  });
  assert.deepEqual(reloaded.alivePoints().map((p) => p.name), ["整数加减"], "不得凭空复活一个 dead 点");
  const q = reloaded.queryPoint({ name: "整数加减" });
  assert.deepEqual(q.resources.sort(), ["a.md", "b.md"], "新资料必须挂在合并后的点上");
  assert.deepEqual(reloaded.queryPoint({ name: "整数加减法" }).resources.sort(), ["a.md", "b.md"], "旧名也应查到合并目标");

  // 用旧名记录作答 ⇒ 掌握度记到合并目标上，不得留下图里查不到的孤儿 key
  reloaded.record({
    kind: "Do",
    problem: { name: "T1", content: "", kind: "计算", points: [{ name: "整数加减法" }] },
    status: "incorrect",
  });
  assert.ok(reloaded.state.has(reloaded.keyOf("整数加减")), "旧名的作答要记到合并目标上");
  assert.ok(!reloaded.state.has(reloaded.keyOf("整数加减法")), "不得留下孤儿 state key");
});

test("用例38：合并候选只提示不自动合并，且不把『整体-部分』误报为同义", () => {
  const net = new SimNet({ dataDir: makeTempDir(), skipLoad: true, aliases: {} });
  net.integrate({
    kind: "ResReq",
    data: {
      resource: "m.md",
      points: [{ name: "小数加减法" }, { name: "小数加减" }, { name: "分数" }, { name: "分数加减" }],
      edges: [],
    },
  });
  const cands = net.mergeCandidates();
  const key = (a: string, b: string): boolean =>
    cands.some((c) => new Set([c.from.name, c.into.name]).size === 2 && [c.from.name, c.into.name].sort().join("|") === [a, b].sort().join("|"));

  assert.ok(key("小数加减法", "小数加减"), `同义写法应进候选：${JSON.stringify(cands)}`);
  assert.ok(!key("分数", "分数加减"), "整体-部分关系（分数 / 分数加减）不该被当成同义候选");
  // 只提示、不自动合并：图里四个点一个都没少
  assert.equal(net.alivePoints().length, 4, "mergeCandidates 不得改动知识体系");
});

test("用例39：模型提议通道 —— 合法草稿被接受，非法草稿被拒且留痕，非 JSON 如实回落", async () => {
  const net = makeNetWithProblems();
  const legalDraft = net.makePlan().map((it) => ({ pointName: it.point.name, actions: [{ kind: "Explain" }] }));

  const ok = await proposePlanFromModel(net, { rawOutput: JSON.stringify(legalDraft) });
  assert.equal(ok.by, "model");
  assert.equal(ok.accepted, true, `合法草稿应被接受：${(ok.rejected ?? []).join("；")}`);
  assert.equal(ok.plan?.length, net.alivePoints().length);

  // 编造真题 ⇒ 必须被拒（后端不执行），并记决策日志
  const decisionsBefore = net.decisions.length;
  const badDraft = net.makePlan().map((it, i) => ({
    pointName: it.point.name,
    actions: [{ kind: i === 0 ? "Do" : "Explain", ...(i === 0 ? { problemName: "2024 期末 第9题（不存在的真题）" } : {}) }],
  }));
  const bad = await proposePlanFromModel(net, { rawOutput: JSON.stringify(badDraft) });
  assert.equal(bad.by, "model");
  assert.equal(bad.accepted, false, "编造真题必须被拒");
  assert.ok((bad.rejected ?? []).some((r) => r.includes("不存在")));
  assert.equal(net.decisions.length, decisionsBefore + 1, "拒绝必须留决策日志（可回放）");
  assert.equal(net.decisions[net.decisions.length - 1].action, "proposePlan.reject");
  // 被拒后回落规则版计划仍然可用（调用方永远有退路）
  assert.ok(net.makePlan().length > 0);

  // 模型输出不是 JSON / 调用失败 ⇒ by="none"，也要留痕，不抛异常
  const junk = await proposePlanFromModel(net, { rawOutput: "我觉得应该先学整数加减法。" });
  assert.equal(junk.by, "none");
  assert.equal(junk.accepted, false);
  const err = await proposePlanFromModel(net, { rawOutput: "" });
  assert.equal(err.by, "none");
  assert.ok((err.rejected ?? [])[0].includes("失败"));
});
