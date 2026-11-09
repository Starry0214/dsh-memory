// 修正 post-deploy-check 的 EXPECTED_SHA（上次 PowerShell -replace 失败未生效）
import fs from "node:fs";

const F = "E:/工具/插件开发调整/dsh-memory-plugin/_verify/post-deploy-check.mjs";
let t = fs.readFileSync(F, "utf8");
const before = t;
t = t.replace(/const EXPECTED_SHA = "[0-9A-F]{64}";/, 'const EXPECTED_SHA = "380D07E92ABA026D6F91162A094A816B46278CD15013C6A6F0C399C0C3D9848F";');
fs.writeFileSync(F, t, "utf8");
const m = t.match(/EXPECTED_SHA = "([0-9A-F]{16})/);
console.log(t === before ? "未变更" : "已更新", "| 当前期望:", m ? m[1] : "(未找到)");
