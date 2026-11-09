// 查 dsh-subagent 服务暴露的方法（判断能否续接已有子会话）
import fs from "node:fs";

const asar = "C:/Users/Starry/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const fd = fs.openSync(asar, "r");
const h = Buffer.alloc(16);
fs.readSync(fd, h, 0, 16, 0);
const jsonLen = h.readUInt32LE(12);
const hb = Buffer.alloc(jsonLen);
fs.readSync(fd, hb, 0, jsonLen, 16);
const header = JSON.parse(hb.toString("utf8").replace(/\0+$/, ""));
const base = 16 + jsonLen;
function walk(node, p, out) {
  if (node.files) { for (const [k, v] of Object.entries(node.files)) walk(v, p ? p + "/" + k : k, out); }
  else out.push({ path: p, size: node.size, offset: node.offset });
  return out;
}
const all = walk(header, "", []).filter((f) => f.path === "dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js");
const f = all[0];
const b = Buffer.alloc(f.size);
fs.readSync(fd, b, 0, f.size, base + Number(f.offset));
const s = b.toString("utf8");

const methods = new Set();
for (const m of s.matchAll(/\n\t(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\(/g)) methods.add(m[1]);
console.log("服务方法:", [...methods].sort().join(", "));

for (const kw of ["subagent.prompt", "continueActivation", "prepareContinuable", "reuse"]) {
  const i = s.indexOf(kw);
  console.log(kw, "→", i >= 0 ? "@" + i : "(未出现)");
  if (i >= 0) console.log("   ..", s.slice(Math.max(0, i - 260), i + 260).replace(/\n/g, " | ").slice(0, 500));
}
