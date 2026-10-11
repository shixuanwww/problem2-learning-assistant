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
import { chat } from "./llm.ts";
import { validateProOutput, validateResOutput } from "./schema.ts";
import { materialToChunks, parseMaterialRelations, parseProblemRelations, readText } from "./parse.ts";

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
 * 分析一份资料 → AnalyzeResReq。
 * 优先路 B（md 声明）；无声明且需要模型时才走路 A；失败时回落到 presets 或抛错。
 */
export async function analyzeResource(
  resource: Resource,
  opts: { dataDir: string; forceModel?: boolean },
): Promise<AnalyzeResReq> {
  const text = readText(resource);
  if (!text) throw new Error(`读取资料失败：${resource}`);

  const rel = parseMaterialRelations(text);
  // 路 B：md 里有显式声明 → 直接切出（离线可用）
  if (!opts.forceModel && (rel.points.length > 0 || rel.edges.length > 0)) {
    return {
      resource,
      points: rel.points.map((n) => ({ name: n })),
      edges: rel.edges.map(([a, b]) => [{ name: a }, { name: b }]) as Edge[],
    };
  }

  // 路 A：需模型
  const { points, edges } = await modelExtractRes(text, resource);
  if (points.length === 0) {
    // 模型没能抽出点 → 免除脏数据：抛错（上层可回落 presets）
    throw new Error(`资料「${resource}」未能抽出任何知识点`);
  }
  return { resource, points, edges };
}

/** 分析一道真题 → AnalyzeProReq。points 为空时用模型补；否则直接带回。 */
export async function analyzeProblem(problem: Problem): Promise<AnalyzeProReq> {
  if (problem.points.length > 0) {
    return { problem, points: problem.points };
  }
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
  return { problem: { ...problem, kind: problem.kind ?? UNCLASSIFIED_KIND }, points: v.points };
}

/** 从一份真题 md 文件内容直接构造 Problem（路 B：直接取声明）。 */
export function problemFromMd(content: string): Problem {
  const p = parseProblemRelations(content);
  return {
    name: p.name,
    content: p.content,
    kind: p.kind || UNCLASSIFIED_KIND,
    points: p.points.map((n) => ({ name: n })),
  };
}
