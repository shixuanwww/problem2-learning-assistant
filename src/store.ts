// ============================================================================
// src/store.ts — §4.8 + §4.14 持久化
//   落盘：state.json（{state, kindState}）、answers.json、history.json
//   辅助：原子写（写 .tmp 再 rename，避免演示中途 Ctrl+C 留下半截文件）、JSON 读
//   graph.json 的序列化/载入放在 network.ts（涉及 pid 映射），这里只提供原子写/读。
//
// ⚠️ 落盘一律走 §3 的 stateToJSON / stateFromJSON，不要直接 stringify Map。
// ============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AnswerRecord,
  type HistoryEntry,
  type KindState,
  type State,
  stateFromJSON,
  stateToJSON,
} from "./types.ts";

/** 原子写：写 <file>.tmp 再 rename 覆盖。确保中途退出不留半截文件。 */
export function atomicWrite(file: string, data: unknown): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

/** 读 JSON；文件缺失/解析失败返回 null。 */
export function readJSON(file: string): unknown | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------- state.json：{ state, kindState } ----------
export interface PersistedState {
  state: State;
  kindState: KindState;
}

export function loadState(file: string): PersistedState {
  const raw = readJSON(file);
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const s = (o.state as Record<string, number> | null) ?? {};
    const k = (o.kindState as Record<string, number> | null) ?? {};
    return { state: stateFromJSON(s as Record<string, number> | null), kindState: stateFromJSON(k as Record<string, number> | null) };
  }
  return { state: new Map<string, number>(), kindState: new Map<string, number>() };
}

export function saveState(file: string, state: State, kindState: KindState): void {
  atomicWrite(file, { state: stateToJSON(state), kindState: stateToJSON(kindState) });
}

// ---------- answers.json：AnswerRecord[] ----------
export function loadAnswers(file: string): AnswerRecord[] {
  const raw = readJSON(file);
  if (raw && Array.isArray(raw)) return raw as AnswerRecord[];
  return [];
}
export function saveAnswers(file: string, answers: AnswerRecord[]): void {
  atomicWrite(file, answers);
}

// ---------- history.json：HistoryEntry[] ----------
export function loadHistory(file: string): HistoryEntry[] {
  const raw = readJSON(file);
  if (raw && Array.isArray(raw)) return raw as HistoryEntry[];
  return [];
}
export function saveHistory(file: string, history: HistoryEntry[]): void {
  atomicWrite(file, history);
}
