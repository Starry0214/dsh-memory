// _memory-note-selftest.mjs —— [会话笔记] memory_note：append-only 暂存区（对齐 MiMo notes.md）
//
// 跑法：node test/_memory-note-selftest.mjs [index.js 路径]
//
// 背景（starry 2026-11-04）：「mimocode 不是有 checkpoint 和 note 两套机制吗」——我们只有自动检查点，
//   缺主 agent 主动标注的通道。MiMo 分工（session/llm.ts:191-204）：checkpoint=writer 从对话提取；
//   notes=主 agent 显式标注「要沉淀但暂不处理」，writer/dream 整合时提炼。
//
// 覆盖：
//   A 工具注册/参数/描述（含「什么时候写 / 什么时候不写」）
//   B 读取纪律注入已加入 memory_note 引导
//   C 库层真跑：建主题 / append / 去重 / 参数校验 / state
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(process.argv[2] || path.join(here, "..", "index.js"));
const FIXTURE = path.join(here, "..", "_fixture-ctx.mjs");
const src = fs.readFileSync(PLUGIN, "utf8");

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) { try { if (fn()) return true; } catch (e) { } await sleep(step || 50); }
  return false;
}

// ── A 静态 ──
ok(/name: "memory_note"/.test(src), "A1 工具已注册");
ok(/kind: \{ type: "string", enum: \["quote", "question", "observation", "future", "literal"\]/.test(src), "A2 kind 五分类");
// [2026-11-05 starry「note 记录应尽量强制」] 文案改为「默认动作 + 必记五类 + 宁可多记」
ok(/\*\*必记五类（遇到就记，不要挑）\*\*/.test(src) && /\*\*不记\*\*/.test(src), "A3 描述含正反两类引导（必记五类 / 不记）");
ok(/append-only，永不覆盖、不进上下文/.test(src), "A4 描述点明 append-only / 不覆盖 / 不进上下文");
ok(/默认动作】只要「三个月后可能还有用」就记一笔/.test(src), "A3b 描述写明「默认动作，不要先判断值不值得」");
ok(/\*\*宁可多记\*\*：同内容重复追加会被自动跳过/.test(src), "A3c 描述写明「宁可多记，去重是工具的活」");
ok(/const name = "笔记·" \+ wsKey \+ "\/" \+ sid8;/.test(src), "A5 主题命名 笔记·<wsKey>/<sid8>");
ok(/store\.seedTopic\(\{ name: name, triggers: \[sid8, wsKey\]/.test(src), "A6 建主题走 seedTopic（createTopic 会被禁建区拦，P2.5 同坑）");
ok(/const dup = cur\.find\(\(s\) => \{ const tx = String\(\(s && s\.text\) \|\| ""\); return !isNotePointerText\(tx\) && tx\.trim\(\)\.endsWith\(text\); \}\)/.test(src), "A7 同内容去重（4.5.2：指针行不参与后缀判等）");
ok(/text\.length > 2000/.test(src), "A8 单条上限 2000 字");
// [对齐 MiMo 2026-11-05] 子代理不写会话笔记：闸门 + 与既有 isTopLevelSession 口径一致
ok(/code: "SUBAGENT_SKIP"/.test(src), "A9 有子代理闸门（SUBAGENT_SKIP）");
ok(/typeof isTopLevelSession === "function" && !isTopLevelSession\(ag\)/.test(src), "A10 闸门复用 isTopLevelSession（与「子代理不吃注入」同口径）");

// ── B 注入引导 ──
ok(/memory_note 记一笔/.test(src), "B1 读取纪律注入含 memory_note 引导");
ok(/【默认动作】只要「这句话三个月后可能还有用」/.test(src), "B1b 读取纪律写明「默认动作，不要先判断值不值得」");
ok(/宁可多记/.test(src) && /去重是工具的活/.test(src), "B1c 读取纪律写明「宁可多记，去重是工具的活」");
ok(/dream 整合时会提炼进长期记忆/.test(src), "B2 引导说明 dream 会提炼（职责分工）");

// ── C 库层真跑 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-note-"));
const HOME = path.join(TMP, "home");
const MEM = path.join(HOME, "memory");
for (const d of ["knowledge", "sessions", "projects"]) fs.mkdirSync(path.join(MEM, d), { recursive: true });
fs.writeFileSync(path.join(MEM, "global.md"), "# 全局记忆\n- note 自测占位\n", "utf8");
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
  const tool = findTool(fx.captured, "memory_note");
  ok(!!(tool && typeof tool.execute === "function"), "C0b 前置：工具定义可取到");
  const SID = "1b736c53-7fc7-4be1-a22c-0fa4043c963e";
  const exec = { name: "memory_note", agent: { session: { id: SID }, header: { cwd: "E:\\工具\\note自测项目" } } };
  const call = async (args, e) => JSON.parse(await tool.execute(args, e || exec));

  const r1 = await call({ text: "用户口径：所有端口策略以资源变更方案定稿为准。", kind: "quote" });
  ok(r1.ok === true && r1.created === true, "C1 首次写入建主题", JSON.stringify(r1).slice(0, 160));
  ok(/^笔记·/.test(String(r1.topicName)) && /\/[0-9a-f]{8}$/.test(String(r1.topicName)), "C2 主题名形态 笔记·<wsKey>/<sid8>", r1.topicName);
  const t1 = store.readTopic(r1.topicId);
  ok(t1.sentences.length === 1, "C3 主题 1 句", String(t1.sentences.length));
  ok(String(t1.sentences[0].text).indexOf("(quote)") >= 0, "C4 kind 已落进正文", String(t1.sentences[0].text).slice(0, 40));
  ok(String(t1.state) === "active", "C5 主题 state=active", String(t1.state));

  const r2 = await call({ text: "未解问题：M9 引擎的 4.3x 切档阈值是否与官方一致，待复核。" });
  ok(r2.ok === true && r2.total === 2, "C6 第二条 append（不覆盖）", "total=" + r2.total);
  ok(store.readTopic(r1.topicId).sentences.length === 2, "C7 主题 2 句", String(store.readTopic(r1.topicId).sentences.length));

  const r3 = await call({ text: "用户口径：所有端口策略以资源变更方案定稿为准。", kind: "quote" });
  ok(r3.ok === true && r3.duplicate === true, "C8 同内容重复追加被跳过（duplicate:true）", JSON.stringify(r3).slice(0, 120));
  ok(store.readTopic(r1.topicId).sentences.length === 2, "C9 去重后仍 2 句", String(store.readTopic(r1.topicId).sentences.length));

  const r4 = await call({ text: "   " });
  ok(r4.code === "BAD_ARG", "C10 空 text → BAD_ARG", r4.code);
  const r5 = await call({ text: "x".repeat(2001) });
  ok(r5.code === "TOO_LONG", "C11 超 2000 字 → TOO_LONG", r5.code);
  const r6 = await call({ text: "无 cwd 场景" }, { name: "memory_note", agent: { session: { id: SID } } });
  ok(r6.code === "NO_CWD", "C12 无 cwd → NO_CWD", r6.code);

  // [对齐 MiMo] 真子代理（origin=subagent）被拒；teammate（独立会话、无 origin 标记）仍可写
  const execSub = { name: "memory_note", agent: { session: { id: "b2c3d4e5-1111-2222-3333-444455556666", header: { origin: "subagent", cwd: "E:\\工具\\note自测项目" } } } };
  const rSub = await call({ text: "子代理不该写进去的笔记（应被拒）" }, execSub);
  ok(rSub.ok === false && rSub.code === "SUBAGENT_SKIP", "C14 子代理被拒（SUBAGENT_SKIP）", rSub.code);
  ok(!(store.topics() || []).some((t) => String(t.name).indexOf("笔记·") === 0 && String(t.name).indexOf("b2c3d4e5") >= 0), "C15 被拒后没有建出子代理主题");
  // teammate 形状：session.header 有 cwd 但无 origin → isTopLevelSession 兜底为顶层 ⇒ 允许
  const execMate = { name: "memory_note", agent: { session: { id: "c3d4e5f6-1111-2222-3333-444455556666", header: { cwd: "E:\\工具\\note自测项目" } } } };
  const rMate = await call({ text: "teammate 独立会话的笔记。" }, execMate);
  ok(rMate.ok === true, "C16 teammate（独立会话）仍可写", rMate.code || "ok");

  // 不同会话 → 不同主题
  const exec2 = { name: "memory_note", agent: { session: { id: "a1b2c3d4-1111-2222-3333-444455556666" }, header: { cwd: "E:\\工具\\note自测项目" } } };
  const r7 = await call({ text: "另一个会话的笔记。" }, exec2);
  ok(r7.ok === true && String(r7.topicId) !== String(r1.topicId), "C13 不同会话 → 不同笔记主题", String(r7.topicName));

  try { if (mod.__topicdb && typeof mod.__topicdb.close === "function") mod.__topicdb.close(); } catch (e) { }
}

console.log("\n" + (fails.length === 0 ? "全部通过 " + pass + "/" + pass : pass + " PASS / " + fails.length + " FAIL"));
if (fails.length) console.log("FAIL 清单：\n- " + fails.join("\n- "));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);

