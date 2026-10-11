// ============================================================================
// src/analyze/parse.ts — §4.11 md 解析 + 切分 + 真题解析
//
// 两条路径：
//   路 A（full-demo）→ parse.ts 解出 { name, content, kind, points:[] }（points 留空）
//                    再用 analyzePro 补 points。
//   路 B（l1-demo，离线）→ md 里显式写关系声明，parse.ts 直接切出，跳过模型调用：
//       资料：## 知识点: a,b   /  ## 前置: a -> b（每行一条）
//       真题：## 涉及知识点: a,b
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Resource } from "../types.ts";
import { UNCLASSIFIED_KIND } from "../types.ts";

/** 被检索引用的"带出处"片段（对应 §3 Citation 的前置形态）。 */
export interface SourceChunk {
  resource: Resource;
  locator: string; // 标题路径，如 "§2.1 整数加减"
  text: string;
}

/** 按标题（# 1-3 级）切分 md，返回带标题路径的章节。 */
export function splitChapters(md: string): Array<{ locator: string; text: string }> {
  const lines = md.split(/\r?\n/);
  const chapters: Array<{ locator: string; text: string }> = [];
  const stack: Array<{ level: number; text: string }> = [];
  let current: { locator: string; buf: string[] } | null = null;

  const flush = () => {
    if (current) {
      chapters.push({ locator: current.locator.length ? current.locator : "(整体)", text: current.buf.join("\n").trim() });
      current = null;
    }
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
      current = { locator: stack.map((s) => s.text).join(" / "), buf: [] };
    } else {
      if (!current) current = { locator: "(整体)", buf: [] };
      current.buf.push(line);
    }
  }
  flush();
  return chapters.filter((c) => c.text.length > 0);
}

/** 超长块再按段落/句子切（> chunkSize 字）。 */
export function chunkText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    if (buf.length + para.length > chunkSize && buf.length > 0) {
      out.push(buf);
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + para;
    if (buf.length >= chunkSize) {
      // 若有残余较长的段落再按句子切，避免一个 chunk 无限长
      while (buf.length > chunkSize) {
        let cut = buf.lastIndexOf("。", chunkSize);
        if (cut <= 0) cut = chunkSize;
        out.push(buf.slice(0, cut + 1));
        buf = buf.slice(cut + 1);
      }
    }
  }
  if (buf) out.push(buf);
  return out.filter((s) => s.trim().length > 0);
}

/** 把一份资料 md 转成可检索片段（带标题路径 locator）。 */
export function materialToChunks(resource: Resource, md: string, chunkSize = 3000): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  for (const chapter of splitChapters(md)) {
    const pieces = chunkText(chapter.text, chunkSize);
    pieces.forEach((text, i) => {
      const locator = pieces.length > 1 ? `${chapter.locator}（${i + 1}/${pieces.length}）` : chapter.locator;
      chunks.push({ resource, locator, text });
    });
  }
  return chunks;
}

function splitList(value: string): string[] {
  return value
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 路 B：从资料 md 读关系声明（知识点 + 前置边）。 */
export function parseMaterialRelations(content: string): { points: string[]; edges: Array<[string, string]> } {
  const points: string[] = [];
  const edges: Array<[string, string]> = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = /^##\s*(.+?)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2].trim();
    if (label === "知识点") {
      for (const p of splitList(value)) if (p) points.push(p);
    } else if (label === "前置" || label === "前置关系") {
      const parts = value.split(/\s*->\s*/);
      if (parts.length === 2 && parts[0] && parts[1]) edges.push([parts[0].trim(), parts[1].trim()]);
    }
  }
  return { points, edges };
}

/** 路 B：从真题 md 读关系声明（涉及知识点 + 正文）。 */
export function parseProblemRelations(
  content: string,
): { name: string; content: string; kind: string; points: string[] } {
  const lines = content.split(/\r?\n/);
  let name = "";
  let kind = "";
  const points: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // 标题行（题名）
    if (!name && /^#\s+/.test(line)) {
      name = line.replace(/^#\s+/, "").trim();
      continue;
    }
    // 声明头
    const m2 = /^##\s*题型\s*[:：]\s*(.+)$/.exec(trimmed);
    if (m2) {
      kind = m2[1].trim();
      continue;
    }
    const m3 = /^##\s*(涉及到?知识点|知识点)\s*[:：]\s*(.+)$/.exec(trimmed);
    if (m3) {
      for (const q of splitList(m3[2])) points.push(q);
      continue;
    }
    // 其余非声明头、非标题的行（含结构标题的正文文本）都算题干
    if (trimmed.length === 0) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      // 非声明头的子标题也作为题干的一部分
      body.push(line);
      continue;
    }
    body.push(line);
  }
  return { name: name || "未命名题", content: body.join("\n").trim(), kind: kind || UNCLASSIFIED_KIND, points };
}

/** 递归收集指定目录下的 md 文件（相对资源路径）。 */
export function collectMdFiles(dir: string): Resource[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (e.endsWith(".md")) out.push(full.replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out;
}

/** 读文件文本；失败返回 ""。 */
export function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
