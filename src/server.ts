// ============================================================================
// src/server.ts — 网页壳（加分项）。原生 node:http + 手写路由表，零依赖。
//
//   与 CLI 演示共用同一套内核（SimNet / QaEngine / plan.ts）：网页只是壳，
//   所有业务逻辑都在 src/ 里，网页和 CLI 调的是同一个对象。
//
//   运行：node --experimental-strip-types src/server.ts
//   端口：PORT（默认 8787）｜绑定 127.0.0.1（本机演示用途）
//
//   路由见 README §7；上传走 JSON（不做 multipart），但落盘 + 自动分析是真的。
// ============================================================================
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SimNet } from "./network.ts";
import { proposePlan, wireActions } from "./plan.ts";
import { QaEngine } from "./qa.ts";
import { loadPreset } from "./analyze/analyze.ts";
import { hasChatKey } from "./analyze/llm.ts";
import {
  collectMdFiles,
  materialToChunks,
  parseMaterialRelations,
  parseProblemRelations,
  readText,
} from "./analyze/parse.ts";
import { DATA, RUNTIME, RUNTIME_FILES } from "./paths.ts";
import {
  UNCLASSIFIED_KIND,
  stateToJSON,
  type AnalyzeResReq,
  type Edge,
  type Point,
  type Problem,
  type ProStatus,
} from "./types.ts";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = "public";

// ---------------------------------------------------------------- 内核装配

const net = new SimNet({
  dataDir: RUNTIME,
  inputDir: DATA, // aliases.json / presets 在输入侧，产物在 RUNTIME 侧
  skipLoad: false, // 有历史产物就载入（重启不丢状态）
});
wireActions(net);

let qa: QaEngine | null = null;

/** 重建检索索引（资料变化后要调）。 */
function rebuildIndex(): void {
  const chunks = collectMdFiles(`${DATA}/materials`).sort().flatMap((m) =>
    materialToChunks(m, readText(m)),
  );
  qa = new QaEngine(chunks, net);
}

function problemFromFile(file: string): Problem {
  const p = parseProblemRelations(readText(file));
  return {
    name: p.name,
    content: p.content,
    kind: p.kind || UNCLASSIFIED_KIND,
    points: p.points.map((n) => ({ name: n })),
  };
}

function materialReq(file: string): AnalyzeResReq {
  const rel = parseMaterialRelations(readText(file));
  return {
    resource: file,
    points: rel.points.map((n) => ({ name: n })),
    edges: rel.edges.map(([a, b]) => [{ name: a }, { name: b }] as Edge),
  };
}

/** 一次抽取的"来源"标注：模型 / 预置兜底 / md 声明。 */
type ExtractedBy = "model" | "preset" | "rule";

/**
 * 从**已落盘**的 md 文件抽取分析结果（上传 / analyze / 启动接入共用）。
 *
 * 🔴 这里就是"模型抽取"接进网页流程的地方（2026-10-11 修）：
 *   以前上传只走 `materialReq()`（纯规则解析 `## 知识点:`），
 *   ⇒ 真实课件转出来的 md（没有声明）上传后**静默得到 0 个知识点**，
 *     L2 的"接模型解析资料"在网页上完全演不出来。
 *
 * 现在按 模型（`net.analyzeResDetailed`）→ md 声明 → presets 逐级回落，
 * **每一步的来源都如实带出来**（`by`）—— 修前只看"有没有 points"会把
 * "模型挂了、回落 md 声明"的结果标成 model，是假日志（审计实测抓到）。
 */
async function extractMaterial(file: string): Promise<{ req: AnalyzeResReq; by: ExtractedBy; note?: string }> {
  let modelErr = "";
  try {
    const d = await net.analyzeResDetailed(file); // 内部首选模型（preferModel: true）
    // ⚠️ 必须看 d.by：模型失败时它会**内部回落到 md 声明**并返回非空 points，
    //    只看"有没有 points"就会把规则解析的结果标成 model（审计实测抓到的假日志）。
    if (d.by === "model" && d.req.points.length > 0) return d;
    if (d.req.points.length > 0 || d.req.edges.length > 0) {
      return { req: d.req, by: d.by, note: d.note ?? "模型未抽出任何知识点" };
    }
    modelErr = d.note ?? "模型未抽出任何知识点";
  } catch (e) {
    modelErr = String(e); // 模型不可用 且 md 也没声明
  }

  const preset = loadPreset(DATA, file);
  if (preset) {
    console.warn(`[server] ${file} 未能走模型 ⇒ 用 presets 预置结果兜底（原因：${shortReason(modelErr)}）`);
    return { req: preset, by: "preset", note: modelErr };
  }
  const rule = materialReq(file);
  return {
    req: rule,
    by: "rule",
    note: rule.points.length > 0
      ? modelErr
      : `${modelErr}；该 md 也没有关系声明，抽出 0 点（建议：转 md 时保留「## 知识点:」声明，或配置 DEEPSEEK_API_KEY 走模型）`,
  };
}

/**
 * 把内部错误压成日志/响应里能看的一小段：
 * 只留第一行 + 压空白 + 截断到 60 字 —— 避免把 HTTP 响应体（可能含 key 提示）整段打出来。
 */
function shortReason(reason: string): string {
  return reason.split("\n")[0].replace(/\s+/g, " ").slice(0, 60);
}

/** 真题同理：优先让模型判断"这题考哪些知识点"，失败才回落 md 里的 `## 涉及知识点:`。 */
async function extractProblem(file: string): Promise<{ problem: Problem; points: Point[]; by: ExtractedBy; note?: string }> {
  const problem = problemFromFile(file);
  try {
    const d = await net.analyzeProDetailed(problem); // 内部首选模型（preferModel: true）
    // 与 extractMaterial 同理：必须看 d.by —— 题目本身带 points 时，
    // "回落声明"也会返回非空 points。修的若是这个判断，日志就会谎报 model。
    if (d.by === "model" && d.req.points.length > 0) {
      return { problem, points: d.req.points, by: "model" };
    }
    if (d.req.points.length > 0) {
      return { problem, points: d.req.points, by: d.by, note: d.note ?? "模型未抽出任何知识点" };
    }
  } catch (e) {
    return { problem, points: problem.points, by: "rule", note: String(e) };
  }
  return { problem, points: problem.points, by: "rule", note: "模型未抽出任何知识点" };
}

/** 接入一份资料：抽取 → integrate。返回抽取来源，便于日志/响应展示。 */
async function ingestMaterial(file: string): Promise<{ by: ExtractedBy; points: number; edges: number; note?: string }> {
  const { req, by, note } = await extractMaterial(file);
  net.integrate({ kind: "ResReq", data: req });
  rebuildIndex();
  return { by, points: req.points.length, edges: req.edges.length, note };
}

/** 接入一道真题：抽取 → integrate。 */
async function ingestProblem(file: string): Promise<{ by: ExtractedBy; points: number; note?: string }> {
  const { problem, points, by, note } = await extractProblem(file);
  net.integrate({ kind: "ProReq", data: { problem, points } });
  return { by, points: points.length, note };
}

/** 把 data/ 下现有的资料 + 真题全部接进体系（首次启动时用；已存在则幂等）。 */
async function bootstrap(): Promise<void> {
  if (!hasChatKey()) {
    console.log("  ⚠ 未配置 DEEPSEEK_API_KEY ⇒ 启动接入走规则路径（md 声明），不调模型");
  }
  for (const m of collectMdFiles(`${DATA}/materials`).sort()) {
    const r = await ingestMaterial(m);
    // ⚠️ 只有真的走了模型才写 model：回落时必须把来源（preset / rule）与原因一起打出来，
    //    否则"配了 Key 但 Key 无效"这种情况会被日志显示成"模型抽取成功"，属于误导性日志。
    console.log(`  接入资料 ${m} ← ${r.by}${describeNote(r.by, r.note)}｜${r.points} 个知识点 / ${r.edges} 条前置边`);
    if (r.points === 0) console.warn(`  ⚠ ${m} 没能抽出任何知识点，请检查该 md 或上传格式`);
  }
  for (const p of collectMdFiles(`${DATA}/problems`).sort().filter((f) => f.endsWith(".prob.md"))) {
    const r = await ingestProblem(p);
    console.log(`  接入真题 ${p} ← ${r.by}${describeNote(r.by, r.note)}｜${r.points} 个知识点`);
  }
}

/** 把"为什么没走模型"的原因压成日志里能看的一小段（模型成功时为空）。 */
function describeNote(by: ExtractedBy, note?: string): string {
  if (by === "model" || !note) return "";
  return `（${note.replace(/\s+/g, " ").slice(0, 80)}）`;
}
// ⚠️ bootstrap 是 async（有 Key 时要逐份调模型）⇒ 不能在这里裸调；
//    移到 server.listen 回调里跑，避免"路由已能响应但体系还没建好"的中间态被看到。

// ---------------------------------------------------------------- HTTP 小工具

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}

function sendFile(res: http.ServerResponse, file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendText(res, 404, "404 Not Found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

async function readBody(req: http.IncomingMessage, limit = 2_000_000): Promise<unknown> {
  const bufs: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`请求体过大（> ${limit} 字节）`);
    bufs.push(chunk as Buffer);
  }
  const raw = Buffer.concat(bufs).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

/** 只允许写入 data/ 下的这两个子目录，文件名做白名单校验（防目录穿越）。 */
function safeTargetName(name: unknown, target: "materials" | "problems"): string {
  const base = String(name ?? "").trim();
  if (!base) throw new Error("缺少文件名");
  if (/[\\/]|\.\./.test(base)) throw new Error(`文件名非法（不允许路径分隔或 ..）：${base}`);
  const suffix = target === "problems" ? ".prob.md" : ".md";
  const finalName = base.endsWith(".md") ? base : base + suffix;
  return finalName.replace(/\.prob\.prob\.md$/, ".prob.md");
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const p = url.pathname;
  try {
    // ---- 静态页 ----
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    if (req.method === "GET" && (p === "/ask" || p === "/ask.html")) return sendFile(res, path.join(PUBLIC_DIR, "ask.html"));
    if (req.method === "GET" && (p === "/learn" || p === "/learn.html")) return sendFile(res, path.join(PUBLIC_DIR, "learn.html"));
    if (req.method === "GET" && /^\/[\w.-]+$/.test(p) && existsSync(path.join(PUBLIC_DIR, p.slice(1)))) {
      return sendFile(res, path.join(PUBLIC_DIR, p.slice(1)));
    }

    // ---- GET /api/graph ----
    if (req.method === "GET" && p === "/api/graph") {
      return sendJSON(res, 200, {
        resources: net.resources,
        points: net.alivePoints().map((pt) => ({
          pid: pt.pid,
          name: pt.name,
          mastery: net.state.get(net.keyOf(pt.name)) ?? null,
          mention: pt.pid === undefined ? 0 : net.pointMention[pt.pid],
          resources: pt.pid === undefined ? [] : net.graph[pt.pid].resources,
          prev: pt.pid === undefined ? [] : net.graph[pt.pid].prev.map((q) => q.name),
        })),
        problems: net.problems.map((x) => ({ name: x.name, kind: x.kind ?? UNCLASSIFIED_KIND })),
        state: stateToJSON(net.state),
        kindState: stateToJSON(net.kindState),
        cycles: net.cycles().map((ring) => ring.map((x) => x.name)),
        warnings: net.getWarnings(),
      });
    }

    // ---- GET /api/point?name=… ----
    if (req.method === "GET" && p === "/api/point") {
      const name = url.searchParams.get("name") ?? "";
      const q = net.queryPoint({ name });
      return sendJSON(res, 200, {
        name,
        key: net.keyOf(name),
        mastery: net.state.get(net.keyOf(name)) ?? null,
        resources: q.resources,
        problems: q.problems.map((x) => ({ name: x.name, kind: x.kind ?? UNCLASSIFIED_KIND })),
        kinds: q.kinds,
      });
    }

    // ---- GET /api/plan ----
    if (req.method === "GET" && p === "/api/plan") {
      return sendJSON(res, 200, {
        plan: net.makePlan().map((it) => ({
          point: it.point.name,
          mastery: net.state.get(net.keyOf(it.point.name)) ?? null,
          actions: it.actions.map((a) =>
            a.kind === "Do" ? { kind: a.kind, problem: a.problem.name } : { kind: a.kind, resource: "resource" in a ? a.resource : undefined },
          ),
        })),
      });
    }

    // ---- GET /api/files ----
    if (req.method === "GET" && p === "/api/files") {
      return sendJSON(res, 200, {
        materials: collectMdFiles(`${DATA}/materials`).sort(),
        problems: collectMdFiles(`${DATA}/problems`).sort().filter((f) => f.endsWith(".prob.md")),
      });
    }

    // ---- POST /api/ask ----
    if (req.method === "POST" && p === "/api/ask") {
      const body = (await readBody(req)) as { question?: string };
      const question = String(body.question ?? "").trim();
      if (!question) return sendJSON(res, 400, { error: "缺少 question" });
      if (!qa) rebuildIndex();
      const result = await qa!.ask(question);
      return sendJSON(res, 200, result);
    }

    // ---- POST /api/record ----
    if (req.method === "POST" && p === "/api/record") {
      const body = (await readBody(req)) as {
        kind?: string;
        problemName?: string;
        status?: ProStatus;
        resource?: string;
        pointName?: string;
      };
      if (body.kind === "Do") {
        const prob = net.problemByName(String(body.problemName ?? ""));
        if (!prob) return sendJSON(res, 400, { error: `真题「${body.problemName}」不在体系中` });
        const status = (body.status ?? "correct") as ProStatus;
        net.record({ kind: "Do", problem: prob, status });
      } else if (body.kind === "Read") {
        net.record({ kind: "Read", resource: String(body.resource ?? "") });
      } else if (body.kind === "Skip") {
        net.record({ kind: "Skip", point: { name: String(body.pointName ?? "") } });
      } else {
        return sendJSON(res, 400, { error: `不支持的 kind：${body.kind}（仅 Do / Read / Skip）` });
      }
      return sendJSON(res, 200, {
        state: stateToJSON(net.state),
        kindState: stateToJSON(net.kindState),
        history: net.history.slice(-10),
      });
    }

    // ---- POST /api/analyze（对 data/ 里已有文件触发 analyze → integrate） ----
    if (req.method === "POST" && p === "/api/analyze") {
      const body = (await readBody(req)) as { file?: string };
      const file = String(body.file ?? "").trim();
      if (!file) return sendJSON(res, 400, { error: "缺少 file" });
      if (file.startsWith(`${DATA}/problems/`)) {
        const r = await ingestProblem(file);
        return sendJSON(res, 200, { ok: true, file, kind: "ProReq", extractedBy: r.by, points: r.points, note: r.note });
      }
      const r = await ingestMaterial(file);
      return sendJSON(res, 200, {
        ok: true, file, kind: "ResReq", extractedBy: r.by, points: r.points, edges: r.edges, note: r.note,
      });
    }

    // ---- POST /api/upload（JSON 真上传：落盘 → 自动分析） ----
    if (req.method === "POST" && p === "/api/upload") {
      const body = (await readBody(req)) as { name?: string; content?: string; target?: string };
      const target = body.target === "problems" ? "problems" : "materials";
      const fileName = safeTargetName(body.name, target);
      const content = String(body.content ?? "");
      if (!content.trim()) return sendJSON(res, 400, { error: "内容为空" });

      const dir = path.join(DATA, target);
      mkdirSync(dir, { recursive: true });
      const full = path.join(dir, fileName);
      writeFileSync(full, content, "utf8");
      const rel = `${DATA}/${target}/${fileName}`.replace(/\\/g, "/");

      // 🔴 这里就是"上传 → 模型解析"的接线点：有 Key 时走 analyzeRes / analyzePro，
      //    失败逐级回落（presets / md 声明），响应里的 extractedBy 说明到底是谁抽的。
      if (target === "problems") {
        const r = await ingestProblem(rel);
        return sendJSON(res, 200, { ok: true, file: rel, kind: "ProReq", extractedBy: r.by, points: r.points, note: r.note });
      }
      const r = await ingestMaterial(rel);
      return sendJSON(res, 200, {
        ok: true, file: rel, kind: "ResReq", extractedBy: r.by, points: r.points, edges: r.edges, note: r.note,
      });
    }

    // ---- POST /api/propose（§4.13 模型提议通道的可视化：故意喂非法草稿看拒绝+回落） ----
    if (req.method === "POST" && p === "/api/propose") {
      const draft = await readBody(req);
      const result = proposePlan(net, draft);
      return sendJSON(res, 200, {
        ...result,
        // 回落：拒绝时调用方用规则版计划（这里直接把回落结果一并返回，便于前端展示"回落可见"）
        fallbackPlan: result.accepted
          ? null
          : net.makePlan().map((it) => ({ point: it.point.name, actions: it.actions.map((a) => a.kind) })),
        decisions: net.decisions.slice(-3),
      });
    }

    sendJSON(res, 404, { error: `未实现的路由：${req.method} ${p}` });
  } catch (e) {
    sendJSON(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AI 学习辅助系统 · 网页壳已启动`);
  console.log(`  地址    ：http://127.0.0.1:${PORT}`);
  console.log(`  输入目录：${DATA}/（只读）｜产物目录：${RUNTIME}/`);
  console.log(`  ChatKey ：${process.env.DEEPSEEK_API_KEY ? "有" : "无（问答降级为抽取式）"}`);
  console.log(`  EmbedKey：${process.env.ZHIPU_API_KEY ? "有" : "无（检索降级为关键词）"}`);
  console.log(`  运行产物文件：${RUNTIME_FILES.join(", ")}`);
  // 逐份接入 data/ 下已有资料与真题（有 Key 时真调模型；失败逐级回落）
  bootstrap()
    .then(() => {
      console.log(
        `  已就绪：知识点 ${net.alivePoints().length} 个｜真题 ${net.problems.length} 道｜检索片段 ${qa?.available ?? 0} 条`,
      );
    })
    .catch((e) => console.error(`bootstrap 失败：${e instanceof Error ? e.message : String(e)}`));
});
