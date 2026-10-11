// ============================================================================
// demo/full-demo.ts — 完整版演示：第 1 步真调模型做抽取，第 3 步真模型问答。
//
//   需要 Key（走环境变量或仓库根的 .env，由 src/analyze/llm.ts 自己加载）。
//   无 Key 时自动降级（§9.3），**不会崩**：
//     - 无 embedding Key → 问答检索退化为关键词
//     - 无 chat Key      → 第 1 步回落 §4.11 路 B（md 声明）+ 问答退化为抽取式
//
//   🔁 幂等（2026-10-11 修复）：输入读 data/，产物写 data/.runtime/ 且启动前清空。
//
//   运行：node --experimental-strip-types demo/full-demo.ts
//   ⇒ ⚠️ 不要再写 `node --env-file=.env …`：.env 不存在时 Node 会**直接退出**
//      （`Error: .env: not found`），那就谈不上"无 Key 优雅降级"了。
// ============================================================================
import { execFileSync } from "node:child_process";
import path from "node:path";
import { SimNet } from "../src/network.ts";
import { wireActions, proposePlan } from "../src/plan.ts";
import { loadAliases } from "../src/normalize.ts";
import { collectMdFiles, parseMaterialRelations, parseProblemRelations, readText } from "../src/analyze/parse.ts";
import { analyzeResource } from "../src/analyze/analyze.ts";
import { QaEngine } from "../src/qa.ts";
import { hasChatKey, hasEmbedKey } from "../src/analyze/llm.ts";
import { DATA, RUNTIME, resetRuntime } from "./runtime.ts";
import type { AnalyzeResReq, Edge, Problem } from "../src/types.ts";
import { UNCLASSIFIED_KIND } from "../src/types.ts";

function line(t: string) {
  console.log(`\n${"=".repeat(64)}\n## ${t}\n${"=".repeat(64)}`);
}
function fmtPlan(net: SimNet, plan = net.makePlan()): string {
  return plan
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
function problemFromFile(file: string): Problem {
  const p = parseProblemRelations(readText(file));
  return { name: p.name, content: p.content, kind: p.kind, points: p.points.map((n) => ({ name: n })) };
}

async function main() {
  resetRuntime();
  console.log(`chat Key 配置：${hasChatKey() ? "有" : "无（问答降级为抽取式）"}`);
  console.log(`embed Key 配置：${hasEmbedKey() ? "有" : "无（检索降级为关键词）"}`);
  console.log(`输入目录：${DATA}/（只读）｜产物目录：${RUNTIME}/（本次已清空）`);

  const materials = collectMdFiles(`${DATA}/materials`).sort();
  const problemFiles = collectMdFiles(`${DATA}/problems`).sort().filter((f) => f.endsWith(".prob.md"));

  const net = new SimNet({
    dataDir: RUNTIME,
    aliases: loadAliases(path.join(DATA, "aliases.json")),
    skipLoad: true,
  });
  wireActions(net);

  // ---------- 第 1 步：上传资料，后台处理（真调模型；失败回落路B） ----------
  line("第 1 步：上传资料并由后台处理（路A 真调模型抽取；失败则回落路B）");
  for (const m of materials) {
    let req: AnalyzeResReq;
    try {
      req = await analyzeResource(m, { dataDir: DATA, forceModel: true });
      console.log(`  ✓ ${m} → 模型抽取 ${req.points.length} 个知识点`);
    } catch (e) {
      console.log(`  ⚠ ${m} 模型抽取失败（${String(e).slice(0, 80)}），回落路B（md 声明）`);
      const rel = parseMaterialRelations(readText(m));
      req = {
        resource: m,
        points: rel.points.map((n) => ({ name: n })),
        edges: rel.edges.map(([a, b]) => [{ name: a }, { name: b }] as Edge),
      };
    }
    net.integrate({ kind: "ResReq", data: req });
  }
  console.log(`  当前知识点（${net.alivePoints().length} 个）：${net.alivePoints().map((n) => n.name).join("、")}`);

  // ---------- 第 2 步：构建并更新知识体系、学习计划 ----------
  line("第 2 步：根据多份资料构建并继续更新知识体系、学习计划");
  for (const pf of problemFiles) {
    const prob = problemFromFile(pf);
    net.integrate({ kind: "ProReq", data: { problem: prob, points: prob.points } });
  }
  console.log(`  接入 ${problemFiles.length} 道真题；考频前三：${net.pointRank(3).map((p) => p.name).join("、")}`);
  const rings = net.cycles();
  if (rings.length) {
    console.log(
      `  ⚠ 模型逐块抽取产生的前置边存在 ${rings.length} 处环（块内自洽、跨块不自洽）：` +
        rings.map((r) => r.map((p) => p.name).join("→")).join("；"),
    );
    console.log(`     处理策略（§11）：打破环 + 告警，保证每个点恰好进计划一次，不抛异常。`);
  }
  console.log(`  学习计划：\n${fmtPlan(net)}`);

  // ---------- 第 3 步：基于资料问答（带来源 + 资料不足） ----------
  line("第 3 步：基于资料进行带来源的问答");
  const qa = new QaEngine(
    materials.flatMap((m) =>
      readText(m)
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((s) => ({ resource: m, locator: m, text: s })),
    ),
    net,
  );
  const focusName = problemFromFile(problemFiles[0]).points[0]?.name ?? "整数加减";
  const q1 = await qa.ask(`${focusName}法是什么`);
  console.log(`  Q: ${focusName}法是什么`);
  console.log(`    充足=${q1.sufficient}；回答=${(q1.answer ?? "").slice(0, 80)}`);
  console.log(`    出处：${q1.citations.slice(0, 2).map((c) => c.resource).join("；")}`);
  const q2 = await qa.ask("二次根式怎么化简");
  console.log(`  Q: 二次根式怎么化简（资料里没有）`);
  console.log(`    充足=${q2.sufficient}；回答=${q2.answer === null ? "【资料不足，拒绝编造】" : q2.answer}`);

  // ---------- 第 4 步：记录一份真题作答（做错）→ 更新知识点、题型掌握度 ----------
  line("第 4 步：记录一份真题作答情况，据此更新知识点、题型掌握度");
  const prob = problemFromFile(problemFiles[0]);
  const pName = prob.points[0]?.name ?? focusName;
  const pKind = prob.kind ?? UNCLASSIFIED_KIND;
  const pKey = net.keyOf(pName);
  const beforeM = net.state.get(pKey) ?? 0.5;
  const beforeK = net.kindState.get(pKind) ?? 0.5;
  // 真实基线：记录做错**之前**该点的 Do 动作数，供第 5 步做"做错前 → 做错后"的硬对比。
  const countDo = (): number =>
    net.makePlan().find((x) => net.keyOf(x.point.name) === pKey)?.actions.filter((a) => a.kind === "Do").length ?? 0;
  const doBefore = countDo();
  net.record({ kind: "Do", problem: prob, status: "incorrect" });
  const afterM = net.state.get(pKey) ?? 0.5;
  const afterK = net.kindState.get(pKind) ?? 0.5;
  console.log(
    `  作答「${prob.name}」→错误；知识点「${pName}」掌握度 ${beforeM.toFixed(2)}→${afterM.toFixed(2)}；题型「${pKind}」 ${beforeK.toFixed(2)}→${afterK.toFixed(2)}`,
  );
  console.log("  —— 另起一个进程跑 demo/verify-persist.ts ——");
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "demo/verify-persist.ts"], {
      encoding: "utf8",
      env: { ...process.env, T2_DATA_DIR: DATA, T2_RUNTIME_DIR: RUNTIME },
    });
    console.log(out.trim());
  } catch (e) {
    console.error(`  verify-persist 子进程失败：${String(e)}`);
  }

  // ---------- 第 5 步：重新 makePlan → 根据表现调整 ----------
  line("第 5 步：经过多轮学习与做题后，AI 依据学习表现调整之后的行为计划");
  const planAfter = net.makePlan();
  console.log(`  更新后的学习计划：\n${fmtPlan(net, planAfter)}`);
  const doAfter = countDo();
  console.log(`  「${pName}」Do 动作数（做错前 → 做错后）：${doBefore} → ${doAfter}`);
  if (doAfter > doBefore) {
    console.log(`  ✅ 真实断言通过：做错后该点 Do 动作数确实增加（+${doAfter - doBefore}，主题 + 回炉题，§4.7 规则2）`);
  } else {
    console.error(`  ❌ 真实断言失败：做错后该点 Do 动作数未增加（${doBefore} → ${doAfter}）—— 与解说词矛盾，演示终止`);
    process.exit(1);
  }

  // ---------- 补充演示（§4.13）：模型提议被拒 → 回落规则版计划 ----------
  line("补充演示：模型提议被拒 → 回落规则版计划（§4.13 / §8 用例 10·18）");
  const badDraft = [
    { pointName: pName, actions: [{ kind: "Do", problemName: "2024 期末 第9题（不存在的真题）" }] },
    { pointName: "积分中值定理", actions: [{ kind: "Explain" }] },
  ];
  console.log("  模型提议（故意非法：编造真题 + 编造知识点）：");
  console.log(`    ${JSON.stringify(badDraft)}`);
  const res = proposePlan(net, badDraft);
  console.log(`  ⇒ accepted=${res.accepted}`);
  for (const r of res.rejected ?? []) console.log(`     拒绝理由：${r}`);
  console.log(`  ⇒ 拒绝已记入决策日志 ${RUNTIME}/decisions.json（当前 ${net.decisions.length} 条）`);
  console.log(`  ⇒ 回落到 §4.7 规则版计划（仍可用、且满足拓扑序）：\n${fmtPlan(net)}`);

  console.log(`\n✅ full-demo：5 步全部走完${hasChatKey() ? "（真调模型）" : "（离线降级）"}。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
