// ============================================================================
// tests/helpers.ts — 测试夹具：构造一个干净的 SimNet（内存图 + 临时 data 目录）
//
// 课程（小学数学，与题面示例一致）：整数加减 → 整数乘除，分数 → 分数加减，小数 → 小数加减。
// 测试用 skipLoad 从空体系开始，dataDir 指向临时目录（写入无害、不污染真实 data/）。
// ============================================================================
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimNet } from "../src/network.ts";
import { wireActions } from "../src/plan.ts";
import type { AliasTable } from "../src/normalize.ts";
import type { AnalyzeProReq, AnalyzeResReq, Edge, Problem } from "../src/types.ts";

export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "t2-test-"));
}

function matReq(resource: string, points: string[], edges: Array<[string, string]>): AnalyzeResReq {
  return {
    resource,
    points: points.map((n) => ({ name: n })),
    edges: edges.map(([a, b]) => [{ name: a }, { name: b }] as Edge),
  };
}
export { matReq };

function proReq(name: string, kind: string, points: string[]): AnalyzeProReq {
  const problem: Problem = {
    name,
    content: `${name} 题干`,
    kind,
    points: points.map((n) => ({ name: n })),
  };
  return { problem, points: problem.points };
}
export { proReq };

/** 一套默认课程（3 份资料 + 5 道真题）。 */
export const FIXTURE_MATERIALS = [
  matReq("data/materials/m01-integers.md", ["整数加减", "整数乘除"], [["整数加减", "整数乘除"]]),
  matReq("data/materials/m02-fractions.md", ["分数", "分数加减"], [["分数", "分数加减"]]),
  matReq("data/materials/m03-decimals.md", ["小数", "小数加减"], [["小数", "小数加减"]]),
];

export const FIXTURE_PROBLEMS = [
  proReq("2023 期末 第1题", "计算", ["整数加减"]),
  proReq("2023 期末 第2题", "计算", ["整数加减"]),
  proReq("2023 期末 第3题", "选择", ["整数乘除"]),
  proReq("2023 期末 第4题", "填空", ["分数"]),
  proReq("2023 期末 第5题", "计算", ["小数加减"]),
];

/** 建一个空的 SimNet（含默认课程，不读磁盘数据）。 */
export function makeNet(dataDir = makeTempDir()): SimNet {
  const net = new SimNet({ dataDir, skipLoad: true });
  wireActions(net);
  for (const m of FIXTURE_MATERIALS) net.integrate({ kind: "ResReq", data: m });
  return net;
}

/** 建一个空网络，并额外接入全部真题（用于考频/查询/计划类用例）。 */
export function makeNetWithProblems(dataDir = makeTempDir()): SimNet {
  const net = makeNet(dataDir);
  for (const p of FIXTURE_PROBLEMS) net.integrate({ kind: "ProReq", data: p });
  return net;
}

/** 校验一个学习计划是否满足拓扑序（from 在 to 前）与"每个存活点恰好一次"。 */
export function planIsValid(net: SimNet, plan: Array<{ point: { name: string; pid?: number }; actions: unknown[] }>): boolean {
  const pos = new Map<string, number>();
  plan.forEach((it, i) => pos.set(net.keyOf(it.point.name), i));
  // 恰好一次
  if (pos.size !== plan.length) return false;
  // 拓扑：from → to ⇒ from 在 to 前
  for (let i = 0; i < plan.length; i++) {
    const pid = plan[i].point.pid;
    if (pid === undefined) continue;
    for (const prv of net.graph[pid].prev) {
      if (prv.pid === undefined) continue;
      const prevPos = pos.get(net.keyOf(prv.name));
      if (prevPos !== undefined && prevPos > i) return false;
    }
  }
  // 每个存活点都被计划覆盖
  const alive = net.graph.filter((n) => !n.dead).map((n) => n.name);
  if (alive.length !== plan.length) return false;
  for (const n of alive) if (!pos.has(net.keyOf(n))) return false;
  return true;
}
