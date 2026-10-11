// ============================================================================
// tests/server.test.ts — 用例 21/22/23：网页壳的「上传 → 抽取」接线
//                        （2026-10-11 修 P0 后新增）
//
//   为什么单独补这几条：
//     修之前 `/api/upload` 只走 `materialReq()`（纯规则解析 `## 知识点:`），
//     ⇒ 一份"真从课件转出来的、没有关系声明的 md"上传后**静默得到 0 个知识点**，
//       L2「用模型解析资料构建知识体系」在网页上完全演不出来（只有 CLI 演示能演）。
//     修之后：有 Key 走模型；没 Key 逐级回落 presets → md 声明；响应里带 `extractedBy`。
//
//   做法：起**真实 server 子进程**（`T2_DATA_DIR` 指向临时夹具目录、`PORT` 固定 8799）
//         + 真发 HTTP，全部产物落在临时目录，不污染仓库的 data/。
//
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.ts";

/** 固定端口（避开手动演示用的 8787）。 */
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

/** 用临时夹具目录拼一份"评审机上的 data/ 输入目录"。 */
function makeFixtureDataDir(opts: { withPreset: boolean }): string {
  const dataDir = makeTempDir();
  mkdirSync(path.join(dataDir, "materials"), { recursive: true });
  mkdirSync(path.join(dataDir, "problems"), { recursive: true });
  writeFileSync(
    path.join(dataDir, "materials", "m01.md"),
    "# 整数运算\n\n## 知识点: 整数加减, 整数乘除\n## 前置: 整数加减 -> 整数乘除\n\n## 1 整数加减法\n进位与退位。\n",
    "utf8",
  );
  writeFileSync(
    path.join(dataDir, "problems", "p01.prob.md"),
    "# 2023 期末 第1题\n## 题型: 计算\n## 涉及知识点: 整数加减\n23 + 45 = ?\n",
    "utf8",
  );
  if (opts.withPreset) {
    mkdirSync(path.join(dataDir, "presets"), { recursive: true });
    // ⚠️ 键必须 = server 查表时用的**资源名字符串**，而它与 T2_DATA_DIR 的写法同形：
    //    相对 DATA（`data`）⇒ 键是 `data/materials/xxx.md`；
    //    绝对 DATA（本测试用临时目录）⇒ 键是 `<绝对路径>/materials/xxx.md`（反斜杠已换成 `/`）。
    const resource = `${dataDir.replace(/\\/g, "/")}/materials/_test-nodecl.md`;
    writeFileSync(
      path.join(dataDir, "presets", "analyze-req.json"),
      JSON.stringify({
        resources: [
          {
            resource,
            points: [{ name: "几何初步" }, { name: "周长与面积" }],
            edges: [[{ name: "几何初步" }, { name: "周长与面积" }]],
          },
        ],
      }),
      "utf8",
    );
  }
  return dataDir;
}

/** 起 server 子进程，等 listen 日志出现（最多 20s）。 */
async function startServer(dataDir: string, runtimeDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      T2_DATA_DIR: dataDir,
      T2_RUNTIME_DIR: runtimeDir,
      DEEPSEEK_API_KEY: "",
      ZHIPU_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server 启动超时。日志：\n${log}`)), 20_000);
    const onData = (buf: Buffer) => {
      log += buf.toString("utf8");
      if (log.includes("网页壳已启动")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (b: Buffer) => {
      log += b.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server 提前退出（code=${code}）。日志：\n${log}`));
    });
  });
  return child;
}

/** 停 server 并等它真的退出（否则固定端口会被下一个用例撞上）。 */
async function stopServer(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => resolve(), 3000);
  });
}

async function postJSON(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `${pathname} 应返回 200`);
  return (await res.json()) as Record<string, unknown>;
}

test("用例21：上传『没有关系声明的资料』→ 有 presets 预置时走 preset 兜底（修前是静默 0 点）", async () => {
  const dataDir = makeFixtureDataDir({ withPreset: true });
  const runtime = makeTempDir();
  const child = await startServer(dataDir, runtime);
  try {
    const r = await postJSON("/api/upload", {
      name: "_test-nodecl",
      target: "materials",
      // ⚠️ 关键：真从 PPT / 教材转出来的 md 是长这样的 ——
      // 没有 `## 知识点:` / `## 前置:` 关系声明，只有正文
      // （注意别把正文小标题写成 `## 某某: 某某`，那会被规则解析当成声明 —— 这正是夹具第一版踩的坑）
      content: "# 几何初步\n\n这是从课件转出来的正文，没有任何关系声明。\n",
    });
    assert.equal(r.extractedBy, "preset", `应走 presets 兜底，实际 ${String(r.extractedBy)}｜note=${String(r.note)}`);
    assert.ok(Number(r.points) > 0, "preset 兜底必须抽出知识点（修前这里是 0）");
    assert.ok(Number(r.edges) > 0, "preset 兜底应带出前置边");

    // 落盘 + 进体系：新知识点应立刻能在 /api/graph 看到
    const graph = (await (await fetch(`${BASE}/api/graph`)).json()) as {
      points: Array<{ name: string }>;
    };
    assert.ok(graph.points.some((p) => p.name === "几何初步"), "上传后知识点应进入体系");
    assert.ok(existsSync(path.join(dataDir, "materials", "_test-nodecl.md")), "上传内容应真落盘");
  } finally {
    await stopServer(child);
  }
});

test("用例22：上传真题 → 走 analyzePro 声明路径，并进体系可查询", async () => {
  const dataDir = makeFixtureDataDir({ withPreset: false });
  const runtime = makeTempDir();
  const child = await startServer(dataDir, runtime);
  try {
    const r = await postJSON("/api/upload", {
      name: "_test-problem",
      target: "problems",
      content: "# 测试真题\n## 题型: 计算\n## 涉及知识点: 整数加减\n12 + 7 = ?\n",
    });
    assert.equal(r.extractedBy, "rule", "无 Key 时真题按 md 声明抽取");
    assert.equal(r.points, 1, "应声明出 1 个知识点");

    const graph = (await (await fetch(`${BASE}/api/graph`)).json()) as {
      problems: Array<{ name: string }>;
    };
    assert.ok(graph.problems.some((p) => p.name === "测试真题"), "上传的真题应进体系");
  } finally {
    await stopServer(child);
  }
});

test("用例23：既无声明、presets 也没有 ⇒ 如实返回 0 点 + 可诊断的 note（不假装成功）", async () => {
  const dataDir = makeFixtureDataDir({ withPreset: false });
  const runtime = makeTempDir();
  const child = await startServer(dataDir, runtime);
  try {
    const r = await postJSON("/api/upload", {
      name: "_test-nodecl",
      target: "materials",
      content: "# 无声明资料\n\n正文而已。\n",
    });
    assert.equal(r.ok, true);
    assert.equal(r.points, 0, "没有 Key / 预置时确实抽不出点，不应谎报");
    assert.ok(String(r.note).length > 0, "必须在 note 里说明为什么抽不出（可诊断）");
  } finally {
    await stopServer(child);
  }
});

test("用例24：SimNet.analyzeRes 的预设兜底读的是 inputDir，不再被 dataDir 带偏", async () => {
  const { SimNet } = await import("../src/network.ts");
  const inputDir = makeTempDir(); // 只读输入：资料 + presets 在这里
  const dataDir = makeTempDir(); // 可写产物：与输入**不同**，复现网页壳的布局
  const matDir = path.join(inputDir, "materials");
  const matFile = path.join(matDir, "x.md");
  mkdirSync(path.join(inputDir, "presets"), { recursive: true });
  mkdirSync(matDir, { recursive: true });
  writeFileSync(matFile, "# 无声明资料\n\n正文而已，没有 `## 知识点:` / `## 前置:` 声明。\n", "utf8");
  // ⚠️ 资源名必须是**能被读到的路径**（analyzeRes 先读文件、再按同一字符串查 presets）
  const resource = matFile.replace(/\\/g, "/");
  writeFileSync(
    path.join(inputDir, "presets", "analyze-req.json"),
    JSON.stringify({ resources: [{ resource, points: [{ name: "P" }], edges: [] }] }),
    "utf8",
  );

  const net = new SimNet({ dataDir, inputDir, skipLoad: true, aliases: {} });
  const got = await net.analyzeRes(resource);
  assert.equal(got.points.length, 1, "应从 inputDir/presets 拿到兜底结果（修前它去读 dataDir/presets）");
  assert.equal(got.points[0].name, "P");
  assert.ok(!existsSync(path.join(dataDir, "graph.json")), "analyzeRes 是只读的，不应写产物");
});
