// ============================================================================
// src/paths.ts — 输入目录 / 运行产物目录的统一解析（demo 与网页壳共用）。
//
//   输入（只读）：data/materials、data/problems、data/aliases.json、data/presets
//   产物（可写）：data/.runtime/（graph / state / answers / history / decisions）
// 环境变量：T2_DATA_DIR（默认 "data"）、T2_RUNTIME_DIR（默认 "<DATA>/.runtime"）
// ============================================================================
import path from "node:path";

export const DATA = process.env.T2_DATA_DIR ?? "data";
export const RUNTIME = process.env.T2_RUNTIME_DIR ?? path.join(DATA, ".runtime");

/**
 * 落盘产物文件名（与 network.ts / store.ts / ingest-ledger.ts 的写盘位置一一对应）。
 * `ingested.json` 是"启动接入记账"（内容 hash → 已接入），不在 RUNTIME_FILES 之外另开目录。
 */
export const RUNTIME_FILES = [
  "graph.json",
  "state.json",
  "answers.json",
  "history.json",
  "decisions.json",
  "ingested.json",
];
