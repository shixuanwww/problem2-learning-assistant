// ============================================================================
// tests/demo.test.ts — 用例 12：无 Key / 完全离线跑 l1-demo → 5 步全部走完（用例 7/8 仍通过）
//   跑法：node --experimental-strip-types --test tests/*.test.ts
//   注：l1-demo 是离线保底演示；测试用子进程跑真实脚本并断言关键输出。
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeTempDir, spawnBlockedReason } from "./helpers.ts";

test("用例12：无 Key / 完全离线跑 l1-demo，5 步全部走完且用例 7/8 通过", (t) => {
  // 产物写临时目录，避免污染仓库的 data/.runtime
  let out: string;
  try {
    out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "demo/l1-demo.ts"],
      {
        // 🔴 stdio 必须**显式**给（同上：不传 stdio 在受限环境下会 EBUSY）
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, T2_RUNTIME_DIR: makeTempDir() },
      },
    );
  } catch (e) {
    const why = spawnBlockedReason(e);
    if (why) {
      t.skip(`${why} ⇒ 离线演示在本机无法以子进程方式验证（环境限制，非代码缺陷）`);
      return;
    }
    throw e; // 起来了却失败 = 真回归，必须照抛
  }
  assert.ok(out.includes("5 步全部走完"), "应走完 5 步");
  assert.ok(out.includes("充足=true"), "用例7：带出处问答应充足");
  assert.ok(out.includes("资料不足"), "用例8：资料不足应明确提示");
  assert.ok(out.includes("PASS: 持久化生效"), "跨进程持久化应 PASS");
});
