// ============================================================================
// src/analyze/analyze.ts — §4.9 + §4.11 的「资料/真题 → 结构化分析结果」流水线
//
//   路 A（需 Key）：md 切分（>3000 字按标题/段落）→ 逐块调模型抽取
//                     → schema 校验（§4.9，失败重试一次，再失败抛错跳过）→ 合并取并集
//   路 B（离线）：md 里显式写了 ## 知识点: / ## 前置: 声明 → 直接切出，跳过模型。
//
//   对外暴露：analyzeResource / analyzeProblem，供 SimNet.analyzeRes/analyzePro 委托。
// ============================================================================
import type { AnalyzeProReq, AnalyzeResReq, Edge, Point, Problem, Resource } from "../types.ts";
import { UNCLASSIFIED_KIND } from "../types.ts";
import { readJSON } from "../store.ts";
import { chat, hasChatKey } from "./llm.ts";
import { validateProOutput, validateResOutput } from "./schema.ts";
import { materialToChunks, parseMaterialRelations, readText } from "./parse.ts";
import path from "node:path";

const EXTRACT_SYS =
  "你是课程知识抽取器。输入是一段课程资料片段，请抽取其中的知识点，以及知识点之间的前置关系。\n" +
  "要求：\n" +
  "1. 知识点是最小可掌握的知识单元，命名要具体（如「整数加减法」）。\n" +
  "2. 前置关系 from->to 表示「学 to 前要先学 from」，只抽片段中明确或强可推断的前置关系。\n" +
  "3. 只返回 JSON，格式：{\"points\":[{\"name\":\"...\"}],\"edges\":[[{\"name\":\"from\"},{\"name\":\"to\"}]]}\n" +
  "4. 不要添加资料里没有的内容；没把握就不写。";

function safeParseJSON(s: string): unknown {
  const t = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const [a, b] of edges) {
    const k = `${a.name}\u0000${b.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([{ name: a.name }, { name: b.name }]);
  }
  return out;
}

async function modelExtractRes(text: string, resource: Resource): Promise<{ points: Point[]; edges: Edge[] }> {
  const chunks = materialToChunks(resource, text);
  const pointMap = new Map<string, Point>();
  const edgeList: Edge[] = [];

  for (const c of chunks) {
    const user = `资料片段：\n${c.text}\n\n请抽取知识点与前置关系，仅返回 JSON。`;
    const mk = () =>
      chat(
        [
          { role: "system", content: EXTRACT_SYS },
          { role: "user", content: user },
        ],
        { json: true },
      );

    let parsed = safeParseJSON(await mk());
    let v = validateResOutput(parsed);
    if (!v.ok) {
      // 校验失败重试一次
      parsed = safeParseJSON(await mk());
      v = validateResOutput(parsed);
      if (!v.ok) {
        throw new Error(`资料「${resource}」知识点抽取 schema 校验失败：${v.errors.join("；")}`);
      }
    }
    for (const p of v.points) if (p.name) pointMap.set(p.name, { name: p.name });
    for (const e of v.edges) edgeList.push(e);
  }

  return { points: [...pointMap.values()], edges: dedupeEdges(edgeList) };
}

/**
 * 兜底：读 `data/presets/analyze-req.json` 里该文件的预置结果。
 * 触发条件 = md 里没写 `## 知识点:` / `## 前置:` 声明，且模型又不可用/抽不出点。
 * （PLAN §4.11 明确 presets **只作兜底**，不参与正常路径。）
 */
export function loadPreset(dataDir: string, resource: Resource): AnalyzeResReq | null {
  const raw = readJSON(path.join(dataDir, "presets", "analyze-req.json"));
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { resources?: unknown }).resources;
  if (!Array.isArray(list)) return null;
  const hit = list.find(
    (x): x is { resource: string; points: Point[]; edges: Edge[] } =>
      !!x && typeof x === "object" && (x as { resource?: unknown }).resource === resource,
  );
  if (!hit) return null;
  return {
    resource,
    points: (hit.points ?? []).map((p) => ({ name: p.name })),
    edges: (hit.edges ?? []).map(([a, b]) => [{ name: a.name }, { name: b.name }] as Edge),
  };
}

/**
 * 抽取来源（供调用方在日志/响应里明示"到底是谁抽的"）。
 *   model  = 路 A 真调模型成功
 *   rule   = 从 md 里 `## 知识点:` / `## 前置:` 声明切出
 *   preset = `presets/analyze-req.json` 预置兜底
 */
export type ExtractSource = "model" | "rule" | "preset";

/** 带来源标注的抽取结果（`analyzeResourceDetailed` 的返回）。 */
export interface AnalyzeResDetailed {
  req: AnalyzeResReq;
  by: ExtractSource;
  /** by !== "model" 时说明上一级为什么没成功（诊断用，可空）。 */
  note?: string;
}

/**
 * 分析一份资料 → 抽取结果 + **来源标注**。四级路径，逐级回退：
 *   ① 路 A（需要模型）→ 逐块抽取 + schema 校验；
 *   ② 路 B（md 里有显式声明）→ 直接切出，**离线可用**；
 *   ③ 兜底 presets（`<输入目录>/presets/analyze-req.json`）→ 前两级都拿不到时才用；
 *   ④ 仍拿不到 ⇒ 抛错（调用方决定是跳过该文件还是用规则解析）。
 *
 * ⚠️ 顺序由 `opts.preferModel` 决定（2026-10-11 加）：
 *   - 默认（false）② → ① → ③：**规则优先**，声明过的资料不花模型 Token（启动接入 / demo 用）；
 *   - true：① → ② → ③：**模型优先**。这是网页壳「上传资料」该走的顺序 ——
 *     真从 PPT / 教材转出来的 md 不会有声明，必须让模型抽；
 *     模型不可用或抽不出来时，再回落到声明与预设。
 *
 * 🔴 为什么要返回 `by`：调用方（网页壳）只看"有没有 points"是**分不清**来源的 ——
 *   模型挂了会静默回落到声明，点数为 0 才轮到 presets 之外的情况。不标注来源，
 *   日志就会把"规则解析的结果"写成"模型抽取成功"（这是审计里实测抓到的假日志）。
 */
export async function analyzeResourceDetailed(
  resource: Resource,
  opts: { dataDir: string; forceModel?: boolean; preferModel?: boolean },
): Promise<AnalyzeResDetailed> {
  const text = readText(resource);
  if (!text) throw new Error(`读取资料失败：${resource}`);

  const rel = parseMaterialRelations(text);
  const hasDecl = rel.points.length > 0 || rel.edges.length > 0;
  const useModelFirst = Boolean(opts.preferModel) && hasChatKey();
  const rule = (note?: string): AnalyzeResDetailed => ({
    req: {
      resource,
      points: rel.points.map((n) => ({ name: n })),
      edges: rel.edges.map(([a, b]) => [{ name: a }, { name: b }]) as Edge[],
    },
    by: "rule",
    note,
  });

  // ① 规则优先时（或模型优先但本机没有 Key）先把声明路径短路掉
  if (!opts.forceModel && hasDecl && !useModelFirst) return rule();

  // ② 路 A：需模型
  let modelError = "";
  try {
    const { points, edges } = await modelExtractRes(text, resource);
    if (points.length > 0) return { req: { resource, points, edges }, by: "model" };
    modelError = "模型未能抽出任何知识点";
  } catch (e) {
    modelError = String(e);
  }

  // ③ 模型没拿到（或没走模型）⇒ 声明依然可用就先用声明，别急着丢给 presets
  if (!opts.forceModel && hasDecl) return rule(modelError);

  // ④ 兜底：presets（避免"模型抽不出点 + 又没声明"就整份资料进不去体系）
  const preset = loadPreset(opts.dataDir, resource);
  if (preset) {
    console.warn(`[analyze] ${resource} 未走模型（${modelError.slice(0, 80)}）⇒ 回落 presets 兜底`);
    return { req: preset, by: "preset", note: modelError };
  }
  throw new Error(`资料「${resource}」既无 md 关系声明、模型又不可用（${modelError}），且 presets 里无兜底`);
}

/**
 * 分析一份资料 → AnalyzeResReq（只要结果、不要来源标注时的薄封装）。
 * 与 `analyzeResourceDetailed` 同一套逻辑，不会出现两份实现。
 */
export async function analyzeResource(
  resource: Resource,
  opts: { dataDir: string; forceModel?: boolean; preferModel?: boolean },
): Promise<AnalyzeResReq> {
  return (await analyzeResourceDetailed(resource, opts)).req;
}

/** 带来源标注的真题抽取结果。 */
export interface AnalyzeProDetailed {
  req: AnalyzeProReq;
  by: ExtractSource;
  note?: string;
}

/** 让模型判断一道真题需要哪些知识点（schema 校验 + 失败重试一次）。 */
async function modelExtractProblemPoints(problem: Problem): Promise<Point[]> {
  const user = `题目：「${problem.name}」\n题干：${problem.content}\n\n请判断解出这道题需要哪些知识点，仅返回 JSON。`;
  const sys =
    "你是课程知识抽取器。输入是一道真题，请判断解出该题需要掌握哪些知识点。" +
    '只返回 JSON：{"points":[{"name":"..."}]}。不要给资料里没有的知识点。';
  let parsed = safeParseJSON(await chat([{ role: "system", content: sys }, { role: "user", content: user }], { json: true }));
  let v = validateProOutput(parsed);
  if (!v.ok) {
    parsed = safeParseJSON(await chat([{ role: "system", content: sys }, { role: "user", content: user }], { json: true }));
    v = validateProOutput(parsed);
    if (!v.ok) throw new Error(`真题「${problem.name}」知识点抽取 schema 校验失败：${v.errors.join("；")}`);
  }
  return v.points;
}

/**
 * 分析一道真题 → AnalyzeProReq **+ 来源标注**（与 `analyzeResourceDetailed` 同一口径）。
 *  - 题干里已经声明了 `## 涉及知识点:` ⇒ 直接用（规则路径，不花 Token）；
 *  - `opts.preferModel`：**先让模型判断**（网页壳上传真题走这条），失败再回落到声明；
 *  - 都没拿到点 ⇒ 抛错（调用方决定跳过还是记 0 点）。
 *
 * 🔴 为什么要 `by`：调用方无法从"problem.points 非空"反推来源 ——
 *   那可能是模型抽的，也可能是它自己带的声明，也正是"假 model 日志"的成因。
 */
export async function analyzeProblemDetailed(
  problem: Problem,
  opts: { preferModel?: boolean } = {},
): Promise<AnalyzeProDetailed> {
  const withKind = (points: Point[]): AnalyzeProReq => ({
    problem: { ...problem, kind: problem.kind ?? UNCLASSIFIED_KIND },
    points,
  });
  const declared = (note?: string): AnalyzeProDetailed => ({
    req: { problem, points: problem.points },
    by: "rule",
    note,
  });

  if (opts.preferModel && hasChatKey()) {
    try {
      const points = await modelExtractProblemPoints(problem);
      if (points.length > 0) return { req: withKind(points), by: "model" };
      if (problem.points.length > 0) return declared("模型未抽出任何知识点");
    } catch (e) {
      if (problem.points.length > 0) return declared(String(e));
      throw e;
    }
  }
  if (problem.points.length > 0) return declared();
  return { req: withKind(await modelExtractProblemPoints(problem)), by: "model" };
}

/** 只要结果、不要来源标注时的薄封装（与 Detailed 版本同一套逻辑）。 */
export async function analyzeProblem(
  problem: Problem,
  opts: { preferModel?: boolean } = {},
): Promise<AnalyzeProReq> {
  return (await analyzeProblemDetailed(problem, opts)).req;
}
