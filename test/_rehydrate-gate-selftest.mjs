// _rehydrate-gate-selftest.mjs —— Plan E：压缩后重灌 gate 移到 next() 之后 + 追加 decision.messages 自测
//
// 跑法：node test/_rehydrate-gate-selftest.mjs
//
// 依据：CRA 2026-11-07 seq 证据（66482 summary → 66485 step14 start 未等待）：gate 在 compaction 处理前已执行，
//   「next() 前 await pending」只能拦下一拍。Plan E：next() 之后 await，把重灌文本 append 进 decision.messages。
// 覆盖：
//   A 静态接线（gate 返回 text / 顺序 / rec 字段 / 注入写 text / finally 清理）
//   B 行为（__p4Hooks）：① 返回非空 text ② 超时返回空串不悬挂 ③ waiters 不重复等待 ④ append 一次不重复 ⑤ finally 清理
//   C seq 判据：mock host 下 compaction/end < 重灌 inbox < step/start
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const SRC = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) { try { if (fn()) return true; } catch (e) { /* 继续 */ } await sleep(step || 100); }
  return false;
}

// ── A. 静态接线 ─────────────────────────────────────────────────────────
const iNext = SRC.indexOf("const decision = await next();");
const iGateAfter = SRC.indexOf("const _p4Text = await p4AwaitPendingRehydrate(agent, signal);");
const iGateCall = SRC.indexOf("await p4AwaitPendingRehydrate(agent, signal)");
const iBeforeNext = SRC.indexOf("await p4AwaitPendingRehydrate(agent, signal);\n        const decision = await next();");
ok(iNext > 0 && iGateAfter > iNext && iBeforeNext < 0, "A1 gate 调用已移到 next() 之后（旧的 next() 前调用已不存在）", "next@" + iNext + " gate@" + iGateAfter);
ok(/const _p4Text = await p4AwaitPendingRehydrate\(agent, signal\);/.test(SRC) && /_msgs\.push\(makeMessage\(_p4Text\)\)/.test(SRC), "A2 重灌文本 append 进 decision.messages");
ok(/【压缩后记忆重灌（dsh-memory）】/.test(SRC) && /_dup/.test(SRC), "A3 append 前按重灌 head 去重");
ok(/return text;/.test(SRC) && /const text = \(rec && typeof rec\.text === "string"\) \? rec\.text : "";/.test(SRC), "A4 gate 返回 text（拿不到返回空串）");
ok(/gateTimedOut === true\) return ""/.test(SRC) && /rec\.gateTimedOut = true/.test(SRC), "A5 gateTimedOut：超时只等一次");
ok(/rec\.waiters = \(Number\(rec\.waiters\) \|\| 0\) \+ 1;/.test(SRC) && /textDelivered === true\) return ""/.test(SRC), "A6 waiters 计数 + textDelivered 去重");
const iText = SRC.indexOf("_p4Rec.text = (rehydrate && rehydrate.text)");
const iInject = SRC.indexOf("targetAgent.inject(makeMessage(finalNote));");
ok(iText > 0 && iInject > iText, "A7 注入前先写 rec.text（gate 才能读到）", "text@" + iText + " inject@" + iInject);
ok(/text: "",\s*waiters: 0,\s*gateTimedOut: false,\s*textDelivered: false,/.test(SRC), "A8 PENDING rec 含 text/waiters/gateTimedOut/textDelivered");
const iFin = SRC.indexOf("finally {\n              // [starry 2026-11-05 拦截式重灌]");
ok(/PENDING_REHYDRATE\.delete\(String\(session\.id\)\)/.test(SRC) && /if \(_p4ResolvePending\) _p4ResolvePending\(\)/.test(SRC), "A9 finally 必 delete + 必 resolve（防悬挂）");
ok(/clearTimeout\(_timer\)/.test(SRC), "A10 gate 内部 timer 必清（不拖事件循环）");
ok(SRC.indexOf("let POST_COMPACT_WAIT_MS = 120000;") >= 0, "A11 等待上限可被测试钩子调整（生产 120s）");

// ── B/C. 行为（真实 apply + __p4Hooks）──────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-p4gate-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
fs.mkdirSync(path.join(MEM, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(MEM, "sessions"), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# g\n");
fs.writeFileSync(path.join(MEM, "index.md"), "# i\n");
fs.writeFileSync(path.join(MEM, ".monitor.json"), "{}");
process.env.DSH_HOME = HOME;
process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, ".memtopic", "mem.db");
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);
const { createFixtureCtx } = await import(pathToFileURL(path.join(PLUGIN, "_fixture-ctx.mjs")).href);
const fx = createFixtureCtx({});
mod.default.apply(fx.ctx, { memoryTopicDbEnabled: true });
const ready = await waitFor(() => mod.__topicdb && mod.__topicdb.ready && mod.__topicdb.store, 20000, 100);
ok(ready, "B0 前置：主题库就绪");
const H = mod.__p4Hooks || {};
ok(typeof H.awaitPending === "function" && typeof H.pendingSet === "function", "B0b 前置：P4 gate 测试钩子已接线");

const HEAD = "【压缩后记忆重灌（dsh-memory）】";
function mkRec(text, resolveAfterMs) {
  let resolve = null;
  const promise = new Promise((r) => { resolve = r; });
  const rec = { compactionId: "cmp-test", promise, at: Date.now(), text: text || "", waiters: 0, gateTimedOut: false, textDelivered: false };
  if (typeof resolveAfterMs === "number") setTimeout(() => { try { resolve(); } catch (e) { /* noop */ } }, resolveAfterMs);
  else if (resolveAfterMs !== null) { try { resolve(); } catch (e) { /* noop */ } }
  return { rec, resolve };
}

if (typeof H.awaitPending === "function") {
  // ① gate 返回非空 text
  const a = mkRec(HEAD + " AAA", 0);
  H.pendingSet("sid-gate-1", a.rec);
  const t1 = await H.awaitPending({ session: { id: "sid-gate-1" } }, null);
  ok(t1 === HEAD + " AAA", "B1 gate 返回重灌 text", String(t1).slice(0, 40));
  ok(a.rec.waiters === 1, "B2 waiters 计数 = 1", String(a.rec.waiters));
  const t1b = await H.awaitPending({ session: { id: "sid-gate-1" } }, null);
  ok(t1b === "" && a.rec.textDelivered === true, "B3 同一份重灌只交付一次（textDelivered 去重）");
  H.pendingDel("sid-gate-1");

  // ② 超时返回空串、不悬挂、后续不再等
  H.setWaitMs(60);
  try {
    const b = mkRec(HEAD + " BBB", null);   // promise 永不 resolve
    H.pendingSet("sid-gate-2", b.rec);
    const t0 = Date.now();
    const t2 = await H.awaitPending({ session: { id: "sid-gate-2" } }, null);
    const dt = Date.now() - t0;
    ok(t2 === "" && dt >= 40 && dt < 1500, "B4 超时返回空串且不悬挂", "dt=" + dt + "ms");
    ok(b.rec.gateTimedOut === true, "B5 超时后 gateTimedOut=true（只等一次）");
    const t0b = Date.now();
    const t2b = await H.awaitPending({ session: { id: "sid-gate-2" } }, null);
    ok(t2b === "" && (Date.now() - t0b) < 30, "B6 超时后再次调用立即返回（不重复等待）", "dt=" + (Date.now() - t0b) + "ms");
    H.pendingDel("sid-gate-2");
  } finally { H.setWaitMs(120000); }

  // ③ 并发 waiters：不重复等待、只交付一次
  const c = mkRec(HEAD + " CCC", 40);
  H.pendingSet("sid-gate-3", c.rec);
  const [r1, r2] = await Promise.all([
    H.awaitPending({ session: { id: "sid-gate-3" } }, null),
    H.awaitPending({ session: { id: "sid-gate-3" } }, null),
  ]);
  const got = [r1, r2].filter((x) => x === HEAD + " CCC").length;
  ok(got === 1 && c.rec.waiters === 2, "B7 并发 2 个 waiter：只交付一次、waiters=2", "delivered=" + got + " waiters=" + c.rec.waiters);
  H.pendingDel("sid-gate-3");

  // ④ pre-step 集成：next() 后 append 一次、不重复
  const preStep = (fx.captured.handlers || []).find((h) => h.event === "agent/pre-step");
  ok(!!(preStep && typeof preStep.fn === "function"), "B8 前置：agent/pre-step handler 可取到");
  if (preStep) {
    const fakeAgent = { session: { id: "sid-gate-4", header: { origin: "main", cwd: TMP } }, inject() { /* noop */ } };
    const d = mkRec(HEAD + " DDD", 0);
    H.pendingSet("sid-gate-4", d.rec);
    const next1 = async () => ({ kind: "enter", messages: [] });
    const dec1 = await preStep.fn({ agent: fakeAgent, messages: [], step: 99, signal: null }, next1);
    const arr1 = (dec1 && dec1.messages) || [];
    const has1 = arr1.some((m) => JSON.stringify(m && (m.content || m.text)).indexOf(HEAD) >= 0);
    ok(has1 && arr1.length === 1, "B9 pre-step 在 decision.messages 里 append 重灌一次", "msgs=" + arr1.length);
    H.pendingDel("sid-gate-4");
    // 已含重灌 head 的 decision 不再 append
    const d2 = mkRec(HEAD + " EEE", 0);
    H.pendingSet("sid-gate-4", d2.rec);
    const next2 = async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: HEAD + " 已有" }] }] });
    const dec2 = await preStep.fn({ agent: fakeAgent, messages: [], step: 99, signal: null }, next2);
    const arr2 = (dec2 && dec2.messages) || [];
    const headCount = arr2.filter((m) => JSON.stringify(m && (m.content || m.text)).indexOf(HEAD) >= 0).length;
    ok(headCount === 1, "B10 已有重灌 head 时不重复 append（去重）", "headCount=" + headCount);
    H.pendingDel("sid-gate-4");

    // ⑤ finally 清理（静态已断言；这里验证 delete 后 pendingSize 回落）
    H.pendingDel("sid-gate-4");
    ok(H.pendingSize() === 0, "B11 pending 清理后 size=0（无残留）", "size=" + H.pendingSize());

    // ⑥ seq 判据：mock host —— compaction/end < 重灌 inbox < step/start
    const seqs = [];
    seqs.push("compaction/end");
    const f = mkRec("", null);   // 不自动 resolve：等模拟注入写完 text 再 resolve
    // 模拟注入：30ms 后写 text + 记 inbox seq，再 resolve（等价真实 finally 前 inject）
    f.rec.text = "";
    setTimeout(() => { f.rec.text = HEAD + " SEQ"; seqs.push("rehydrate/inbox"); try { f.resolve(); } catch (e) { /* noop */ } }, 30);
    H.pendingSet("sid-gate-5", f.rec);
    const next3 = async () => ({ kind: "enter", messages: [] });
    const dec3 = await preStep.fn({ agent: { session: { id: "sid-gate-5", header: { origin: "main" } } }, messages: [], step: 99, signal: null }, next3);
    seqs.push("step/start");   // 宿主只有在 pre-step waterfall 返回后才会发 step/start
    const seqText = (dec3.messages || []).some((m) => JSON.stringify(m && (m.content || m.text)).indexOf(HEAD + " SEQ") >= 0);
    ok(seqText, "C1 当前 step 的 decision.messages 含重灌内容");
    ok(seqs.indexOf("compaction/end") < seqs.indexOf("rehydrate/inbox") && seqs.indexOf("rehydrate/inbox") < seqs.indexOf("step/start"),
      "C2 seq 判据：compaction/end < 重灌 inbox < step/start", seqs.join(" < "));
    H.pendingDel("sid-gate-5");
  }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
