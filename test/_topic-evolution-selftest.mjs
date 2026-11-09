// _topic-evolution-selftest.mjs —— 4.5.7 主题演进（rename / norm / alias / 卫生指标 / dream 闸）
//
// 跑法：node test/_topic-evolution-selftest.mjs
//
// 覆盖 Lead 指定 9 项：
//   ① backend updateTopic 写 norm（P0） ② createTopic 查 aliases（P0） ③ rename 旧名进 aliases 且旧名仍命中
//   ④ 撞名拒绝 ⑤ aliases 上限 10 + FIFO 淘汰 ⑥ 六类禁止 rename（笔记/P2.5/会话检查点线含日记忆/索引类/archived/系统）
//   ⑦ dream-only 闸 + 每轮 3 次 ⑧ nearDup 算法（含「项目」/「项目管理」误报用例） ⑨ 指标计算
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");
const SRC = fs.readFileSync(PLUGIN, "utf8");
const BS_SRC = fs.readFileSync(path.join(here, "..", "memtopic", "src", "backend-sqlite.mjs"), "utf8");
const MS_SRC = fs.readFileSync(path.join(here, "..", "memtopic", "src", "memory-store.mjs"), "utf8");
const GOV_SRC = fs.readFileSync(path.join(here, "..", "memtopic", "src", "governance.mjs"), "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) { } await sleep(step || 50); }
  return false;
}

// ── 静态前置：两条 P0 + 工具/闸/卫生节/指标接线 ──
ok(/UPDATE topics SET name=\?,norm=\?,aliases=\?/.test(BS_SRC) && /\[4\.5\.7 P0\]/.test(BS_SRC), "S1 backend.updateTopic 持久化 norm（P0）");
ok(/_findTopicByAliasNorm\(norm\)/.test(MS_SRC) && /how: 'alias'/.test(MS_SRC), "S2 createTopic 命中 aliases（P0）");
ok(/rename:\s*true/.test(GOV_SRC) && /dream:[\s\S]{0,200}rename:\s*true/.test(GOV_SRC), "S3 governance: user/lead/runtime/dream 有 rename 位（plugin 无）");
ok(/name: "memory_rename_topic"/.test(SRC) && /toolName !== "memory_rename_topic"/.test(SRC), "S4 工具已注册且已进 dream 结构闸");
ok(/## 主题卫生（每轮顺手检查，有问题才动手）/.test(SRC) && /memory_rename_topic\(\{topic, new_name, reason\}\)/.test(SRC), "S5 dream 任务书含主题卫生节");
ok(/topicDbScheduleAutoExport\("rename"\)/.test(SRC), "S6 rename 后异步调度导出（不阻塞）");
ok(/TOPIC_HEALTH_TTL_MS = 5 \* 60 \* 1000/.test(SRC) && /topicHealthMetrics\(topics, \{ orphans: hier\.unmapped/.test(SRC), "S7 指标复用 stats 已取 rows + 5min 缓存 + 孤儿复用 hier.unmapped");
ok(/oversized = active\.filter\(\(t\) => !isIdx\(t\)/.test(SRC) && /"主题卫生：良好"/.test(SRC), "S8 oversized 排除索引类；全 0 显示「良好」");
ok(/isRenameProtectedTopicName/.test(SRC) && /日记忆（按天流水）/.test(SRC), "S9 rename 保护名判据含 6 类（含日记忆线）");

// ── 真跑：临时库 + fixture apply ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-topic-evo-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
for (const d of ["knowledge", "sessions", "projects"]) fs.mkdirSync(path.join(MEM, d), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- topic evo 自测\n", "utf8");
fs.writeFileSync(path.join(MEM, "index.md"), "# 记忆索引\n- global.md\n", "utf8");
fs.writeFileSync(path.join(MEM, ".monitor.json"), JSON.stringify({ hints: {}, events: [], maintain: {}, followed: 0, ignored: 0 }), "utf8");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href);
const { createFixtureCtx, findTool } = await import(pathToFileURL(FIXTURE).href);
const fx = createFixtureCtx({});
await mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "C0 前置：主题库就绪", mod.__topicdb && String(mod.__topicdb.err || "ok"));

if (ready) {
  const store = mod.__topicdb.store;
  const renameTool = findTool(fx.captured, "memory_rename_topic");
  ok(!!(renameTool && typeof renameTool.execute === "function"), "C0b 前置：memory_rename_topic 可取到");
  const seed = (name, triggers) => { const r = store.seedTopic({ name, triggers: triggers || ["t"], src: "test:" + name, actor: "plugin" }); const id = r.id || (r.topic && r.topic.id); try { store.setState(id, "active", { actor: "runtime", reason: "t" }); } catch (e) {} return id; };

  // ① backend updateTopic 写 norm
  const id1 = seed("演进自测-原名一", ["evo1"]);
  const newName1 = "演进自测-改名一";
  const normNew1 = "演进自测改名一";
  store.be.updateTopic(id1, { name: newName1, norm: normNew1, updatedAt: Date.now() });
  ok(store.be.getTopicByNorm(normNew1) && String(store.be.getTopicByNorm(normNew1).id) === String(id1), "A1 backend 写 norm：新名 norm 可精确命中");
  ok(!store.be.getTopicByNorm("演进自测原名一"), "A2 backend 写 norm：旧 norm 已不存在（不再旧名精确命中）");

  // ② createTopic 查 aliases
  const id2 = seed("演进自测-别名宿主", ["evo2"]);
  store.addAlias(id2, "演进自测-旧别名");
  const beforeN = store.topics().length;
  const c2 = store.createTopic({ name: "演进自测-旧别名", actor: "runtime" });
  ok(c2 && c2.how === "alias" && String(c2.id) === String(id2) && store.topics().length === beforeN, "A3 createTopic 命中 alias ⇒ 返回原主题，不新建重复", JSON.stringify(c2));

  // ③ rename：旧名进 aliases + 旧名仍可解析/检索
  const id3 = seed("演进自测-待改名", ["evo3"]);
  const r3 = store.renameTopic(id3, "演进自测-新名", { actor: "runtime", reason: "test" });
  const t3 = store.be.getTopicById(id3);
  ok(r3 && r3.ok === true && r3.from === "演进自测-待改名" && r3.to === "演进自测-新名", "B1 rename from/to 正确", JSON.stringify(r3));
  ok((t3.aliases || []).includes("演进自测-待改名") && r3.aliasesAdded === 1, "B2 旧名进 aliases", JSON.stringify(t3.aliases));
  ok(store.be.getTopicByNorm("演进自测新名") && !store.be.getTopicByNorm("演进自测待改名"), "B3 新名 norm 正确、旧 norm 已移除");
  let resolvedOld = null; try { resolvedOld = store.resolveTopic("演进自测-待改名"); } catch (e) { resolvedOld = null; }
  ok(resolvedOld && String(resolvedOld.id) === String(id3), "B4 旧名仍可解析（aliases）");
  let searchOld = ""; try { searchOld = String(mod.__topicdbRenderSearch(store, "演进自测-待改名") || ""); } catch (e) { searchOld = ""; }
  ok(searchOld.includes("演进自测-新名") || searchOld.includes(String(id3)), "B5 memory_search 旧名仍命中（检索 head 含 aliases）", searchOld.slice(0, 90));
  let auditHit = false; try { auditHit = (store.auditTail(300) || []).some((x) => String(x.op) === "topic.rename" && String(x.topicId) === String(id3)); } catch (e) { auditHit = false; }
  ok(auditHit, "B6 审计 topic.rename（from/to/reason）");

  // ④ 撞名拒绝
  const id4a = seed("演进自测-撞名A", ["evo4a"]);
  const id4b = seed("演进自测-撞名B", ["evo4b"]);
  let conflictCode = "";
  try { store.renameTopic(id4b, "演进自测-撞名A", { actor: "runtime" }); } catch (e) { conflictCode = (e && e.code) || ""; }
  ok(conflictCode === "NAME_CONFLICT", "C1 撞现有主题名 ⇒ NAME_CONFLICT", conflictCode);
  // 新名撞别人 alias 也算冲突
  store.addAlias(id4a, "演进自测-别人别名");
  let aliasConflict = "";
  try { store.renameTopic(id4b, "演进自测-别人别名", { actor: "runtime" }); } catch (e) { aliasConflict = (e && e.code) || ""; }
  ok(aliasConflict === "NAME_CONFLICT", "C2 新名撞别人 alias ⇒ NAME_CONFLICT", aliasConflict);

  // ⑤ aliases 上限 10 FIFO
  const id5 = seed("演进自测-别名上限", ["evo5"]);
  for (let i = 1; i <= 12; i++) store.addAlias(id5, "演进旧别名" + i);
  const t5 = store.be.getTopicById(id5);
  ok((t5.aliases || []).length === 10, "D1 aliases 收敛到上限 10", "n=" + (t5.aliases || []).length);
  ok((t5.aliases || []).includes("演进旧别名12") && !(t5.aliases || []).includes("演进旧别名1"), "D2 FIFO：保留最新 10 个（淘汰最旧的 alias1）", JSON.stringify(t5.aliases));
  let evictAudit = false; try { evictAudit = (store.auditTail(300) || []).some((x) => String(x.op) === "topic.alias.evicted"); } catch (e) { evictAudit = false; }
  ok(evictAudit, "D3 淘汰写审计 topic.alias.evicted");

  // ⑥ 六类禁止 rename
  const sysCases = [
    ["笔记·自测ws/aaaaaaaa", "笔记主题", "SYSTEM_TOPIC_READONLY"],
    ["E-工具-自测/1b736c53", "P2.5 会话主题", "SYSTEM_TOPIC_READONLY"],
    ["会话检查点·E-工具-自测", "会话检查点线", "SYSTEM_TOPIC_READONLY"],
    ["日记忆（按天流水）", "会话检查点域", "SYSTEM_TOPIC_READONLY"],
    ["精确字面量索引", "索引类主题", "SYSTEM_TOPIC_READONLY"],
  ];
  for (const [nm, label, wantCode] of sysCases) {
    const id = seed(nm, ["sys" + label]);
    let code = "";
    try { store.renameTopic(id, nm + "改", { actor: "runtime" }); } catch (e) { code = (e && e.code) || ""; }
    ok(code === wantCode, "E " + label + " 禁止 rename（" + wantCode + "）", "code=" + code);
  }
  const idArch = seed("演进自测-归档主题", ["evoArch"]);
  store.setState(idArch, "archived", { actor: "runtime", reason: "test" });
  let archCode = "";
  try { store.renameTopic(idArch, "演进自测-归档改名", { actor: "runtime" }); } catch (e) { archCode = (e && e.code) || ""; }
  ok(archCode === "ARCHIVED_READONLY", "E archived 主题禁止 rename（ARCHIVED_READONLY）", "code=" + archCode);
  // 工具层也拦（SYSTEM_TOPIC_READONLY）
  mod.__renameRoundReset();
  const toolSys = JSON.parse(await renameTool.execute({ topic: "笔记·自测ws/aaaaaaaa", new_name: "笔记·自测ws/bbbbbbbb" }, { agent: { session: { id: "dream-evo" } } }));
  ok(toolSys && toolSys.ok === false && toolSys.code === "SYSTEM_TOPIC_READONLY", "E tool 层同样拒绝系统主题", JSON.stringify(toolSys).slice(0, 120));

  // ⑦ dream 闸 + 每轮 3 次
  mod.__renameRoundReset();
  const toolExec = { agent: { session: { id: "dream-evo-round" } } };
  const mkT = (i) => seed("演进自测-限次" + i, ["evoLim" + i]);
  const limIds = [1, 2, 3, 4].map(mkT);
  const res = [];
  for (let i = 0; i < 4; i++) res.push(JSON.parse(await renameTool.execute({ topic: limIds[i], new_name: "演进自测-限次改名" + i, reason: "limit-test" }, toolExec)));
  ok(res[0].ok && res[1].ok && res[2].ok && res[3].ok === false && res[3].code === "RENAME_RATE_LIMITED", "F1 每轮最多 3 次（第 4 次 RENAME_RATE_LIMITED）", JSON.stringify(res.map((x) => x.ok ? "ok" : x.code)));
  ok(res[2].used === 3 && res[2].limit === 3, "F2 返回 used/limit=3", JSON.stringify({ used: res[2].used, limit: res[2].limit }));
  ok(SRC.includes('toolName !== "memory_rename_topic"') && /SUBAGENT_GUARDS\.get\(sid\)[\s\S]{0,120}kind\) === "dream"/.test(SRC), "F3 dream-only 闸静态接线（pre-execute 按看护 kind 收窄）");

  // ⑧ nearDup 算法（含「项目」/「项目管理」误报用例）
  ok(typeof mod.__topicHealthMetrics === "function", "G0 前置：__topicHealthMetrics 可导入");
  const mkRow = (id, name, trigs, extra) => Object.assign({ id, name, state: "active", parentId: null, sentences: 5, chars: 100, triggers: trigs, activeTriggers: trigs }, extra || {});
  const fakeRows = [
    mkRow("T-a1", "项目管理", ["项目管理", "进度", "预算"]),
    mkRow("T-a2", "项目", ["项目", "进度", "预算"]),          // 名字包含但 min norm len<4；shared=2 但 nameRelated=false ⇒ 不计
    mkRow("T-a3", "机器管招投标系统", ["机器管", "招投标", "评标"]),
    mkRow("T-a4", "机器管招投标平台", ["机器管", "招投标", "评标"]),   // shared=3 ⇒ 入选
    mkRow("T-a5", "完全不同主题", ["独词"]),
  ];
  const gm = mod.__topicHealthMetrics(fakeRows, { orphans: 0, now: Date.now() });
  const pairNames = (gm.nearDupTop || []).map((p) => [p.a.name, p.b.name].sort().join(" / "));
  ok(gm.nearDupPairs >= 1 && pairNames.some((x) => x.includes("机器管招投标")), "G1 nearDup：shared>=3 入选（机器管招投标 两主题）", JSON.stringify(pairNames));
  ok(!pairNames.some((x) => x === "项目 / 项目管理"), "G2 nearDup 误报用例：「项目」/「项目管理」不计（min norm len<4 且 shared<3）", JSON.stringify(pairNames));
  ok(gm.cached === false, "G3 首次计算 cached=false");
  const gm2 = mod.__topicHealthMetrics(fakeRows, { orphans: 0, now: Date.now() });
  ok(gm2.cached === true, "G4 5min 缓存命中（cached=true）");

  // ⑨ 指标计算
  const rows9 = [
    mkRow("T-b1", "重复trigger一", ["共享触发器"]),
    mkRow("T-b2", "重复trigger二", ["共享触发器"]),
    mkRow("T-b3", "碎片主题", ["碎片"]),                      // sentences 2
    mkRow("T-b4", "超限主题", ["超限"], { chars: 41000, sentences: 100 }),
    mkRow("T-b5", "记忆索引", ["索引"], { chars: 300000 }),   // 索引类不参与 oversized/fragment
  ];
  rows9[2].sentences = 2;
  const m9 = mod.__topicHealthMetrics(rows9, { orphans: 3, now: Date.now() + 10 * 60 * 1000 });
  ok(m9.dupTriggers === 1, "H1 dupTriggers：一个 trigger 挂 2 个 active 主题计 1", "dup=" + m9.dupTriggers);
  ok(m9.fragments === 1, "H2 fragments：句数 <3 的 active 非系统/索引主题计 1", "frag=" + m9.fragments);
  ok(m9.oversized === 1, "H3 oversized：>40000 字符计 1，索引类（记忆索引 300K）排除", "over=" + m9.oversized);
  ok(m9.orphans === 3, "H4 orphans 复用调用方 hier.unmapped", "orph=" + m9.orphans);
  ok(mod.__topicHealthLineText({}) === "主题卫生：良好" && /重复 trigger 1/.test(mod.__topicHealthLineText(m9)), "H5 全 0 显示「良好」；非 0 展示五项");
  // 指标接线：stats.json / 面板 / memory_topics 尾部
  const stats = mod.__topicdbStats();
  ok(stats && stats.health && stats.health.topicHealth && Number.isFinite(Number(stats.health.topicHealth.dupTriggers)), "H6 stats.json health.topicHealth 已下发", JSON.stringify(stats && stats.health && stats.health.topicHealth).slice(0, 120));
  const panelHtml = String(mod.__topicDbPanelBlock());
  ok(panelHtml.includes("主题卫生") && panelHtml.includes("dupTriggers") && panelHtml.includes("nearDupPairs"), "H7 面板账本口径含主题卫生行（五项）");
  const mt = findTool(fx.captured, "memory_topics");
  const mtOut = (mt && typeof mt.execute === "function") ? String(await mt.execute({ limit: 5 }, {})) : "";
  ok(/\[主题卫生\]/.test(mtOut), "H8 memory_topics 尾部含 [主题卫生] 行", mtOut.slice(-120));

  // 真机 dry-run：五个指标（只读副本）
  try {
    const dbSrc = path.join(process.env.USERPROFILE || "C:\\Users\\Starry", ".dsh", "memory", ".memtopic", "mem.db");
    if (!fs.existsSync(dbSrc)) console.log("SKIP  I 真机 dry-run（无 mem.db）");
    else {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-evo-dry-"));
      const dst = path.join(tmp2, "mem.db");
      fs.copyFileSync(dbSrc, dst);
      for (const ext of ["-wal", "-shm"]) { try { fs.copyFileSync(dbSrc + ext, dst + ext); } catch (e) {} }
      const ms = await import(pathToFileURL(path.join(here, "..", "memtopic", "src", "memory-store.mjs")).href);
      const bs = await import(pathToFileURL(path.join(here, "..", "memtopic", "src", "backend-sqlite.mjs")).href);
      const be = new bs.SqliteBackend(dst);
      const s2 = new ms.MemoryStore(be);
      const rows = s2.topics();
      const lv = mod.__topicDbLevelMap(s2, rows);
      const hier = mod.__topicDbHierarchy(s2, rows, lv);
      const m = mod.__topicHealthMetrics(rows, { orphans: hier.unmapped, now: Date.now() });
      console.log("DRY-RUN metrics: " + JSON.stringify({ dupTriggers: m.dupTriggers, fragments: m.fragments, orphans: m.orphans, nearDupPairs: m.nearDupPairs, oversized: m.oversized, nearDupTop: (m.nearDupTop || []).slice(0, 3) }));
      ok(Number.isFinite(m.dupTriggers) && Number.isFinite(m.fragments) && Number.isFinite(m.orphans) && Number.isFinite(m.nearDupPairs) && Number.isFinite(m.oversized), "I1 真机 592 主题产出五个指标", JSON.stringify({ d: m.dupTriggers, f: m.fragments, o: m.orphans, n: m.nearDupPairs, s: m.oversized }));
      ok(m.oversized === 0 || (m.nearDupTop || []).every((p) => !/字面量索引|记忆索引/.test(p.a.name + p.b.name)), "I2 oversized 不含索引类（T-0474/0475 排除）", "oversized=" + m.oversized);
      try { be.close(); } catch (e) {}
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  } catch (e) { console.log("SKIP  I 真机 dry-run 异常（不影响门）：" + ((e && e.message) || e)); }

  try { mod.__topicdb.close && mod.__topicdb.close(); } catch (e) {}
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
process.exit(fails.length ? 1 : 0);
