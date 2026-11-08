// _hit-renew-selftest.mjs —— 「检索命中 ⇒ 续期」（markHit 接线）自测（2026-11-06）
//
// 背景真机缺口：`markHit` 早在 memory-store.mjs#1596 实现，但**全仓 0 调用方**
//   ⇒ topics.last_hit_at 573/573 为 NULL ⇒ lifecycle.isRenewed() 恒 false
//   ⇒ 曝光阶梯只能按 stateSince/createdAt 走 ⇒ 90 天后按创建日期批量归档（真机 2027-01-27 一天归档 338 条）。
//
// 覆盖：
//   A 前置：主题库就绪 + 造数（lastHitAt 初始为 null）
//   B memory_search 命中 ⇒ lastHitAt 落值（核心：改前恒 null）
//   C 同主题 1h 内再次命中 ⇒ 不重复记（节流）
//   D memory_read 显式读取 ⇒ 也是使用信号
//   E 反例：memory_topics 列表浏览**不算**使用（候选集 ≠ 使用，算了就把续期机制废掉）
//   F 静态接线断言（防被回退）
//
// 隔离纪律：os.tmpdir() 临时 home；不碰真实 ~/.dsh/memory。
import { useHome, mkHome, freshPlugin, makeCtx, applyPlugin, waitTopicDb, makeReporter, finish } from "./_accept-p0-lib.mjs";

const R = makeReporter("检索命中续期（markHit 接线）");
const CFG_ON = { memoryTopicDbEnabled: true };
const rand = () => Math.random().toString(36).slice(2, 7).toUpperCase();

const H = mkHome("hitrenew");
useHome(H);
const mod = await freshPlugin();
const { ctx, captured } = makeCtx();
applyPlugin(mod, CFG_ON, ctx);
const ready = await waitTopicDb(mod);
R.ok(ready, "A0 前置：主题库就绪", ready ? "ready" : "not-ready");
if (!ready) finish(R, true);

const store = mod.__topicdb && mod.__topicdb.store;
R.ok(!!store, "A1 取到 store 句柄");
if (!store) finish(R, true);

// ── 造数：一个带稀有 token 的主题 ──
const TOK = "RENEWTOK" + rand();
const t = store.seedTopic({ name: "续期测试-" + rand(), triggers: [TOK], src: "selftest", actor: "plugin" });
store.appendSentence({ topic: t.id, text: "含稀有词 " + TOK + " 的正文，用于命中检索。", src: null, actor: "runtime" });
const hit0 = store.topics().find((x) => x.id === t.id);
R.ok(!!hit0 && hit0.lastHitAt == null, "A2 造数：初始 lastHitAt 为 null（复现真机 573/573 NULL）", "lastHitAt=" + (hit0 && hit0.lastHitAt));

const tools = captured.tools || [];
const ms = tools.find((x) => x && x.name === "memory_search");
const mr = tools.find((x) => x && x.name === "memory_read");
const mt = tools.find((x) => x && x.name === "memory_topics");
R.ok(!!ms && !!mr && !!mt, "A3 三个工具已注册", [ms, mr, mt].map((x) => !!x).join(","));

const lastOf = (id) => { const x = store.topics().find((y) => y.id === id); return x ? x.lastHitAt : null; };

// ── B 检索命中 ⇒ 续期 ──
if (ms) {
  await ms.execute({ query: TOK }, {});
  const h1 = lastOf(t.id);
  R.ok(typeof h1 === "number" && h1 > 0, "B1 memory_search 命中 ⇒ lastHitAt 落值（改前恒 null）", "lastHitAt=" + h1);
  R.ok(Math.abs(Date.now() - Number(h1 || 0)) < 60000, "B2 lastHitAt ≈ 当前时间", "Δ=" + (h1 ? Date.now() - h1 : "-") + "ms");

  // ── C 节流：1h 内不重复记 ──
  const before = lastOf(t.id);
  await ms.execute({ query: TOK }, {});
  const after = lastOf(t.id);
  R.ok(before === after, "C1 同主题 1h 内再次命中 ⇒ lastHitAt 不变（节流生效）", before + " → " + after);
}

// ── D memory_read 显式读取也是使用 ──
if (mr) {
  const t2 = store.seedTopic({ name: "读取续期测试-" + rand(), triggers: ["READTOK" + rand()], src: "selftest", actor: "plugin" });
  store.appendSentence({ topic: t2.id, text: "读取测试正文。", src: null, actor: "runtime" });
  R.ok(lastOf(t2.id) == null, "D0 造数：第二个主题 lastHitAt 为 null");
  await mr.execute({ topic: t2.id }, {});
  const h2 = lastOf(t2.id);
  R.ok(typeof h2 === "number" && h2 > 0, "D1 memory_read ⇒ lastHitAt 落值", "lastHitAt=" + h2);
}

// ── E 反例：列表浏览不算使用 ──
if (mt) {
  const t3 = store.seedTopic({ name: "列表不该续期-" + rand(), triggers: ["LISTTOK" + rand()], src: "selftest", actor: "plugin" });
  store.appendSentence({ topic: t3.id, text: "列表测试正文。", src: null, actor: "runtime" });
  await mt.execute({ limit: 200 }, {});
  R.ok(lastOf(t3.id) == null, "E1 memory_topics 列表浏览 ⇒ 不记命中（候选集 ≠ 使用）", "lastHitAt=" + lastOf(t3.id));
}

// ── F 静态接线（防回退） ──
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");
R.ok(/function markTopicHits\(store, list, why\)/.test(src), "F1 静态：markTopicHits 助手存在");
R.ok(/markTopicHits\(store, hits, "search"\)/.test(src), "F2 静态：检索路径已接线");
R.ok(/markTopicHits\(store, \[t\], "read"\)/.test(src), "F3 静态：memory_read 已接线");
R.ok(/store\.markHit\(id, \{ actor: "runtime" \}\)/.test(src), "F4 静态：调用 store.markHit（不是自己改字段）");
R.ok(/HIT_DEDUPE_MS/.test(src), "F5 静态：存在节流常量");

finish(R);
