import fs from "node:fs";
const F = "E:/工具/插件开发调整/dsh-memory-plugin/_verify/post-deploy-check.mjs";
let t = fs.readFileSync(F, "utf8");
const sha = process.argv[2] || "";
if (!/^[0-9A-F]{64}$/.test(sha)) { console.error("bad sha"); process.exit(1); }
const before = t;
t = t.replace(/const EXPECTED_SHA = "[0-9A-F]{64}";/, 'const EXPECTED_SHA = "' + sha + '";');
fs.writeFileSync(F, t, "utf8");
console.log(t === before ? "未变更" : "已更新", "| 期望:", sha.slice(0, 16));
