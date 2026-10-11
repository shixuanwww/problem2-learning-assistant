// ============================================================================
// src/qa.ts — §4.10 问答
//   检索（关键词 n-gram / 可选向量）→ top-k 片段 → 判定「资料是否充足」→
//   有 Key 时模型仅依据片段作答并注入「只读」学习状态上下文；无 Key / 失败时抽取式降级。
//   —— 无论充足与否，都要 record({kind:"Ask",...}) 回填（题面：提问也是可追溯的学习行为）。
//
//   充足性判定（§4.10，数值阈值，可复现）：
//     向量模式：top1 相似度 >= 0.45
//     关键词模式：命中片段数 >= 1 且 查询词项覆盖率 >= 0.5
//   两条都不满足 ⇒ sufficient=false、answer=null（不得用模型自身知识补全）。
// ============================================================================
import type { Asker, AskResult, Citation } from "./types.ts";
import {
  CONTEXT_ANSWERS,
  CONTEXT_HISTORY,
  KEYWORD_COVERAGE_THRESHOLD,
  TOP_K,
  UNCLASSIFIED_KIND,
  VEC_SUFFICIENT_THRESHOLD,
} from "./types.ts";
import type { SourceChunk } from "./analyze/parse.ts";
import { chat, embed, hasChatKey, hasEmbedKey } from "./analyze/llm.ts";
import type { SimNet } from "./network.ts";

interface ScoredChunk {
  chunk: SourceChunk;
  score: number; // 关键词命中得分
  vectorSim?: number; // 向量相似度（向量模式时）
  terms: string[]; // 该片段命中的查询词项
}

// ---------- 词项抽取（关键词/覆盖率用） ----------
const STOP_CHARS = new Set("的了吗呢啊吧与和或及在是这那有会什么怎么如何请问我你他它请".split(""));

function queryTerms(q: string): string[] {
  const terms = new Set<string>();
  for (const t of q.match(/[a-zA-Z0-9]+/g) ?? []) {
    if (t.length >= 2) terms.add(t.toLowerCase());
  }
  for (const run of q.match(/[\u4e00-\u9fff]+/g) ?? []) {
    // 去停用虚字
    const r = [...run].filter((ch) => !STOP_CHARS.has(ch)).join("");
    for (let len = Math.min(3, r.length); len >= 2; len--) {
      for (let i = 0; i + len <= r.length; i++) terms.add(r.slice(i, i + len));
    }
  }
  return [...terms];
}

function contains(haystack: string, terms: string[]): string[] {
  return terms.filter((t) => haystack.includes(t));
}

// ---------- 检索 ----------
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

/**
 * 问答引擎（§4.10）。implements Asker —— ask 由它提供，不在 SimNet 上
 * （问答需要"检索索引"这份额外原料，SimNet 只管知识网络）。
 *
 * `offline: true` ⇒ **强制**走纯本地路径（关键词检索 + 抽取式回答），
 * 即使机器上恰好配了 Key 也不联网。l1-demo（保底演示）用它，
 * 目的是让"离线保底"的输出在**任何机器上完全一致**，不因有无 Key 而变。
 */
export interface QaOptions {
  offline?: boolean;
}

export class QaEngine implements Asker {
  private chunks: SourceChunk[];
  private net: SimNet;
  private offline: boolean;
  private chunkVecs: Array<{ chunk: SourceChunk; vec: number[] }> | null = null;

  constructor(chunks: SourceChunk[], net: SimNet, opts: QaOptions = {}) {
    this.chunks = chunks;
    this.net = net;
    this.offline = opts.offline ?? false;
  }

  get available(): number {
    return this.chunks.length;
  }

  private async vectorRetrieve(question: string, topK: number): Promise<ScoredChunk[]> {
    if (!this.chunkVecs) {
      const vecs: Array<{ chunk: SourceChunk; vec: number[] }> = [];
      for (const c of this.chunks) {
        try {
          vecs.push({ chunk: c, vec: await embed(c.text) });
        } catch {
          throw new Error("embedding 失败");
        }
      }
      this.chunkVecs = vecs;
    }
    const qvec = await embed(question);
    const scored: ScoredChunk[] = this.chunkVecs.map((cv) => ({
      chunk: cv.chunk,
      score: 0,
      vectorSim: cosine(qvec, cv.vec),
      terms: [],
    }));
    scored.sort((a, b) => (b.vectorSim ?? 0) - (a.vectorSim ?? 0));
    return scored.slice(0, topK);
  }

  private keywordRetrieve(question: string, topK: number): ScoredChunk[] {
    const terms = queryTerms(question);
    const scored: ScoredChunk[] = this.chunks.map((c) => {
      const hit = contains(c.text, terms);
      return { chunk: c, score: hit.length, terms: hit };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private async retrieve(question: string, topK = TOP_K): Promise<{ scored: ScoredChunk[]; mode: "vector" | "keyword" }> {
    if (!this.offline && hasEmbedKey()) {
      try {
        return { scored: await this.vectorRetrieve(question, topK), mode: "vector" };
      } catch {
        // 落到关键词
      }
    }
    return { scored: this.keywordRetrieve(question, topK), mode: "keyword" };
  }

  // ---------- 充足性判定（§4.10，数值阈值） ----------
  // 向量模式：top1 相似度 >= 0.45
  private isSufficientVector(scored: ScoredChunk[]): boolean {
    const top1 = scored.length ? (scored[0].vectorSim ?? 0) : 0;
    return top1 >= VEC_SUFFICIENT_THRESHOLD;
  }

  // 关键词模式：命中片段数 >= 1 且 查询词项覆盖率 >= 0.5
  private isSufficientKeyword(query: string, scored: ScoredChunk[]): boolean {
    const terms = queryTerms(query);
    if (terms.length === 0) return false;
    const hits = scored.filter((s) => s.score > 0);
    if (hits.length < 1) return false;
    const present = new Set<string>();
    for (const s of hits) for (const t of s.terms) present.add(t);
    const coverage = present.size / terms.length;
    return coverage >= KEYWORD_COVERAGE_THRESHOLD;
  }

  private toCitation(s: ScoredChunk): Citation {
    const snippet = s.chunk.text.length > 200 ? s.chunk.text.slice(0, 200) + "…" : s.chunk.text;
    return {
      resource: s.chunk.resource,
      locator: s.chunk.locator,
      snippet,
      score: s.vectorSim,
    };
  }

  // ---------- 上下文包（§4.10：L3 完成标志④） ----------
  /**
   * 注入一份**只读**摘要，三项一个不少（§4.10 / §11）：
   *   ① 相关点的 state（走 masteryOf）+ 该点相关题型的 kindState；
   *   ② 相关真题（queryPoint）+ 结构化作答记录 AnswerRecord（该点最近 N=5 条）；
   *   ③ 相关 HistoryEntry（最近 M=5 条）。
   * 三项只读 —— 模型要改状态只能走 record()。
   */
  private buildContext(question: string): string {
    const net = this.net;
    // 相关点：问题字符串里直接出现了知识点名（最简可解释的匹配，粗但可复现）
    const related: string[] = [];
    for (const p of net.topoOrder()) {
      if (p.name.length > 0 && question.includes(p.name)) related.push(p.name);
    }
    if (related.length === 0) return "";

    const lines: string[] = ["【学习状态（只读，模型不得据此改写 state）】"];
    for (const name of related) {
      const key = net.keyOf(name);
      const q = net.queryPoint({ name });
      const mastery = net.state.get(key);
      lines.push(
        `- 知识点「${name}」：掌握度 ${
          mastery === undefined ? "0.5（未学过，冷启动先验）" : mastery.toFixed(2)
        }`,
      );
      if (q.problems.length) {
        lines.push(
          `  相关真题：${q.problems.map((p) => p.name).join("、")}｜题型：${q.kinds.join("、") || UNCLASSIFIED_KIND}`,
        );
      }
      // ② 题型掌握度（kindState）
      for (const k of q.kinds.length ? q.kinds : [UNCLASSIFIED_KIND]) {
        const km = net.kindState.get(k);
        lines.push(`  题型「${k}」掌握度：${km === undefined ? "0.5（先验）" : km.toFixed(2)}`);
      }
      // ② 结构化作答记录（最近 N=5）
      const recs = net.answers.filter((a) => a.pointNames.includes(key)).slice(-CONTEXT_ANSWERS);
      if (recs.length) {
        lines.push(
          `  最近作答记录（最近 ${recs.length} 条 / 定值 N=${CONTEXT_ANSWERS}）：` +
            recs.map((r) => `${r.problemName}[${r.kind}]→${r.status}`).join("；"),
        );
      }
      // ③ 学习历史（最近 M=5）
      const hists = net.history.filter((h) => (h.pointNames ?? []).includes(key)).slice(-CONTEXT_HISTORY);
      if (hists.length) {
        lines.push(
          `  最近学习历史（最近 ${hists.length} 条 / 定值 M=${CONTEXT_HISTORY}）：` +
            hists.map((h) => `${h.kind}:${h.detail}`).join("；"),
        );
      }
    }
    return lines.join("\n");
  }

  // ---------- 主入口 ----------
  async ask(question: string): Promise<AskResult> {
    const net = this.net;
    const { scored, mode } = await this.retrieve(question);

    // 判定充足性
    const sufficient =
      mode === "vector"
        ? this.isSufficientVector(scored)
        : this.isSufficientKeyword(question, scored);

    const citations = scored.map((s) => this.toCitation(s));

    if (!sufficient) {
      // 资料不足：answer=null，明确提示，不补全；回填记录
      net.record({ kind: "Ask", question, answer: null, citations: citations.slice(0, TOP_K) });
      return { question, answer: null, citations: citations.slice(0, TOP_K), sufficient: false };
    }

    // 有 Key 且充足 → 模型仅依据片段作答 + 注入只读上下文
    if (!this.offline && hasChatKey()) {
      try {
        const context = this.buildContext(question);
        const answer = await this.modelAnswer(question, scored, context);
        net.record({ kind: "Ask", question, answer, citations: citations.slice(0, TOP_K) });
        return { question, answer, citations: citations.slice(0, TOP_K), sufficient: true };
      } catch {
        // 模型失败 → 抽取式
      }
    }

    // 抽取式降级：直接把命中片段作为答案返回
    const answer = scored.length > 0 ? scored[0].chunk.text : null;
    const fallback = mode === "vector" ? "extractive" : "keyword";
    net.record({ kind: "Ask", question, answer, citations: citations.slice(0, TOP_K) });
    return { question, answer, citations: citations.slice(0, TOP_K), sufficient, fallback };
  }

  private async modelAnswer(question: string, scored: ScoredChunk[], context: string): Promise<string> {
    const snippets = scored
      .map((s, i) => `[${i + 1}] (${s.chunk.resource} / ${s.chunk.locator}) ${s.chunk.text}`)
      .join("\n\n");
    const sys =
      "你是课程学习助手。只能依据用户提供的资料片段回答，禁止用你自身的常识补全；" +
      "若片段不足以回答，请回复「资料不足」。回答要紧扣资料，并尽量在末尾注明引用的片段编号。" +
      "上下文中的【学习状态】是只读信息，用于调整讲解的详略，不得当作资料依据。";
    const user = `${context}\n\n==资料片段（唯一依据）==\n${snippets}\n\n问题：${question}`;
    return chat([
      { role: "system", content: sys },
      { role: "user", content: user },
    ], { maxTokens: 800 });
  }
}
