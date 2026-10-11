// ============================================================================
// tests/ledger.test.ts — 用例 40 / 41：启动接入记账（让 bootstrap 真正幂等）
//
//   用例40：selectPending 纯函数 —— 没接过的接、内容没变的跳过、内容变了的重接、force 全接。
//   用例41：ingestOnce 两轮跑同一批文件 ⇒ 第二轮**一次都不调抽取**；改了一个文件 ⇒ 只重接那一个。
//           这条是"连开三次网页壳知识点 21→27→40"那个 bug 的回归用例：
//           它不依赖起子进程（本机沙箱对派生进程不稳定），所以能稳定跑。
//
//   跑法：node --experimental-strip-types --test tests/*.test.ts
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashFile, ingestOnce, loadLedger, saveLedger, selectPending } from "../src/ingest-ledger.ts";
import { makeTempDir } from "./helpers.ts";

test("用例40：selectPending —— 只接「没接过」或「内容变过」的文件", () => {
  const files = ["a.md", "b.md", "c.md"];
  const hashes = { "a.md": "h1", "b.md": "h2", "c.md": "h3" };

  // 全都没接过 ⇒ 全接
  assert.deepEqual(selectPending(files, hashes, {}), { todo: files, skipped: [] });

  // a 接过且没变、b 接过但内容变了 ⇒ 只重接 b（和没接过的 c）
  const ledger = { "a.md": "h1", "b.md": "OLD" };
  assert.deepEqual(selectPending(files, hashes, ledger), { todo: ["b.md", "c.md"], skipped: ["a.md"] });

  // 全接过且都没变 ⇒ 一个都不接（这就是"重复启动不再长出新点"的关键）
  const full = { "a.md": "h1", "b.md": "h2", "c.md": "h3" };
  assert.deepEqual(selectPending(files, hashes, full), { todo: [], skipped: files });

  // force ⇒ 忽略记账，全量重接（T2_REINGEST=1 的语义）
  assert.deepEqual(selectPending(files, hashes, full, true), { todo: files, skipped: [] });

  // 文件读不到（hash 为空串）⇒ 视为"变化过"，会重接（安全方向：宁可多接一次）
  assert.deepEqual(selectPending(["gone.md"], { "gone.md": "" }, { "gone.md": "" }), { todo: ["gone.md"], skipped: [] });
});

test("用例41：两轮接入同一批文件 ⇒ 第二轮零次抽取；改过的文件才重接", async () => {
  const dir = makeTempDir();
  const ledgerFile = path.join(dir, "ingested.json");
  mkdirSync(path.join(dir, "materials"), { recursive: true });
  const f1 = path.join(dir, "materials", "m1.md");
  const f2 = path.join(dir, "materials", "m2.md");
  writeFileSync(f1, "# 资料一\n内容", "utf8");
  writeFileSync(f2, "# 资料二\n内容", "utf8");
  const files = [f1, f2];

  /** 假抽取器：只数调用次数，不碰网络/模型（这样用例在无 Key 的机器上也稳定）。 */
  const calls: string[] = [];
  const ingest = async (f: string): Promise<void> => {
    calls.push(path.basename(f));
  };

  const r1 = await ingestOnce(files, { ledgerFile, ingest });
  assert.deepEqual(r1.ingested, files, "第一轮：两份都要接入");
  assert.deepEqual(calls, ["m1.md", "m2.md"]);

  // 🔴 回归点：第二轮必须一次抽取都不发生
  calls.length = 0;
  const r2 = await ingestOnce(files, { ledgerFile, ingest });
  assert.deepEqual(r2.ingested, [], "第二轮：内容未变 ⇒ 不得再调抽取（修前这里会全量重接）");
  assert.deepEqual(r2.skipped, files);
  assert.deepEqual(calls, [], "抽取调用次数必须为 0");

  // 只改 m1 ⇒ 只重接 m1
  writeFileSync(f1, "# 资料一\n改了内容", "utf8");
  calls.length = 0;
  const r3 = await ingestOnce(files, { ledgerFile, ingest });
  assert.deepEqual(r3.ingested, [f1], "只有内容变过的文件重接");
  assert.deepEqual(calls, ["m1.md"]);

  // force（T2_REINGEST=1）⇒ 全量重接
  calls.length = 0;
  const r4 = await ingestOnce(files, { ledgerFile, ingest, force: true });
  assert.deepEqual(r4.ingested, files, "force ⇒ 忽略记账、全量重接");
  assert.deepEqual(calls, ["m1.md", "m2.md"]);

  // 账本确实落盘了，且损坏时当空账本（⇒ 全量重接，安全方向）
  const saved = loadLedger(ledgerFile);
  assert.equal(saved[f1], hashFile(f1));
  writeFileSync(ledgerFile, "{ 这不是 JSON", "utf8");
  assert.deepEqual(loadLedger(ledgerFile), {}, "损坏的账本当空 ⇒ 全量重接，不会漏接");

  // 空账本写回是合法操作（resetRuntime 后第一次启动就走到这里）
  saveLedger(ledgerFile, {});
  assert.deepEqual(loadLedger(ledgerFile), {});
});
