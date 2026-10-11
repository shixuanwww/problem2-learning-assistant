// ============================================================================
// src/analyze/llm.ts — 模型调用（chat / embedding）+ 无 Key 时抛错（由上层降级，§9.3）
//
// ⚠️ 零依赖：不用 dotenv。这里自带一个 ~15 行的手写 .env 加载（PLAN §2.1）：
//    模块加载时若有 `.env` 就解析 KEY=VALUE 并注入 process.env（真实环境变量优先）；
//    无 .env / 无 Key 时 hasXxx() 返回 false，调用会 throw，调用方必须 catch 并降级。
//    Key / Base URL 全部走环境变量，不硬编码。
// ============================================================================
import { existsSync, readFileSync } from "node:fs";

/** 手写 .env 解析（不装 dotenv）：带 BOM 则剥掉；忽略空行/注释；已存在的环境变量不覆盖。 */
function loadDotEnv(): void {
  const file = ".env";
  if (!existsSync(file)) return;
  let raw = readFileSync(file, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM（§2.1：BOM 会让 --env-file 静默失效）
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadDotEnv();

const CHAT_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const CHAT_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const CHAT_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const EMBED_BASE = process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const EMBED_KEY = process.env.ZHIPU_API_KEY ?? "";
const EMBED_MODEL = process.env.ZHIPU_EMBED_MODEL ?? "embedding-3";

export function hasChatKey(): boolean {
  return CHAT_KEY.length > 0;
}
export function hasEmbedKey(): boolean {
  return EMBED_KEY.length > 0;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  json?: boolean; // 要求模型返回 JSON（用于 analyze / 结构化）
  maxTokens?: number;
}

/** 调聊天模型；无 Key 或 HTTP 非 2xx 时抛错。返回纯文本内容。 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!hasChatKey()) throw new Error("未配置 DEEPSEEK_API_KEY（走降级路径）");
  const body: Record<string, unknown> = {
    model: CHAT_MODEL,
    messages,
    stream: false,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const res = await fetch(`${CHAT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHAT_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/** 调向量模型；无 Key 或 HTTP 非 2xx 时抛错。返回向量。 */
export async function embed(text: string): Promise<number[]> {
  if (!hasEmbedKey()) throw new Error("未配置 ZHIPU_API_KEY（检索退化为关键词）");
  const res = await fetch(`${EMBED_BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBED_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`embed HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  return data.data?.[0]?.embedding ?? [];
}
