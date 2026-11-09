#!/usr/bin/env node
/**
 * preflight-db.mjs —— 部署后「重启前」预检：P0-1 读库路径在**真实记忆库**上能否读到检查点
 *
 * 目的：G2 修复的读侧依赖真实库结构（D8「日记忆」→「会话检查点」线 → 当日 YYYY-MM-DD 主题 → 句子）。
 *       本脚本用**真实库的临时副本**（不碰真库）复刻插件的读库逻辑，提前回答：
 *         "重启后新会话能不能真的读到 11-01 的检查点正文？"
 *
 * 用法：node _verify/preflight-db.mjs
 * 退出码：0=能读到（预检通过）；1=读不到（需排查）
 *
 * 只读：把 mem.db(+wal/shm) 复制到 os.tmpdir() 后打开副本，用完删除。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC_DIR = path.join(os.homedir(), ".dsh", "memory", ".memtopic");
const MEMTOPIC_DIR = path.join(process.cwd(), "memtopic");
const LINE_NAME = "会话检查点";
const LOOKBACK_DAYS = 7;

function fail(msg) {
  console.log("FAIL " + msg);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshmem-preflight-"));
try {
  // 1) 复制真实库（含 WAL）到临时目录
  let copied = 0;
  for (const f of ["mem.db", "mem.db-wal", "mem.db-shm"]) {
    const s = path.join(SRC_DIR, f);
    if (!fs.existsSync(s)) continue;
    fs.copyFileSync(s, path.join(tmp, f));
    copied++;
    console.log(`  复制 ${f}  ${(fs.statSync(s).size / 1048576).toFixed(2)} MB`);
  }
  if (!copied) fail("没找到 mem.db（主题库未启用？）");

  // 2) 用真实 memtopic 模块打开副本
  const { SqliteBackend } = await import(pathToFileURL(path.join(MEMTOPIC_DIR, "src", "backend-sqlite.mjs")).href);
  const { MemoryStore } = await import(pathToFileURL(path.join(MEMTOPIC_DIR, "src", "memory-store.mjs")).href);
  const be = new SqliteBackend(path.join(tmp, "mem.db"));
  const store = new MemoryStore(be);

  const rows = store.topics();
  console.log(`\n主题总数: ${rows.length}`);
  console.log(`topics() 首行字段: ${Object.keys(rows[0] || {}).join(", ")}`);

  // 3) 复刻 topicDbReadIntentSummary 的关键判据
  const line = rows.find((t) => t && String(t.name) === LINE_NAME);
  if (!line) fail(`找不到线主题「${LINE_NAME}」`);
  console.log(`线主题: ${line.id} "${line.name}"`);

  const now = new Date();
  let found = null;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const topic = rows.find((t) => t && t.parentId === line.id && String(t.name) === day);
    if (!topic) continue;
    const rt = store.readTopic(topic.id);
    const sentences = (rt.sentences || []).map((s) => String(s && s.text != null ? s.text : s)).filter((x) => x.trim());
    if (!sentences.length) continue;
    found = { day, topicId: topic.id, count: sentences.length, last: sentences[sentences.length - 1] };
    break;
  }

  if (!found) fail(`回溯 ${LOOKBACK_DAYS} 天没有找到「${LINE_NAME}」线下的任何检查点子主题（重启后 G2 仍无可注入内容）`);

  console.log(`\n✅ 命中: ${found.day}（${found.topicId}）检查点句数=${found.count}`);
  const latest = String(found.last || "").replace(/\n/g, " ");
  console.log(`   最新句前 160 字: ${latest.slice(0, 160)}`);
  const isCheckpoint = latest.includes("检查点（目标与下一步") || latest.includes("本次目标");
  console.log(`   是否三节检查点格式: ${isCheckpoint ? "是" : "否（仍会被注入，但内容可能不是检查点）"}`);

  be.close();
  console.log("\nPREFLIGHT_OK");
  process.exit(0);
} catch (e) {
  fail((e && e.message) || String(e));
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
