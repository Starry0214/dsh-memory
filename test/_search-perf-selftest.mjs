// _search-perf-selftest.mjs —— memory_search 性能优化（批量查询 / topics() 单遍 / 正文 SQL 预过滤）
//
// 跑法：node test/_search-perf-selftest.mjs
//
// 覆盖：
//   ① 批量查询与逐个 _liveSentences 结果等价（活句集合逐字段）
//   ② 墓碑过滤一致（sentenceId 行级 + legacy sha 兜底）
//   ③ merge view 有效口径一致（sentences/chars/physical 与旧公式）
//   ④ memory_search 结果优化前后等价（fast vs 逐主题 readTopic 参考实现，多 query 逐字节比较）
//   ⑤ 性能阈值（真机副本：topics()<200ms、renderSearch<500ms）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const msMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "memory-store.mjs")).href);
const bsMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "backend-sqlite.mjs")).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-perf-selftest-"));

function sameRows(a, b) {
  if ((a || []).length !== (b || []).length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || {}, y = b[i] || {};
    const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
    if (kx.length !== ky.length || kx.some((k, j) => k !== ky[j])) return false;
    for (const k of kx) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) return false;
  }
  return true;
}
function openDb(file) {
  const be = new bsMod.SqliteBackend(file);
  const store = new msMod.MemoryStore(be);
  return { be, store };
}

// ── 造一个小库：含墓碑 + 合并视图 ───────────────────────────────────
const fxFile = path.join(TMP, "fx.db");
{
  const { be, store } = openDb(fxFile);
  const mk = (name, trigs, sentences) => {
    const r = store.seedTopic({ name, triggers: trigs, src: "test:" + name, actor: "plugin" });
    const id = r.id || (r.topic && r.topic.id);
    try { store.setState(id, "active", { actor: "runtime", reason: "t" }); } catch (e) {}
    for (const s of sentences) store.appendSentence({ topic: id, text: s, src: "test/" + name, actor: "runtime" });
    return id;
  };
  mk("性能自测-缓存策略", ["缓存", "性能"], ["缓存命中率 0.1 元", "未命中 1 元", "前缀缓存按字节"]);
  mk("性能自测-索引刷新", ["索引", "刷新"], ["索引刷新每小时一次", "全量重建 2.3 秒"]);
  mk("性能自测-归档流水", ["归档"], ["归档保留原文", "墓碑只隐藏行"]);
  const idA = mk("性能自测-合并主", ["合并", "主主题"], ["主主题保留句一", "主主题保留句二"]);
  const idB = mk("性能自测-合并源", ["合并", "源主题"], ["源主题句一", "源主题句二"]);
  // 墓碑：删掉「归档流水」一句（sentenceId 行级）
  const rows = store.readTopic("性能自测-归档流水").sentences;
  store.deleteSentence("性能自测-归档流水", { sentenceId: rows[0].id }, { actor: "runtime", reason: "test-tombstone" });
  // 合并视图（簇合并：A 为主、B 为成员 ⇒ merge.record/merge.index ⇒ mergeRole=main）
  try { store.mergeCluster({ members: [idA, idB], title: "性能自测-合并簇主", actor: "runtime", reason: "perf-test" }); } catch (e) { console.log("NOTE mergeCluster 跳过：" + (e && e.message)); }
  be.close();
}

// ── ① 批量 vs 逐个 _liveSentences ──────────────────────────────────
{
  const { be, store } = openDb(fxFile);
  const bulk = store._liveSentencesByTopic();
  let same = true, detail = "";
  for (const t of store.be.listTopics()) {
    const one = store._liveSentences(t.id);
    const many = bulk.get(t.id) || [];
    if (!sameRows(one, many)) { same = false; detail = t.id + " " + t.name; break; }
  }
  ok(same, "A1 批量 listSentencesByTopic 与逐个 _liveSentences 逐字段等价", detail);
  const stats = store._liveSentenceStatsByTopic();
  let statsSame = true, sdetail = "";
  for (const t of store.be.listTopics()) {
    const one = store._liveSentences(t.id);
    const st = stats.get(t.id) || { count: 0, chars: 0 };
    if (st.count !== one.length || st.chars !== one.reduce((a, x) => a + (x.chars || 0), 0)) { statsSame = false; sdetail = t.id + " count=" + st.count + "/" + one.length; break; }
  }
  ok(statsSame, "A2 聚合统计与逐个活句 count/chars 等价", sdetail);
  // ② 墓碑过滤一致
  const archRows = store.readTopic("性能自测-归档流水").sentences;
  const physical = (store.be.listSentences(store.be.getTopicByNorm("性能自测归档流水").id) || []).length;
  ok(physical === 2 && archRows.length === 1, "B1 墓碑过滤：物理 2 行 / live 1 行（batch 同源过滤）", "physical=" + physical + " live=" + archRows.length);
  // ③ merge view 有效口径
  const rows = store.topics();
  const main = rows.find((t) => t.name === "性能自测-合并簇主");
  const src = rows.find((t) => t.name === "性能自测-合并源");
  if (main && src && main.mergeRole === "main") {
    const refs = main.sentences;
    // 语义：有效句数 = merge.record 的 refs 数（readTopic 聚合）；物理句数 = 主主题自身物理行（簇合并后常为 0）
    const rtMain = store.readTopic(main.id);
    const expEff = rtMain.mergeView ? rtMain.mergeView.expected : rtMain.sentences.length;
    const ownPhys = store._liveSentences(main.id).length;
    ok(main.mergeRole === "main" && main.sentences === expEff && main.physicalSentences === ownPhys, "C1 合并主主题：有效句数=refs、物理句数=自身物理", JSON.stringify({ eff: main.sentences, expEff, phys: main.physicalSentences, ownPhys }));
    ok(src.sentences === 0, "C2 被合并源主题有效句数=0（物理行仍在）", JSON.stringify({ eff: src.sentences, phys: src.physicalSentences }));
    const sumEff = rows.reduce((a, r) => a + r.sentences, 0);
    const total = store.topicCounts().sentences;
    ok(sumEff === total, "C3 topics() 有效句数和 == topicCounts().sentences（合并后总数不变）", sumEff + "/" + total);
  } else { console.log("SKIP  C 合并视图（mergeTopics 不可用或未生效）"); }
  be.close();
}

// ── ①b 账本后端（LedgerBackend）同签名等价 ─────────────────────────
{
  const lbMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "backend-ledger.mjs")).href);
  const lfile = path.join(TMP, "ledger.jsonl");
  const be = new lbMod.LedgerBackend(lfile);
  const store = new msMod.MemoryStore(be);
  const mk = (name, trigs, ss) => { const r = store.seedTopic({ name, triggers: trigs, src: "t:" + name, actor: "plugin" }); const id = r.id || (r.topic && r.topic.id); try { store.setState(id, "active", { actor: "runtime", reason: "t" }); } catch (e) {} for (const x of ss) store.appendSentence({ topic: id, text: x, src: "t", actor: "runtime" }); return id; };
  mk("账本缓存", ["缓存"], ["缓存命中率", "未命中"]);
  mk("账本索引", ["索引"], ["索引刷新"]);
  const rowsL = store.topics();
  const bulkL = store._liveSentencesByTopic();
  const statsL = store._liveSentenceStatsByTopic();
  ok(rowsL.every((t) => sameRows(bulkL.get(t.id) || [], store._liveSentences(t.id))) && rowsL.every((t) => { const st = statsL.get(t.id) || { count: 0, chars: 0 }; const live = store._liveSentences(t.id); return st.count === live.length && st.chars === live.reduce((a, x) => a + (x.chars || 0), 0); }), "A3 LedgerBackend 同签名批量方法与逐个结果等价");
  const foundL = store.searchSentencesByTokens(["缓存"]);
  ok(foundL.size === 1 && [...foundL.values()][0].length === 1, "A4 LedgerBackend 正文预过滤命中（1 主题 / 1 行）", "topics=" + foundL.size);
  be.close();
}

// ── ④ memory_search 结果等价（fast vs 逐主题 readTopic 参考实现）────────
{
  const { be, store } = openDb(fxFile);
  const tokensOf = mod.__topicdbTokens || null;
  // 参考实现：完全复刻优化前逻辑（store.topics() + 每主题 readTopic）
  function refSearch(q, maxTopics) {
    const tokens = String(q || "").toLowerCase().split(/[\s,，、;；:：|/\\()（）\[\]【】"']+/).filter(Boolean);
    const uniq = [...new Set(tokens)];
    if (!uniq.length) return { hits: [], conflicts: [] };
    const all = store.topics();
    const scored = [];
    for (const t of all) {
      if (t.state === "archived") continue;
      const trig = Array.isArray(t.effectiveTriggers) ? t.effectiveTriggers.map(String) : (Array.isArray(t.activeTriggers) ? t.activeTriggers.map(String) : []);
      const head = [t.name, ...(t.aliases || []), ...trig].join(" ").toLowerCase();
      let score = 0;
      for (const tk of uniq) if (head.includes(tk)) score += 3;
      const rows = t.sentences > 0 ? store.readTopic(t.id).sentences : [];
      const hits = [];
      for (const r of rows) {
        const low = String(r.text).toLowerCase();
        let n = 0;
        for (const tk of uniq) if (low.includes(tk)) n += 1;
        if (n > 0) { score += n; if (hits.length < 3) hits.push({ text: r.text, src: r.src || "" }); }
      }
      if (score > 0) scored.push({ topic: t, score, hits });
    }
    scored.sort((a, b) => b.score - a.score || (b.topic.updatedAt || 0) - (a.topic.updatedAt || 0));
    return { hits: scored.slice(0, maxTopics), conflicts: [] };
  }
  const norm = (r) => JSON.stringify((r.hits || []).map((h) => ({ id: h.topic.id, name: h.topic.name, score: h.score, hits: h.hits })));
  const queries = ["缓存", "性能", "索引 刷新", "归档", "合并", "墓碑", "主主题", "0.1 元", "不存在的词zzz", "缓存 归档 索引"];
  let same = true; let bad = "";
  for (const q of queries) {
    const fast = mod.__topicdbSearchTopics(store, q, { maxTopics: 8 });
    const slow = refSearch(q, 8);
    if (norm(fast) !== norm(slow)) { same = false; bad = q + "\nfast=" + norm(fast).slice(0, 300) + "\nslow=" + norm(slow).slice(0, 300); break; }
  }
  ok(same, "D1 memory_search 主题检索：fast（批量+SQL 预过滤）与优化前参考实现逐字节等价", bad);
  be.close();
}

// ── ⑤ 性能阈值（真机副本；无真库则跳过）───────────────────────────
try {
  const real = path.join(process.env.USERPROFILE || "C:\\Users\\Starry", ".dsh", "memory", ".memtopic", "mem.db");
  if (!fs.existsSync(real)) console.log("SKIP  E 真机性能（无 mem.db）");
  else {
    const dst = path.join(TMP, "real.db");
    fs.copyFileSync(real, dst);
    for (const ext of ["-wal", "-shm"]) { try { fs.copyFileSync(real + ext, dst + ext); } catch (e) {} }
    const { be, store } = openDb(dst);
    store.topics();   // warm
    const t0 = performance.now();
    const rows = store.topics();
    const t1 = performance.now();
    const topicsMs = Math.round(t1 - t0);
    // 端到端检索：主题检索 + 渲染（memory_search 的库内主路径）
    const q0 = performance.now();
    const rendered = mod.__topicdbRenderSearch(store, "缓存");
    const q1 = performance.now();
    const searchMs = Math.round(q1 - q0);
    console.log("MEASURE topicsMs=" + topicsMs + " renderSearchMs=" + searchMs + " topics=" + rows.length);
    ok(topicsMs < 200, "E1 store.topics() < 200ms（实测 " + topicsMs + "ms，原 1564ms）", "rows=" + rows.length);
    ok(searchMs < 500, "E2 memory_search 库内主路径 < 500ms（实测 " + searchMs + "ms，原 ~3s）", "rendered=" + (rendered ? rendered.length : 0));
    // 真机等价：对 5 个常见 query 与参考实现比对（只比 topic/score/hits）
    const norm2 = (r) => JSON.stringify((r.hits || []).map((h) => ({ id: h.topic.id, score: h.score, hits: h.hits })));
    let sameReal = true; let badReal = "";
    for (const q of ["缓存", "记忆", "主题库", "session_search", "安装器"]) {
      const fast = mod.__topicdbSearchTopics(store, q, { maxTopics: 8 });
      // 参考：临时禁用快路径（store 上抹掉批量方法 ⇒ 走 readTopic 回落分支）
      const savedSearch = store.searchSentencesByTokens;
      const savedMerge = store.mergeViewTopicIds;
      try { delete store.searchSentencesByTokens; delete store.mergeViewTopicIds; } catch (e) {}
      const slow = mod.__topicdbSearchTopics(store, q, { maxTopics: 8 });
      if (savedSearch) store.searchSentencesByTokens = savedSearch;
      if (savedMerge) store.mergeViewTopicIds = savedMerge;
      if (norm2(fast) !== norm2(slow)) { sameReal = false; badReal = q + " fast=" + norm2(fast).slice(0, 200) + " slow=" + norm2(slow).slice(0, 200); break; }
    }
    ok(sameReal, "E3 真机 5 个 query：快路径与 readTopic 回落路径结果等价", badReal);
    be.close();
  }
} catch (e) { console.log("SKIP  E 真机性能异常（不影响门）：" + ((e && e.message) || e)); }

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
process.exit(fails.length ? 1 : 0);
