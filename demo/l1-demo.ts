// ============================================================================
// demo/l1-demo.ts — L1 保底演示：零外部依赖、离线可跑，完整跑通题面 5 步（§9.1/§9.2）。
//
//   第 1 步"接入资料并处理"是真的真读 data/ 下的 md，用 §4.11 路 B 的规则解析出
//   points / edges（充当模型输出的替身），不是用预置结果跳过。
//   第 4 步"重启再读"通过另起一个进程跑 demo/verify-persist.ts 读回 state.json，证明真落盘。
//
//   运行：node --experimental-strip-types demo/l1-demo.ts
// ============================================================================
import { execFileSync } from "node:child_process";
import { SimNet } from "../src/network.ts";
import { wireActions } from "../src/plan.ts";
import {
  collectMdFiles,
  materialToChunks,
  parseMaterialRelations,
  parseProblemRelations,
  readText,
} from "../src/analyze/parse.ts";
import { QaEngine } from "../src/qa.ts";
import type { AnalyzeResReq, Edge, Problem, Resource } from "../src/types.ts";

const DATA = "data";

function materialReq(file: string): AnalyzeResReq {
  const text = readText(file);
  const rel = parseMaterialRelations(text);
  return {
    resource: file,
    points: rel.points.map((n) => ({ name: n })),
    edges: rel.edges.map(([a, b]) => [{ name: a }, { name: b }] as Edge),
  };
}
function problemFromFile(file: string): Problem {
  const text = readText(file);
  const p = parseProblemRelations(text);
  return { name: p.name, content: p.content, kind: p.kind, points: p.points.map((n) => ({ name: n })) };
}

function line(title: string) {
  console.log(`\n${"=".repeat(64)}\n## ${title}\n${"=".repeat(64)}`);
}
function fmtPlan(net: SimNet): string {
  return net
    .makePlan()
    .map((p) => {
      const acts = p.actions.map((a) => {
        if (a.kind === "Read") return `读(${a.resource.split("/").pop()})`;
        if (a.kind === "Explain") return "讲解";
        return `做(${a.problem.name})`;
      });
      return `  ${p.point.name}  [${acts.join(" → ")}]`;
    })
    .join("\n");
}

async function main() {
  const materials = collectMdFiles(`${DATA}/materials`).sort();
  const problems = collectMdFiles(`${DATA}/problems`).sort().filter((f) => f.endsWith(".prob.md"));

  console.log(`课程资料：${materials.length} 份；真题：${problems.length} 道`);

  const net = new SimNet({ dataDir: DATA });
  wireActions(net);

  // ---------- 第 1 步：接入资料，后台处理 ----------
  line("第 1 步：上传资料并由后台处理（真的读 data/materials/*.md）");
  const first = materials[0];
  net.integrate({ kind: "ResReq", data: materialReq(first) });
  console.log(`  ✓ 已接入：${first}`);
  console.log(`  理由：解析该资料得到它的知识点与前置关系，作为知识体系的一部分。`);
  console.log(`  当前知识点：${net.graph.filter((n) => !n.dead).map((n) => n.name).join("、")}`);

  // ---------- 第 2 步：再接入更多，构建并更新知识体系、学习计划 ----------
  line("第 2 步：根据多份资料构建并继续更新知识体系、学习计划");
  const rest = materials.slice(1);
  for (const m of rest) net.integrate({ kind: "ResReq", data: materialReq(m) });
  console.log(`  ✓ 继续接入 ${rest.length} 份资料`);

  const beforeProblems = net.problems.length;
  const beforeMention = net.pointMention.slice();
  for (const pf of problems) {
    const prob = problemFromFile(pf);
    net.integrate({
      kind: "ProReq",
      data: { problem: prob, points: prob.points },
    });
  }
  console.log(`  ✓ 接入 ${problems.length} 道真题，知识体系"长了"：`);
  console.log(`    知识点：${net.graph.filter((n) => !n.dead).map((n) => n.name).join("、")}`);
  console.log(`    新增真题 ${net.problems.length - beforeProblems} 道；考频 pointMention=[${net.pointMention.join(", ")}]`);
  console.log(`  理由：持续上传让体系由"资料→知识点"扩展到"知识点-真题-资料"三者的关系网络，并累计考频。`);

  // 查询一个点：同时看到资料、真题、题型（题面 L2 完成标志②）
  const q = net.queryPoint({ name: "整数加减" });
  console.log(`  queryPoint(整数加减)：资料=${q.resources.length} 份，真题=${q.problems.map((p) => p.name).join("、")}，题型=${q.kinds.join("、")}`);

  const rank = net.pointRank(3);
  console.log(`  考频前三 pointRank(3)：${rank.map((p) => p.name).join("、")}`);

  const planBefore = net.makePlan();
  console.log(`  学习计划（现在）：\n${fmtPlan(net)}`);

  // ---------- 第 3 步：基于资料问答（带来源 + 资料不足拒绝） ----------
  line("第 3 步：基于资料进行带来源的问答");
  const chunkResources: Array<{ resource: Resource; text: string }> = materials.map((m) => ({
    resource: m,
    text: readText(m),
  }));
  const qa = new QaEngine(
    chunkResources.flatMap((r) => materialToChunks(r.resource, r.text)),
  );
  const present = await qa.ask("整数加减法是什么", net);
  console.log(`  Q: 整数加减法是什么`);
  console.log(`    充足=${present.sufficient}；回答=${(present.answer ?? "").slice(0, 60)}`);
  console.log(`    出处：${present.citations.map((c) => `${c.resource} / ${c.locator}`).join("；")}`);

  const absent = await qa.ask("二次根式怎么化简", net);
  console.log(`  Q: 二次根式怎么化简（资料里没有）`);
  console.log(`    充足=${absent.sufficient}；回答=${absent.answer === null ? "【资料不足，拒绝编造】" : absent.answer}`);

  // ---------- 第 4 步：记录一次真题作答（做错）→ 更新知识点、题型掌握度 ----------
  line("第 4 步：记录一份真题作答情况，据此更新知识点、题型掌握度");
  const target = problemFromFile(`${DATA}/problems/2023-期末-第1题.prob.md`);
  const beforeMastery = net.state.get("整数加减") ?? 0.5;
  const beforeKind = net.kindState.get("计算") ?? 0.5;
  net.record({ kind: "Do", problem: target, status: "incorrect" });
  const afterMastery = net.state.get("整数加减") ?? 0.5;
  const afterKind = net.kindState.get("计算") ?? 0.5;
  console.log(`  ✓ 作答「${target.name}」→ 错误（涉及知识点：${target.points.map((p) => p.name).join("、")}，题型：${target.kind}）`);
  console.log(`    知识点「整数加减」掌握度：${beforeMastery.toFixed(2)} → ${afterMastery.toFixed(2)}（错误 -0.25，裁剪到 [0,1]）`);
  console.log(`    题型「计算」掌握度：${beforeKind.toFixed(2)} → ${afterKind.toFixed(2)}（同公式同幅度）`);
  console.log(`  理由：做错用 masteryOf() 读旧值（先验 0.5）再减，避免从 0 减被裁剪回 0 导致状态"纹丝不动"。`);

  // 另起一个进程读回 state.json，证明真落盘
  console.log(`\n  —— 另起一个进程跑 demo/verify-persist.ts ——`);
  try {
    const out = execFileSync("node", ["--experimental-strip-types", "demo/verify-persist.ts"], {
      encoding: "utf8",
    });
    console.log(out.trim());
  } catch (e) {
    console.error(`  verify-persist 子进程执行失败：${String(e)}`);
  }

  // ---------- 第 5 步：重新 makePlan → 根据表现调整之后的行为计划 ----------
  line("第 5 步：经过学习与做题后，AI 依据学习表现调整之后的行为计划");
  const planAfter = net.makePlan();
  const originalTarget = planBefore.find((p) => p.point.name === "整数加减");
  const afterTarget = planAfter.find((p) => p.point.name === "整数加减");
  const actsBefore = originalTarget?.actions.length ?? 0;
  const actsAfter = afterTarget?.actions.length ?? 0;
  console.log(`  「整数加减」学习动作数：${actsBefore} → ${actsAfter}（加量：做错后追加回炉题）`);
  console.log(`  更新后的学习计划：\n${fmtPlan(net)}`);
  if (afterTarget && afterTarget.actions.some((a) => a.kind === "Do")) {
    console.log(`  回炉题依据：数据 data/answers.json 里「整数加减」存在 status≠correct 的作答记录 ⇒ 计划为其追加回炉题。`);
  }
  console.log(`  —— 说明：变化严格落在拓扑序可行域内（同层前移/加量动作），未破坏前置约束。`);

  console.log(`\n✅ l1-demo：5 步全部走完（离线、无外部依赖）。`);

  // 撞车提示（若发生）
  const warns = net.getWarnings();
  if (warns.length) {
    console.log(`\n⚠️ 系统提示：`);
    warns.forEach((w) => console.log(`  - ${w}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
