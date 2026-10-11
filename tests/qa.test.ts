// ============================================================================
// tests/qa.test.ts — 用例 16（记录回填）+ 补充 7/8 的 as-return 语义
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { QaEngine } from "../src/qa.ts";
import { makeNet } from "./helpers.ts";

test("用例16：ask 一个资料不足的问题 → answer=null + sufficient=false + history 新增 Ask 记录", async () => {
  const net = makeNet();
  const before = net.history.filter((h) => h.kind === "Ask").length;
  const qa = new QaEngine([{ resource: "m.md", locator: "§1", text: "整数加减法是四则运算的基础。" }], net, {
    offline: true,
  });
  const res = await qa.ask("什么是酸碱中和反应");
  assert.equal(res.sufficient, false);
  assert.equal(res.answer, null);
  const after = net.history.filter((h) => h.kind === "Ask").length;
  assert.equal(after, before + 1, "应新增一条 Ask 学习记录");
});

test("用例16b：ask 资料充足 → answer 非空且也回填 Ask 记录", async () => {
  const net = makeNet();
  const before = net.history.filter((h) => h.kind === "Ask").length;
  const qa = new QaEngine(
    [{ resource: "m.md", locator: "§1", text: "整数加减法是四则运算的基础，加法逢十进一。" }],
    net,
    { offline: true },
  );
  const res = await qa.ask("整数加减法是什么");
  assert.equal(res.sufficient, true);
  assert.ok(res.answer && res.answer.length > 0);
  assert.ok(res.citations.length >= 1);
  const after = net.history.filter((h) => h.kind === "Ask").length;
  assert.equal(after, before + 1);
});

// ---------------------------------------------------------------------------
// 用例 32/33（2026-10-11 审核后补）：模型这一层也必须能"拒答"
//   修前：检索阈值判充足就让模型作答，模型即使回一句"资料不足"，也会被当成
//         有效回答返回（sufficient 仍为 true）—— 与题面"资料不足应提示说明资料不足，
//         而不是直接依赖模型自身知识补全"冲突，且答辩时一问就露。
// ---------------------------------------------------------------------------
test("用例32：模型回答「资料不足」⇒ 转成 answer=null + sufficient=false，并回填 Ask 记录", async () => {
  const net = makeNet();
  const qa = new QaEngine(
    [{ resource: "m.md", locator: "§1", text: "整数加减法是四则运算的基础，加法逢十进一。" }],
    net,
    { answerOverride: "资料不足，无法依据现有片段回答。" }, // 注入 = 假装模型这样回答（不联网）
  );
  const before = net.history.filter((h) => h.kind === "Ask").length;
  const res = await qa.ask("整数加减法是什么");
  assert.equal(res.sufficient, false, "模型自己说资料不足 ⇒ sufficient 必须为 false");
  assert.equal(res.answer, null, "不得把「资料不足」当有效答案返回");
  assert.ok(res.citations.length >= 1, "仍应给出检索到的出处，便于人工复核");
  assert.equal(net.history.filter((h) => h.kind === "Ask").length, before + 1, "仍要留痕");
});

test("用例33：模型给出正常回答 ⇒ 原样返回；模型调用失败 ⇒ 抽取式降级", async () => {
  const chunks = [{ resource: "m.md", locator: "§1", text: "整数加减法是四则运算的基础。" }];
  // ① 正常回答
  const net1 = makeNet();
  const qa1 = new QaEngine(chunks, net1, { answerOverride: "整数加减法是四则运算的基础。" });
  const ok = await qa1.ask("整数加减法是什么");
  assert.equal(ok.sufficient, true);
  assert.equal(ok.answer, "整数加减法是四则运算的基础。");

  // ② 模型失败（override = 空串 ⇒ 内部抛错）⇒ 抽取式：直接返回命中片段 + fallback 标注
  const net2 = makeNet();
  const qa2 = new QaEngine(chunks, net2, { answerOverride: "" });
  const fb = await qa2.ask("整数加减法是什么");
  assert.equal(fb.sufficient, true);
  assert.equal(fb.answer, "整数加减法是四则运算的基础。", "抽取式应返回命中片段原文");
  assert.equal(fb.fallback, "keyword");

  // ③ isModelInsufficient 的判定边界（纯函数，逐条可读）
  assert.equal(qa1.isModelInsufficient("资料不足"), true);
  assert.equal(qa1.isModelInsufficient("现有资料不足以回答该问题"), true);
  assert.equal(qa1.isModelInsufficient("文中未提及相关内容"), true);
  assert.equal(qa1.isModelInsufficient("整数加减法是四则运算的基础"), false);
  assert.equal(qa1.isModelInsufficient("这两个概念足够区分"), false, "「足够」不等于「不足」");
});
