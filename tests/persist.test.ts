// ============================================================================
// tests/persist.test.ts — 用例 11、20：持久化（跨进程 + graph.json 重载）
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { SimNet } from "../src/network.ts";
import { makeNetWithProblems, makeTempDir, spawnBlockedReason } from "./helpers.ts";

test("用例11：另起一个进程跑 demo/verify-persist.ts → 学习状态仍在（跨进程持久化）", (t) => {
  const dir = makeTempDir();
  const net = makeNetWithProblems(dir);
  // 记录一条作答，让 state.json 有内容
  const problem = net.problemByName("2023 期末 第1题")!;
  net.record({ kind: "Do", problem, status: "incorrect" });

  let out: string;
  try {
    out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "demo/verify-persist.ts"],
      {
        // 🔴 stdio 必须**显式**给：受限环境（本机沙箱即如此）下"不传 stdio"会让 spawn 直接 EBUSY，
        //    显式写 ["ignore","pipe","pipe"] 反而正常，且仍能拿到 stdout 做断言。
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, T2_RUNTIME_DIR: dir },
        encoding: "utf8",
      },
    );
  } catch (e) {
    const why = spawnBlockedReason(e);
    if (why) {
      t.skip(`${why} ⇒ 跨进程持久化在本机无法验证（环境限制，非代码缺陷）`);
      return;
    }
    throw e; // 起来了却失败 = 真回归，必须照抛
  }
  assert.ok(out.includes("PASS"), `verify-persist 应 PASS：\n${out}`);
  assert.ok(out.includes("0.25"), "应跨进程读到掌握度 0.25");
});

test("用例20：重启后载入 graph.json → 知识点数/前置边/考频与重启前完全一致", () => {
  const dir = makeTempDir();
  const net = makeNetWithProblems(dir);
  const alive = net.graph.filter((n) => !n.dead).length;
  const mention = JSON.stringify(net.pointMention);
  const names = net.problems.map((p) => p.name).sort();
  const edges = JSON.stringify(net.graph.map((g) => g.prev.map((q) => q.name).sort()));

  // 模拟"重启"：新建实例从磁盘载入
  const net2 = new SimNet({ dataDir: dir });
  assert.equal(net2.graph.filter((n) => !n.dead).length, alive, "知识点数一致");
  assert.equal(JSON.stringify(net2.pointMention), mention, "考频一致");
  assert.deepEqual(net2.problems.map((p) => p.name).sort(), names, "真题一致");
  assert.equal(JSON.stringify(net2.graph.map((g) => g.prev.map((q) => q.name).sort())), edges, "前置边一致");

  // 载入后体系仍可用
  const q = net2.queryPoint({ name: "整数加减" });
  assert.ok(q.problems.length > 0);
});
