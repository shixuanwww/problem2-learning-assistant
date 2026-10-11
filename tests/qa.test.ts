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
