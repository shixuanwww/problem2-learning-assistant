// ============================================================================
// demo/verify-persist.ts — §9.2 第 4 步：另起一个进程读回 data/ 持久化，证明"真落盘"。
//   载入 data/graph.json（知识体系）与 data/state.json（学习状态），校验两者仍在。
//   命令行：node --experimental-strip-types demo/verify-persist.ts
//   可用环境变量 DATA_DIR 指定目录（默认 data，测试时指向临时夹具）。
// ============================================================================
import { SimNet } from "../src/network.ts";

const dir = process.env.DATA_DIR ?? "data";
const net = new SimNet({ dataDir: dir });

const graphPoints = net.graph.filter((n) => !n.dead).length;
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
