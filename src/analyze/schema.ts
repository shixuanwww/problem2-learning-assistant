// ============================================================================
// src/analyze/schema.ts — §4.9 手写 JSON Schema 校验（不引入 ajv，零依赖）
//   校验 AI 输出：
//     - analyzeRes 输出 { points: [{name}], edges: [[{name},{name}]] }
//     - analyzePro 输出 { points: [{name}] }
//   校验失败 → 调用方重试一次，再失败报错并跳过该文件（不写脏数据）。
// ============================================================================
import type { Edge, Point } from "../types.ts";

/** 校验一个非空字符串（trim 后非空）。 */
function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

/** 校验一个 point：{ name: string }。 */
function isValidPoint(x: unknown): x is Point {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return isNonEmptyString(p.name);
}

/** 校验 AnalyzeResReq 的 AI 输出（不含 resource；resource 由调用方回填）。 */
export function validateResOutput(
  data: unknown,
): { ok: boolean; points: Point[]; edges: Edge[]; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    return { ok: false, points: [], edges: [], errors: ["输出不是对象"] };
  }
  const d = data as Record<string, unknown>;
  const points: Point[] = [];
  if (Array.isArray(d.points)) {
    d.points.forEach((p, i) => {
      if (isValidPoint(p)) points.push({ name: p.name });
      else errors.push(`points[${i}] 非法`);
    });
  } else {
    errors.push("缺少 points 数组");
  }

  const edges: Edge[] = [];
  if (Array.isArray(d.edges)) {
    d.edges.forEach((e, i) => {
      if (Array.isArray(e) && e.length === 2 && isValidPoint(e[0]) && isValidPoint(e[1])) {
        edges.push([{ name: e[0].name }, { name: e[1].name }]);
      } else {
        errors.push(`edges[${i}] 非法（应为 [point, point]）`);
      }
    });
  } else {
    errors.push("缺少 edges 数组");
  }

  return { ok: errors.length === 0, points, edges, errors };
}

/** 校验 AnalyzeProReq 的 AI 输出：{ points: [{name}] }。 */
export function validateProOutput(
  data: unknown,
): { ok: boolean; points: Point[]; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    return { ok: false, points: [], errors: ["输出不是对象"] };
  }
  const d = data as Record<string, unknown>;
  const points: Point[] = [];
  if (Array.isArray(d.points)) {
    d.points.forEach((p, i) => {
      if (isValidPoint(p)) points.push({ name: p.name });
      else errors.push(`points[${i}] 非法`);
    });
  } else {
    errors.push("缺少 points 数组");
  }
  return { ok: errors.length === 0, points, errors };
}
