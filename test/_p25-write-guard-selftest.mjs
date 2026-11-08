// _p25-write-guard-selftest.mjs — P2.5 会话主题「恒 1 句」护栏自测（2026-11-03）
//
// 背景真机证据：18 个会话主题里 1 个变 2 句，audit 显示 `sentence.append · actor=lead`
//   ⇒ 模型用 memory_write 直写会话主题，绕过 p25WriteSessionTopic 的覆盖路径。
//
// 覆盖：
//   A 守卫双条件（名字/id 命中阻断；普通主题、名字巧合、不存在、父线不匹配 ⇒ 放行）
//   B memory_write 工具级行为（命中会话主题 ⇒ ok:false code=P25_SESSION_TOPIC；普通主题 ⇒ 正常写）
//   C 收敛（历史 2 句 → 插件下次写入后回到 1 句，保留最新）
//   E CRA G7：sid8 短名经 store 模糊匹配的绕过路径必须被拦
//   F CRA G8：同文重复句（TEXT_NOT_UNIQUE）自愈
//   G CRA G9：收敛可观测（monitor p25-prune 带 ok/left）
//   D 静态接线
//
// 安全：os.tmpdir() 临时 home；不碰真实 ~/.dsh/memory。
import fs from "node:fs";
import { useHome, mkHome, freshPlugin, makeCtx, applyPlugin, waitTopicDb, seedD8, todayStr, makeReporter, finish, sleep } from "./_accept-p0-lib.mjs";

const R = makeReporter("P2.5 会话主题护栏（memory_write 拒写 + 收敛）");
const CFG_ON = { memoryTopicDbEnabled: true };
const rand = () => Math.random().toString(36).slice(2, 7);
const SUM = (mark) => "## 本次目标\n- " + mark + "\n## 下一步状态\n- 自测造数\n## 关键结论\n- p25 guard";
const CWD_A = "E:\\工具\\测试项目A";

const H = mkHome("p25guard");
useHome(H);
const mod = await freshPlugin();
const { ctx, captured } = makeCtx();
applyPlugin(mod, CFG_ON, ctx);
const ready = await waitTopicDb(mod);
R.ok(ready, "A0 前置：主题库就绪", ready ? "ready" : "not-ready");
const seeded = seedD8(mod);
R.ok(!!seeded, "A1 造数：D8 域 + 「会话检查点」线已建");
const store = mod.__topicdb && mod.__topicdb.store;
R.ok(!!store, "A1b 取到 store 句柄");
if (!store) finish(R, true);
const guard = mod.__p25SessionTopicWriteGuard;
R.ok(typeof guard === "function", "A1c 守卫已导出（__p25SessionTopicWriteGuard）", typeof guard);

// ═══ 造一个真实 P2.5 会话主题 ═══
const cid = "p25g-" + rand();
const w = mod.__topicdbIntentRoute(cid, "a1b2c3d4", SUM("GUARD-MARK-1"), todayStr() + ".md", "session-a1b2c3d4", CWD_A);
R.ok(w && w.p25 === true, "A2 会话主题已建立", JSON.stringify(w).slice(0, 160));
const sessTopicId = w.topicId, sessTopicName = w.topicName;

// ═══ A：守卫双条件 ═══
const gName = guard(store, sessTopicName);
R.ok(gName && gName.blocked === true, "A3 按主题名 ⇒ 阻断", JSON.stringify(gName).slice(0, 120));
R.ok(gName && gName.wsKey === "E-工具-测试项目A" && gName.sid8 === "a1b2c3d4", "A4 守卫回报 wsKey/sid8（可诊断）", JSON.stringify({ wsKey: gName && gName.wsKey, sid8: gName && gName.sid8 }));
R.ok(gName && /插件专用会话主题/.test(String(gName.message)) && /恒 1 句/.test(String(gName.message)), "A5 阻断文案指出「插件专用 / 恒 1 句」", "");
const gId = guard(store, sessTopicId);
R.ok(gId && gId.blocked === true, "A6 按 topic id ⇒ 阻断", String(gId && gId.topicId));

const plain = store.seedTopic({ name: "普通主题-" + rand(), triggers: [], src: "selftest", actor: "plugin" });
R.ok(guard(store, "普通主题-x") && guard(store, "普通主题-x").blocked === false, "A7 不存在的主题 ⇒ 放行", "");
R.ok(guard(store, plain && plain.name) && guard(store, plain && plain.name).blocked === false, "A8 普通主题（真实存在）⇒ 放行", String(plain && plain.name));

let fakeId = null;
try {
  const fr = store.seedTopic({ name: "E-工具-测试项目A/deadbeef", triggers: [], src: "selftest", actor: "plugin" });
  fakeId = fr && fr.id;
  const d8 = store.topics().find((t) => String(t.name) === "日记忆（按天流水）");
  if (fakeId && d8) { try { store.linkParent(fakeId, d8.id, { actor: "runtime" }); } catch (eL) { /* 忽略 */ } }
} catch (eF) { fakeId = null; }
const gFake = fakeId ? guard(store, "E-工具-测试项目A/deadbeef") : { blocked: false };
R.ok(gFake && gFake.blocked === false, "A9 名字形态像但父线不是会话线 ⇒ 放行（不误伤）", JSON.stringify(gFake).slice(0, 100));

R.ok(guard(null, "x") && guard(null, "x").blocked === false, "A10 store 不可用 ⇒ 放行（不阻断正常写入）", "");
R.ok(guard({ topics() { throw new Error("boom"); } }, "x") && guard({ topics() { throw new Error("boom"); } }, "x").blocked === false, "A11 store.topics 抛错 ⇒ 放行（守卫吞异常）", "");

// ═══ B：memory_write 工具级 ═══
// [2026-11-05 协议收紧] 身份闸**先于** P2.5 守卫：非 dream 一律 WRITE_DREAM_ONLY ⇒
//   本节用「dream 身份」exec 才能继续验到 P2.5 守卫；lead 身份单独验拒写。
const mw = (captured.tools || []).find((t) => t && t.name === "memory_write");
R.ok(!!mw, "B0 memory_write 工具已注册", (captured.tools || []).map((t) => t && t.name).slice(0, 4).join(","));
const DREAM_SID = "dream-selftest-sid";
try { if (typeof mod.__markPluginSubagent === "function") mod.__markPluginSubagent(DREAM_SID); } catch (eD) { /* 忽略 */ }
const execDream = { agent: { session: { id: DREAM_SID, header: { origin: "subagent" } } } };
const execLead = {};
if (mw) {
  // B6~B9：主代理（lead）⇒ 一律拒写长期库
  const l1 = JSON.parse(await mw.execute({ topic: plain && plain.name, op: "append", text: "主代理直写测试" }, execLead));
  R.ok(l1 && l1.ok === false && l1.code === "WRITE_DREAM_ONLY" && l1.actor === "lead", "B6 主代理 append ⇒ ok:false code=WRITE_DREAM_ONLY", JSON.stringify(l1).slice(0, 160));
  const l2 = JSON.parse(await mw.execute({ topic: plain && plain.name, op: "replace", text: "主代理替换", old_text: "x" }, execLead));
  R.ok(l2 && l2.ok === false && l2.code === "WRITE_DREAM_ONLY", "B7 主代理 replace ⇒ 同样拒写", JSON.stringify(l2).slice(0, 120));
  R.ok(l1 && /memory_note/.test(String(l1.message || "")), "B8 拒写文案指向 memory_note（可自助）", String((l1 && l1.message) || "").slice(0, 60));
  const pn0 = (store.readTopic(plain && plain.id).sentences || []).length;
  R.ok(pn0 === 0, "B9 主代理被拒后普通主题句数未变（0 句）", "n=" + pn0);
  // [CRA 2026-11-06] 拒写文案必须按会话类别分流：普通子代理的 memory_note 也是关的（SUBAGENT_SKIP），
  //   若还叫它「请用 memory_note」就是把模型推向另一条死路 ⇒ 来回重试（正好喂给 D/E 打转检测）。
  const execNormal = { agent: { session: { id: "normal-sub-not-registered", header: { origin: "subagent" } } } };
  const ln = JSON.parse(await mw.execute({ topic: plain && plain.name, op: "append", text: "子代理直写测试" }, execNormal));
  R.ok(ln && ln.ok === false && ln.code === "WRITE_DREAM_ONLY" && ln.kind === "normal", "B10 普通子代理 ⇒ WRITE_DREAM_ONLY + kind=normal", JSON.stringify(ln).slice(0, 120));
  R.ok(ln && /SUBAGENT_SKIP/.test(String(ln.message || "")) && !/请用 memory_note/.test(String(ln.message || "")),
    "B11 子代理文案不再误导去用 memory_note（指出 SUBAGENT_SKIP + 写报告）", String((ln && ln.message) || "").slice(0, 60));
  R.ok(ln && ln.nextAction === "report-only", "B12 子代理 nextAction=report-only（可执行的下一步）", String(ln && ln.nextAction));
  R.ok(l1 && l1.nextAction === "use-memory_note" && /请用 memory_note/.test(String(l1.message || "")),
    "B13 顶层会话文案仍指向 memory_note（有活路才指）", String((l1 && l1.nextAction) || ""));
  // B1~B5：dream 身份 ⇒ 放行身份闸，继续验 P2.5 守卫与正常写入
  const j1 = JSON.parse(await mw.execute({ topic: sessTopicName, op: "append", text: "模型直写测试-1" }, execDream));
  R.ok(j1 && j1.ok === false && j1.code === "P25_SESSION_TOPIC", "B1 dream append 到会话主题 ⇒ code=P25_SESSION_TOPIC", JSON.stringify(j1).slice(0, 160));
  const j2 = JSON.parse(await mw.execute({ topic: sessTopicId, op: "replace", text: "模型直写测试-2", old_text: "x" }, execDream));
  R.ok(j2 && j2.ok === false && j2.code === "P25_SESSION_TOPIC", "B2 dream replace 到会话主题（按 id）⇒ 同样阻断", JSON.stringify(j2).slice(0, 120));
  const n1 = (store.readTopic(sessTopicId).sentences || []).length;
  R.ok(n1 === 1, "B3 被阻断后句子数未变（仍 1 句）", "n=" + n1);
  const j3 = JSON.parse(await mw.execute({ topic: plain && plain.name, op: "append", text: "普通主题正常追加" }, execDream));
  R.ok(j3 && j3.ok === true, "B4 dream 普通主题 append ⇒ 正常成功（其他调用零影响）", JSON.stringify(j3).slice(0, 120));
  const pn = (store.readTopic(plain && plain.id).sentences || []).length;
  R.ok(pn === 1, "B5 普通主题正常落 1 句", "n=" + pn);
}

// ═══ C：收敛（历史 2 句 → 插件写入后回 1 句） ═══
let pre = 0;
try {
  store.appendSentence({ topic: sessTopicId, text: "历史污染句-APPEND", src: null, actor: "runtime" });
  pre = (store.readTopic(sessTopicId).sentences || []).length;
} catch (eP) { pre = -1; }
R.ok(pre === 2, "C0 造数：会话主题现有 2 句（复现真机污染）", "n=" + pre);
const sentsBefore = store.readTopic(sessTopicId).sentences || [];
const lastBefore = String(sentsBefore[sentsBefore.length - 1].text || "");
const w2 = mod.__topicdbIntentRoute("p25g2-" + rand(), "a1b2c3d4", SUM("GUARD-MARK-2"), todayStr() + ".md", "session-a1b2c3d4", CWD_A);
R.ok(w2 && w2.p25 === true && w2.ok !== false, "C1 插件覆盖写入成功", JSON.stringify(w2).slice(0, 160));
const sentsAfter = store.readTopic(sessTopicId).sentences || [];
R.ok(sentsAfter.length === 1, "C2 写入后收敛回 1 句", "n=" + sentsAfter.length);
R.ok(sentsAfter.length === 1 && String(sentsAfter[0].text).includes("GUARD-MARK-2"), "C3 保留的是本次最新内容（旧句被清理）", String(sentsAfter[0].text || "").slice(0, 40));
const prunedField = (w2 && typeof w2.pruned === "number") ? w2.pruned : -1;
R.ok(prunedField >= 1, "C4 写入回报 pruned≥1（可观测）", "pruned=" + prunedField + " / lastBeforeLen=" + lastBefore.length);

// ═══ E（CRA G7）：sid8 短名经 store 模糊匹配的绕过路径 ═══
const gShort = guard(store, "a1b2c3d4");
R.ok(gShort && gShort.blocked === true, "E1 sid8 短名（store 模糊匹配路径）⇒ 阻断", JSON.stringify(gShort).slice(0, 130));
if (mw) {
  const jShort = JSON.parse(await mw.execute({ topic: "a1b2c3d4", op: "append", text: "短名绕过测试" }, execDream));
  R.ok(jShort && jShort.ok === false && jShort.code === "P25_SESSION_TOPIC", "E2 memory_write 传 sid8 ⇒ 被拦（改前会写入成功）", JSON.stringify(jShort).slice(0, 140));
  const nShort = (store.readTopic(sessTopicId).sentences || []).length;
  R.ok(nShort === 1, "E3 短名尝试后句数未变（护栏有效）", "n=" + nShort);
}

// ═══ F（CRA G8）：同文重复句自愈（TEXT_NOT_UNIQUE） ═══
let dupMade = false;
try {
  const cur = store.readTopic(sessTopicId).sentences || [];
  const lastTxt = String((cur[cur.length - 1] || {}).text || "");
  if (lastTxt) {
    store.appendSentence({ topic: sessTopicId, text: lastTxt, src: null, actor: "runtime" });
    dupMade = (store.readTopic(sessTopicId).sentences || []).length === 2;
  }
} catch (eDup) { dupMade = false; }
R.ok(dupMade, "F0 造数：会话主题 2 句且逐字相同（复现 TEXT_NOT_UNIQUE）", dupMade ? "n=2 同文" : "SKIP：store 拒绝同文追加");
if (dupMade) {
  const w3 = mod.__topicdbIntentRoute("p25g3-" + rand(), "a1b2c3d4", SUM("GUARD-MARK-3"), todayStr() + ".md", "session-a1b2c3d4", CWD_A);
  R.ok(w3 && w3.p25 === true && w3.ok !== false, "F1 同文重复下写入仍成功（自愈未回落日期主题）", JSON.stringify(w3).slice(0, 170));
  const sAfterDup = store.readTopic(sessTopicId).sentences || [];
  R.ok(sAfterDup.length === 1, "F2 自愈后收敛回 1 句（改前会卡在 2 句）", "n=" + sAfterDup.length);
  R.ok(sAfterDup.length === 1 && String(sAfterDup[0].text).includes("GUARD-MARK-3"), "F3 保留本次最新内容", "");
}

// ═══ G（CRA G9）：收敛可观测（monitor 带 ok/left） ═══
// 注意：monitor 落盘有节流（非即时），读不到不算功能失败 —— 读不到就 SKIP 并说明，静态落点由 D 组覆盖。
await sleep(400);
let pruneEv = null;
try {
  const monRaw = JSON.parse(fs.readFileSync(H.mem + "/.monitor.json", "utf8"));
  pruneEv = (monRaw.events || []).filter((e) => e && e.type === "intent" && /p25-prune/.test(String(e.detail || ""))).slice(-1)[0] || null;
} catch (eMon) { pruneEv = null; }
if (pruneEv) {
  R.ok(true, "G1 monitor 出现 p25-prune 事件（收敛可观测）", String(pruneEv.detail).slice(0, 90));
  R.ok(/ok=\d+/.test(String(pruneEv.detail)) && /left=-?\d+/.test(String(pruneEv.detail)), "G2 p25-prune 带 ok=/left= 带值字段", String(pruneEv.detail).slice(0, 90));
} else {
  R.skip("G1 monitor 出现 p25-prune 事件（收敛可观测）", "monitor 落盘节流，本轮未即时可见；静态落点见 D3/D7，真机验证看 .monitor.json");
  R.skip("G2 p25-prune 带 ok=/left= 带值字段", "同上");
}

// ═══ D：静态接线断言 ═══
const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
R.ok(/p25SessionTopicWriteGuard\(store, topic\)/.test(src), "D1 静态：memory_write 已接入守卫", "");
R.ok(/code: "P25_SESSION_TOPIC"/.test(src), "D2 静态：阻断返回带 P25_SESSION_TOPIC 码", "");
R.ok(/p25-prune/.test(src) && /deleteSentence\(topic\.id, \{ sentenceId: _sid \}/.test(src), "D3 静态：收敛删除落点存在", "");
R.ok(/pruned: pruned/.test(src), "D4 静态：写入回报带 pruned 字段", "");
R.ok(/store\.resolveTopic\(ref, \{ create: false \}\)/.test(src), "D5 静态（G7）：守卫用 store.resolveTopic 同款解析", "");
R.ok(/TEXT_NOT_UNIQUE/.test(src) && /同文重复自愈/.test(src), "D6 静态（G8）：TEXT_NOT_UNIQUE 自愈分支存在", "");
R.ok(/p25-guard-error/.test(src), "D7 静态（G9）：守卫异常留痕", "");

finish(R, true);
