// _note-migrate-selftest.mjs —— 4.5.2 笔记收敛迁移脚本（tools/migrate-note-compact.mjs）自测
//
// 跑法：node test/_note-migrate-selftest.mjs
//
// 重点覆盖「已提炼 N 句」口径（真机 T-0560 修复）：
//   已提炼句数 = marker 之前的 live 句数 + 该主题墓碑数（meta.deleted.index 每条带 topicId；
//   删除只来自收敛/迁移且为软删除 ⇒ 可考；写 0 会往库里留假数据）
// 另覆盖：只迁「最后一句是 legacy marker」/ 墓碑过滤 / 幂等 / --dry-run 不写库 / --apply --force 单事务 + 备份。
//
// 隔离：临时 DSH_HOME + 临时 mem.db（os.tmpdir），跑完删除；不碰真实库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..");
const SCRIPT = path.join(PLUGIN, "tools", "migrate-note-compact.mjs");
let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  —  " + detail : "")); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-note-migrate-"));
const MEM = path.join(TMP, "memory");
const DB = path.join(MEM, ".memtopic", "mem.db");
fs.mkdirSync(path.dirname(DB), { recursive: true });

const storeMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "memory-store.mjs")).href);
const backendMod = await import(pathToFileURL(path.join(PLUGIN, "memtopic", "src", "backend-sqlite.mjs")).href);
const be = new backendMod.SqliteBackend(DB);
const store = new storeMod.MemoryStore(be);
function mk(name) {
  const r = store.createTopic({ name: name, actor: "runtime", confirm: true });
  const id = r.id || r.topic.id;
  try { store.setState(id, "active", { actor: "runtime" }); } catch (e) { /* 忽略 */ }
  return id;
}
function append(tid, text) { store.appendSentence({ topic: tid, text: text, actor: "runtime" }); }
function tombstone(tid, n) {
  const rows = store.readTopic(tid).sentences;
  for (const s of rows.slice(0, n)) store.deleteSentence(tid, { sentenceId: s.id }, { actor: "runtime", reason: "selftest" });
}

// A：marker 前 2 live + 3 墓碑 ⇒ 应为「已提炼 5 句」
const A = mk("笔记·MIGCNT-WS/aaaaaaaa");
["待删1", "待删2", "待删3"].forEach((t) => append(A, t));
append(A, "live旧1"); append(A, "live旧2");
append(A, "已提炼 → T-0100（2026-11-05 dream：旧文本）");
tombstone(A, 3);
// B：marker 前 0 live + 4 墓碑（T-0560 形态）⇒ 应为「已提炼 4 句」
const B = mk("笔记·MIGCNT-WS/bbbbbbbb");
for (let i = 0; i < 4; i++) append(B, "已提炼旧句" + i);
append(B, "已提炼 → T-0200（2026-11-06 dream）");
tombstone(B, 4);
// C：marker 不在最后（部分提炼）⇒ 不迁
const C = mk("笔记·MIGCNT-WS/cccccccc");
append(C, "已提炼 → T-0300（dream）"); append(C, "部分提炼后的新句");
// D：已是严格指针 ⇒ 不迁
const D = mk("笔记·MIGCNT-WS/dddddddd");
append(D, "2026-11-06 已提炼 7 句 → T-0400（原文 session_search sid8=dddddddd 可回溯）");
try { be.db.close(); } catch (e) { /* noop */ }

const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: PLUGIN }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
};

// 1) dry-run：不写库；对账表含「已提炼 N 句」列；A=5、B=4、C/D 跳过
const dry = run(["--db", DB]);
ok(dry.code === 0, "A1 dry-run 退出 0");
ok(/已提炼 5 句/.test(dry.out) && /已提炼 4 句/.test(dry.out), "A2 对账表打出句数：A=5、B=4（marker 前 live + 墓碑）", dry.out.split("\n").filter((l) => /句 \d+ →/.test(l)).join(" / ").slice(0, 160));
ok(/待迁移 2/.test(dry.out), "A3 只迁 2 个（C 部分提炼 / D 严格指针跳过）", (dry.out.match(/笔记主题总数：[^\n]*/) || [""])[0]);
const beCheck = new backendMod.SqliteBackend(DB);
const storeCheck = new storeMod.MemoryStore(beCheck);
ok(storeCheck.readTopic(A).sentences.some((s) => String(s.text).indexOf("已提炼 → T-0100") >= 0), "A4 dry-run 未写库（legacy marker 原样）");
try { beCheck.db.close(); } catch (e) { /* noop */ }

// 2) apply（宿主检测：--force 跳过；临时库无 DSH 写入）
const app = run(["--db", DB, "--apply", "--force"]);
ok(app.code === 0, "B1 --apply --force 退出 0", app.out.split("\n").filter((l) => /已迁移|复核/.test(l)).join(" | "));
const be2 = new backendMod.SqliteBackend(DB);
const store2 = new storeMod.MemoryStore(be2);
const textA = (store2.readTopic(A).sentences || []).map((s) => String(s.text));
const textB = (store2.readTopic(B).sentences || []).map((s) => String(s.text));
ok(textA.length === 1 && /已提炼 5 句/.test(textA[0]), "B2 A 迁移后指针句数=5", textA[0]);
ok(textB.length === 1 && /已提炼 4 句/.test(textB[0]), "B3 B 迁移后指针句数=4（T-0560 形态）", textB[0]);
const STRICT = /^\d{4}-\d{2}-\d{2} 已提炼 \d+ 句 → T-\d+(?:\/T-\d+)*（[^）]*sid8=[0-9a-f]{8}[^）]*）$/;
ok(STRICT.test(textA[0]) && STRICT.test(textB[0]), "B4 迁移后指针为严格格式（含 sid8 + 句数）");
ok(textA[0].indexOf("sid8=aaaaaaaa") >= 0 && textB[0].indexOf("sid8=bbbbbbbb") >= 0, "B5 sid8 来自主题名");
const cTexts = (store2.readTopic(C).sentences || []).map((s) => String(s.text));
ok(cTexts.length === 2 && cTexts[1] === "部分提炼后的新句", "B6 C（marker 不在最后）未被迁移");
ok(/已提炼 7 句/.test(String((store2.readTopic(D).sentences || [])[0].text)), "B7 D（已是严格指针）原样保留");
try { be2.db.close(); } catch (e) { /* noop */ }
const baks = fs.readdirSync(path.dirname(DB)).filter((f) => f.indexOf(".bak-note-compact-") >= 0);
ok(baks.length === 1, "B8 --apply 生成 1 份备份", JSON.stringify(baks));

// 3) 幂等：再跑 dry-run 应 0 待迁移
const dry2 = run(["--db", DB]);
ok(dry2.code === 0 && /待迁移 0/.test(dry2.out), "C1 幂等：二次 dry-run 待迁移 0", (dry2.out.match(/笔记主题总数：[^\n]*/) || [""])[0]);

// 4) hermetic：独立 fixture 临时库（不依赖真实库状态）——再建一个含 legacy marker 的库，验证句数列与 dry-run
const DB2 = path.join(TMP, "fixture2", ".memtopic", "mem.db");
fs.mkdirSync(path.dirname(DB2), { recursive: true });
const be3 = new backendMod.SqliteBackend(DB2);
const store3 = new storeMod.MemoryStore(be3);
const E = (() => { const r = store3.createTopic({ name: "笔记·MIGCNT-WS/eeeeeeee", actor: "runtime", confirm: true }); const id = r.id || r.topic.id; try { store3.setState(id, "active", { actor: "runtime" }); } catch (e) {} return id; })();
store3.appendSentence({ topic: E, text: "旧E1", actor: "runtime" });
store3.appendSentence({ topic: E, text: "旧E2", actor: "runtime" });
store3.appendSentence({ topic: E, text: "已提炼 → T-0500（dream）", actor: "runtime" });
try { be3.db.close(); } catch (e) { /* noop */ }
const dryFix = run(["--db", DB2]);
ok(dryFix.code === 0 && /已提炼 2 句/.test(dryFix.out) && /待迁移 1/.test(dryFix.out), "D1 hermetic fixture：句数列=2、待迁移 1（不依赖真实库）", (dryFix.out.match(/笔记主题总数：[^\n]*/) || [""])[0]);

// 真实库仅只读 smoke（不进断言；迁移后待迁移 0 属正常）
const realDb = path.join(os.homedir(), ".dsh", "memory", ".memtopic", "mem.db");
if (fs.existsSync(realDb)) {
  const real = run(["--db", realDb]);
  console.log("SMOKE 真实库只读 dry-run：exit=" + real.code + " · " + ((real.out.match(/笔记主题总数：[^\n]*/) || [""])[0] || ""));
} else {
  console.log("SMOKE 真实库不存在，跳过");
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
