#!/usr/bin/env node
/**
 * preflight-injection.mjs —— 重启前「注入预览」：用**真实记忆库数据 + 插件真实装配函数**，
 * 预演重启后新会话会看到的【最近一次会话压缩点】是什么样子、多长、是否被预算截断。
 *
 * 用法：node _verify/preflight-injection.mjs
 * 只读：真实库复制到 tmp 后打开副本；插件只 import 取纯函数，不 apply、不写任何东西。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CWD = process.cwd();
const SRC_DIR = path.join(os.homedir(), ".dsh", "memory", ".memtopic");
const MEMTOPIC_DIR = path.join(CWD, "memtopic");
const PLUGIN = path.join(CWD, "index.js");
const LINE_NAME = "会话检查点";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshmem-inj-"));
try {
  for (const f of ["mem.db", "mem.db-wal", "mem.db-shm"]) {
    const s = path.join(SRC_DIR, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(tmp, f));
  }
  const { SqliteBackend } = await import(pathToFileURL(path.join(MEMTOPIC_DIR, "src", "backend-sqlite.mjs")).href);
  const { MemoryStore } = await import(pathToFileURL(path.join(MEMTOPIC_DIR, "src", "memory-store.mjs")).href);
  const be = new SqliteBackend(path.join(tmp, "mem.db"));
  const store = new MemoryStore(be);

  const mod = await import(pathToFileURL(PLUGIN).href);
  const dbSlice = mod.__dbCheckpointSlice || (mod.__p0Hooks && mod.__p0Hooks.dbCheckpointSlice);
  const build = mod.__buildSummaryInjection || (mod.__p0Hooks && mod.__p0Hooks.buildSummaryInjection);
  if (typeof dbSlice !== "function" || typeof build !== "function") {
    console.log("SKIP 未找到纯函数导出（__dbCheckpointSlice / __buildSummaryInjection）");
    process.exit(2);
  }

  const rows = store.topics();
  const line = rows.find((t) => t && String(t.name) === LINE_NAME);
  if (!line) {
    console.log("FAIL 找不到线主题「" + LINE_NAME + "」");
    process.exit(1);
  }
  const now = new Date();
  let hit = null;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const t = rows.find((x) => x && x.parentId === line.id && String(x.name) === day);
    if (!t) continue;
    const rt = store.readTopic(t.id);
    const sentences = (rt.sentences || []).map((s) => String(s && s.text != null ? s.text : s)).filter((x) => x.trim());
    if (!sentences.length) continue;
    hit = { day, topicId: t.id, sentences };
    break;
  }
  if (!hit) {
    console.log("FAIL 近 7 天没有检查点子主题");
    process.exit(1);
  }
  const latest3 = hit.sentences.slice(-3).reverse(); // 与插件一致：最新在前
  console.log(`数据源: ${hit.day}（${hit.topicId}）共 ${hit.sentences.length} 句，取最新 3 句（长度 ${latest3.map((s) => s.length).join(" / ")}）`);

  // 1) 无项目隔离（cwd 未命中项目时的分支）—— 预算 2500（SUMMARY_SLOT_BUDGET.checkpoint）
  const noProj = dbSlice(latest3, "", null, 2500);
  console.log(`\n[无项目隔离] loaded=${noProj.text.length} 字, 取用句数≈${(noProj.text.match(/## 检查点/g) || []).length}, hit=${noProj.hit}`);

  // 2) 模拟装配（三槽，总预算 4500；用户原话/任务状态留空）
  const built = build({ checkpoint: noProj.text, userQuotes: "", taskState: "", budget: 4500 });
  console.log(`[装配后] totalChars=${built.totalChars}  budget=${built.budget}  dropped=${JSON.stringify(built.dropped || [])}`);

  const text = String(built.text || "");
  const hasLatest = text.includes("检查点（目标与下一步");
  console.log(`[检查] 含「## 检查点」标题=${hasLatest ? "是" : "否"}  含最新句标记=${latest3[0].slice(0, 40).replace(/\n/g, " ")}`);
  console.log(`\n--- 重启后新会话将看到的注入正文（前 900 字）---\n`);
  console.log(text.slice(0, 900));
  console.log(`\n...（共 ${text.length} 字）`);

  be.close();
  console.log("\nPREFLIGHT_INJECTION_OK");
} catch (e) {
  console.log("FAIL " + ((e && e.message) || String(e)));
  process.exit(1);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
