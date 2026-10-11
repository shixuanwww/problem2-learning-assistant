// ============================================================================
// demo/verify-persist.ts — §9.2 第 4 步：另起一个进程读回落盘数据，证明"真落盘"。
//   载入 graph.json（知识体系）与 state.json（学习状态），校验两者仍在。
//   命令行：node --experimental-strip-types demo/verify-persist.ts
//   目录：与 demo/l1-demo.ts / full-demo.ts 共用 demo/runtime.ts 的解析口径
//         （T2_DATA_DIR / T2_RUNTIME_DIR），保证"写在哪就读哪"。
// ============================================================================
import { SimNet } from "../src/network.ts";
import { RUNTIME } from "./runtime.ts";

const dir = RUNTIME;
const net = new SimNet({ dataDir: dir });

const graphPoints = net.alivePoints().length;
const stateEntries = [...net.state.entries()];
const kindEntries = [...net.kindState.entries()];

console.log("=== verify-persist：另起进程读回持久化数据 ===");
console.log(`读取目录：${dir}`);
console.log(`知识体系 graph：${graphPoints} 个知识点（存活）`);
console.log(`学习状态 state：${stateEntries.length} 条`);
for (const [k, v] of stateEntries) console.log(`   掌握度  ${k} = ${v.toFixed(2)}`);
console.log(`题型掌握度 kindState：${kindEntries.length} 条`);
for (const [k, v] of kindEntries) console.log(`   题型掌握度  ${k} = ${v.toFixed(2)}`);

// §8 用例 11：重启后学习状态仍在（且"知识体系"也仍在，见 §4.14）
const ok = graphPoints > 0 && stateEntries.length > 0;
console.log(ok ? "PASS: 持久化生效（跨进程读回知识体系 + 学习状态）" : "FAIL");
if (!ok) process.exit(1);
