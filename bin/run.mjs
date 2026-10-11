#!/usr/bin/env node
// ============================================================================
// bin/run.mjs — 统一入口：按 Node 版本选择"类型擦除"的调用方式，版本不够时给出可执行的建议。
//
// 为什么需要它：本项目运行时零依赖、直接跑 .ts，靠的是 Node 的**类型擦除**能力。
//   - Node ≥ 23.6：类型擦除默认开启 ⇒ 直接 `node x.ts`；
//   - Node 22.6 ~ 23.5：需要 `--experimental-strip-types`；
//   - Node < 22.6（例如 20 / 18）：**没有**这个能力 ⇒ 与其让人对着
//     `bad option: --experimental-strip-types` 发懵，不如在这里给出一行能照做的命令。
//
// 用法（npm scripts 都走它）：
//   node bin/run.mjs demo/l1-demo.ts
//   node bin/run.mjs --test tests/*.test.ts        # 其余参数原样转发给 node
//
// 测试钩子：T2_FORCE_NODE_VERSION=20.11.0 node bin/run.mjs demo/l1-demo.ts
//   用来在不降级 Node 的前提下验证"版本不够"的提示文案（见 docs/演示脚本.md 的失败预案）。
// ============================================================================
import { spawnSync } from "node:child_process";

const rawVersion = process.env.T2_FORCE_NODE_VERSION ?? process.versions.node;
const [major, minor] = rawVersion.split(".").map((x) => Number.parseInt(x, 10));
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("用法：node bin/run.mjs <脚本或 node 参数…>");
  console.error("例：  node bin/run.mjs demo/l1-demo.ts");
  process.exit(2);
}

if (!Number.isFinite(major) || major < 22 || (major === 22 && minor < 6)) {
  console.error(
    [
      `✗ Node ${rawVersion} 不能直接运行本项目的 .ts（需要 Node ≥ 22.6 的类型擦除能力）。`,
      "",
      "三种照做就能跑的办法：",
      "  1) 用 nvm / fnm 换到 Node 22 LTS 或更高：  nvm install 22 && nvm use 22",
      "  2) 用 Docker 一口气跑（不需要本机装 Node）：",
      "     docker run --rm -v \"$PWD:/app\" -w /app node:22 node --experimental-strip-types demo/l1-demo.ts",
      "     （Windows PowerShell 把 \"$PWD:/app\" 换成 \"${PWD}:/app\"）",
      "  3) 本机已有更高版本时显式指定：  node --experimental-strip-types demo/l1-demo.ts",
      "",
      "只做静态检查、不跑演示的话：  npm install && npm run typecheck",
    ].join("\n"),
  );
  process.exit(3);
}

// ≥ 23.6 ⇒ 类型擦除默认开启，不用再传 flag（老 flag 也仍被接受，这里只是不传）
const stripFlag = major > 23 || (major === 23 && minor >= 6) ? [] : ["--experimental-strip-types"];
const res = spawnSync(process.execPath, [...stripFlag, ...args], { stdio: "inherit" });
if (res.error) {
  console.error(`✗ 启动失败：${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
