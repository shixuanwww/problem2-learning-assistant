// ============================================================================
// demo/runtime.ts — 演示专用「运行时目录」：把**只读输入**与**可写产物**分开。
//
// 为什么需要它（2026-10-11 修复）：
//   早期两个 demo 都 `new SimNet({ dataDir: "data" })`，直接读写同一份真实 data/：
//     - 跑第 2 次时 state 已被扣到 0 ⇒ 输出「掌握度 0.00 → 0.00」，与解说词
//       「做错后掌握度下降」自相矛盾；动作数「4 → 4」而解说词说「加量」；
//     - full-demo（模型抽出 26+ 个知识点）与 l1-demo（路B 6 个）互相污染同一份
//       graph.json，演示结果不可复现。
//   ⇒ 现在：输入仍读 `data/`（materials / problems / aliases / presets，全部是 git 追踪的），
//          产物写 `data/.runtime/`（gitignore），且**每次启动前清空** ⇒ 演示幂等、可重复。
//
// 目录解析口径统一放在 src/paths.ts（网页壳共用同一份）。
// ============================================================================
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA, RUNTIME, RUNTIME_FILES } from "../src/paths.ts";

export { DATA, RUNTIME };

/**
 * 清空上一次演示留下的运行产物，保证「同一个脚本跑第 N 次 == 跑第 1 次」。
 * 只删 RUNTIME 目录下的那 5 个文件；输入目录（data/materials 等）绝不触碰。
 */
export function resetRuntime(): void {
  mkdirSync(RUNTIME, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const p = path.join(RUNTIME, f);
    if (existsSync(p)) rmSync(p);
  }
}
