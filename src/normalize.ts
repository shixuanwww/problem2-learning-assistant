// ============================================================================
// src/normalize.ts — §4.5 名称归一化 + 别名表
//
// normalize() 是纯字符串函数，只做：trim → 全角转半角 → 去空白与常见连接符 → 英文小写。
// 🔴 不碰括号（"整数加减(一)" 与 "整数加减(二)"若自动去括号会静默并成一个点）。
//    括号形式的等价关系只允许通过 data/aliases.json 显式声明。
// ============================================================================
import { existsSync, readFileSync } from "node:fs";

/** 别名表：{ "别名": "标准名" }。键是资料里出现的原字符串，值是标准名。 */
export type AliasTable = Record<string, string>;

/** 全角 → 半角（U+FF01..FF5E → U+0021..007E；全角空格 U+3000 → 半角空格） */
function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

/**
 * 名称归一化：纯字符串函数，只做以下四步，不碰括号。
 *   1) trim
 *   2) 全角转半角
 *   3) 去空白与常见连接符（- / _ / ·）
 *   4) 英文小写
 */
export function normalize(name: string): string {
  let s = toHalfWidth(name);
  s = s.trim();
  s = s.replace(/[\s\-_·]+/g, "");
  s = s.toLowerCase();
  return s;
}

/** 从磁盘读别名表；失败时返回空表。 */
export function loadAliases(file: string): AliasTable {
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AliasTable;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 别名表 + 归一化：先过别名表（精确匹配原名字符串），再归一化。
 * 这是"入图前合并"的判定标准名。
 */
export function canonicalize(name: string, aliases: AliasTable): string {
  const aliasTo = aliases[name];
  const base = aliasTo ?? name;
  return normalize(base);
}
