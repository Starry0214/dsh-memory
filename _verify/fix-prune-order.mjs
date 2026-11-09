// 修复 p3 prune 误删新建会话（文件被前一个脚本改过，这里用精确字符串替换）
import fs from "node:fs";

const FILE = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(FILE, "utf8");
const before = t.length;
fs.writeFileSync(FILE + ".bak-prunefix-" + Date.now().toString(36), t);

// ① p3OnSessionEvent：先刷 lastActivityAt 再 prune
const A_OLD = "    const st = p3SessionState(sid);\n    if (!st) return null;\n    p3PruneSessions(now);";
const A_NEW = "    const st = p3SessionState(sid);\n    if (!st) return null;\n    // ⚠ 顺序关键：先刷新活跃时间再 prune。否则新建会话 lastActivityAt=0 会被 prune 当成\n    //   「30 天不活跃」当场删掉 ⇒ 后写的 fired 落在游离对象上、磁盘恒为空 ⇒ 同档重复触发。\n    st.lastActivityAt = now;\n    p3PruneSessions(now);";
const cntA = t.split(A_OLD).length - 1;
console.log("anchor A count:", cntA);
if (cntA !== 1) { console.error("anchor A not unique"); process.exit(1); }
t = t.replace(A_OLD, A_NEW);

// ② p3PruneSessions：无 lastActivityAt 的保留
const B_OLD = "      if (!st || !st.lastActivityAt || st.lastActivityAt < cutoff) delete p.sessions[k];";
const B_NEW = "      if (!st) { delete p.sessions[k]; continue; }\n      // 无 lastActivityAt = 刚创建还没活动过（或旧格式）⇒ 保留，只靠下方 30 天/500 条硬上限淘汰。\n      if (!st.lastActivityAt) continue;\n      if (st.lastActivityAt < cutoff) delete p.sessions[k];";
const cntB = t.split(B_OLD).length - 1;
console.log("anchor B count:", cntB);
if (cntB !== 1) { console.error("anchor B not unique"); process.exit(1); }
t = t.replace(B_OLD, B_NEW);

fs.writeFileSync(FILE, t, "utf8");
console.log("written. size:", before, "->", t.length);
