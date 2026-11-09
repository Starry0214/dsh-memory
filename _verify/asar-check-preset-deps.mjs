// 列出 asar 中所有 @deepseek-ai/dsh-* 包名（用于确认 persona / agent-preset 可用）
import fs from "node:fs";

const asar = "C:/Users/Starry/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const fd = fs.openSync(asar, "r");
const h = Buffer.alloc(16); fs.readSync(fd, h, 0, 16, 0);
const jsonLen = h.readUInt32LE(12);
const buf = Buffer.alloc(jsonLen); fs.readSync(fd, buf, 0, jsonLen, 16);
const header = JSON.parse(buf.toString("utf8").replace(/\0+$/, ""));
const base = 16 + jsonLen;
function walk(node, p, out) { if (node.files) { for (const [k, v] of Object.entries(node.files)) walk(v, p ? p + "/" + k : k, out); } else out.push({ path: p, size: node.size, offset: node.offset }); return out; }
const all = walk(header, "", []);
console.log("asar 文件总数:", all.length);

const want = ["dsh-persona/package.json", "dsh-agent-preset/package.json", "dsh-agent-preset-registry/package.json"];
for (const w of want) {
  const f = all.find(x => x.path.endsWith(w));
  if (!f) { console.log("MISSING:", w); continue; }
  const b = Buffer.alloc(f.size); fs.readSync(fd, b, 0, f.size, base + Number(f.offset));
  let j; try { j = JSON.parse(b.toString("utf8")); } catch { j = {}; }
  console.log(`OK ${w}  name=${j.name} main=${j.main} version=${j.version}`);
}
