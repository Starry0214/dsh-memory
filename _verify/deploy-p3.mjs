// deploy-p3.mjs —— P3 系列模块化部署：开发副本 → 运行副本（多文件）
//
// 背景：P3 起 dsh-memory 从「单文件」变成「index.js + 独立模块」。
//   index.js 通过静态 `import "./p3-cost.js"` 等引用同目录模块，所以部署必须
//   把模块一起复制到 `profiles/<name>/plugins/memory/`，否则 import 失败 = 插件全挂。
//
// 用法：
//   node _verify/deploy-p3.mjs            # dry-run，只打印计划
//   node _verify/deploy-p3.mjs --apply    # 真正复制
//
// 设计原则：
//   - 只复制「入口 index.js + MODULES 白名单」，不碰目录里的 .bak / _inj-boot-* 垃圾
//   - 复制前先 `node --check` 每个 .js（ESM 语法），有错直接中止
//   - 复制后写 deploy manifest（sha/时间/文件清单），post-deploy-check 可读
//   - 所有目标 profile 的 index.js 必须指向同一份代码（desktop 用绝对路径引用 web，天然共享）

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const DEV = "E:\\工具\\插件开发调整\\dsh-memory-plugin";
const PROFILES = [
  "C:\\Users\\Starry\\.dsh\\profiles\\web\\plugins\\memory",
  "C:\\Users\\Starry\\.dsh\\profiles\\web-test\\plugins\\memory",
  "C:\\Users\\Starry\\.dsh\\profiles\\web-cc-test\\plugins\\memory",
];
// desktop profile 的 patch 用 file:///.../web/plugins/memory/index.js 绝对路径引用 web 那份，
// 所以不需要单独目录；如果将来改成相对路径，把 desktop 加进 PROFILES。
const MODULES = [
  "p3-cost.js",
  "p3-triggers.js",
  "p3-readside.js",
  "p25-topics.js",
];
// [4.5.12] 版本元数据也必须随部署同步：memory_onboard 自检读部署目录的 version.txt/package.json，
//   只换 index.js 会导致「版本/模板一致」门 FAIL（index=4.5.12 而 version.txt=4.5.11）。
const VERSION_FILES = ["version.txt", "package.json"];
// [4.5.14] 3D 图谱 vendor 也随部署同步：路由优先插件目录 vendor/（安装版由 payload 携带），
//   本机开发部署也保持一致，避免只靠 ~/.dsh/memory/vendor 的历史手工副本。
const VENDOR_FILES = ["vendor/3d-force-graph.min.js", "vendor/three.module.js", "vendor/three.core.js"];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const files = ["index.js", ...MODULES, ...VERSION_FILES, ...VENDOR_FILES].filter((f) => fs.existsSync(path.join(DEV, f)));
const missing = ["index.js", ...MODULES, ...VERSION_FILES, ...VENDOR_FILES].filter((f) => !fs.existsSync(path.join(DEV, f)));

console.log(`=== P3 部署${APPLY ? "" : "（dry-run）"} ===`);
console.log(`源目录: ${DEV}`);
console.log(`产物: ${files.join(", ")}`);
if (missing.length) console.log(`⚠ 缺失（将跳过）：${missing.join(", ")}`);

// 1) 语法检查
let syntaxOk = true;
for (const f of files) {
  if (!f.endsWith(".js") || f.startsWith("vendor/")) continue;   // vendor = 第三方压缩库，跳过语法检查
  try {
    execFileSync(process.execPath, ["--check", path.join(DEV, f)], { stdio: "pipe" });
    console.log(`  [OK] node --check ${f}`);
  } catch (e) {
    syntaxOk = false;
    console.error(`  [FAIL] node --check ${f}: ${String(e.stderr || e.message).slice(0, 400)}`);
  }
}
if (!syntaxOk) {
  console.error("\n语法检查失败，中止部署。");
  process.exit(1);
}

// 2) 计划
const plans = [];
for (const dir of PROFILES) {
  if (!fs.existsSync(dir)) { console.log(`  [SKIP] 目录不存在: ${dir}`); continue; }
  const cur = path.join(dir, "index.js");
  const before = fs.existsSync(cur) ? sha256(cur) : "(none)";
  plans.push({ dir, before });
  console.log(`\n[目标] ${dir}`);
  console.log(`  当前 index.js sha: ${before.slice(0, 16)}…`);
  for (const f of files) {
    const dst = path.join(dir, f);
    const exists = fs.existsSync(dst);
    console.log(`  ${exists ? "覆盖" : "新增"} ${f}  ${fs.statSync(path.join(DEV, f)).size} B`);
  }
}

if (!APPLY) {
  console.log(`\n=== dry-run 结束。加 --apply 执行。===`);
  process.exit(0);
}

// 3) 备份 + 复制
const ts = stamp();
const manifest = { deployedAt: new Date().toISOString(), stamp: ts, files: {}, targets: [] };
for (const f of files) manifest.files[f] = { sha256: sha256(path.join(DEV, f)), bytes: fs.statSync(path.join(DEV, f)).size };

for (const p of plans) {
  // 备份现有 index.js（只备份 index.js，模块是新文件无需备份；重复部署时模块也可回滚到 _bak）
  const cur = path.join(p.dir, "index.js");
  if (fs.existsSync(cur)) {
    const bak = `${cur}.bak-pre-p3-${ts}`;
    fs.copyFileSync(cur, bak);
    console.log(`[备份] ${path.basename(bak)}`);
  }
  for (const f of files) {
    const src = path.join(DEV, f);
    const dst = path.join(p.dir, f);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(fs.readFileSync(src))) continue;
    // 模块覆盖前也留一份
    if (fs.existsSync(dst) && f !== "index.js") fs.copyFileSync(dst, `${dst}.bak-pre-p3-${ts}`);
    fs.copyFileSync(src, dst);
  }
  const after = sha256(path.join(p.dir, "index.js"));
  manifest.targets.push({ dir: p.dir, beforeSha: p.before, afterSha: after });
  console.log(`[部署] ${p.dir}  index.js ${after.slice(0, 16)}…`);
}

const mf = path.join(DEV, `_verify\\deploy-manifest-${ts}.json`);
fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), "utf8");
console.log(`\n=== 部署完成。manifest: ${mf} ===`);
console.log(`提示：改插件代码需 DSH 重启（或热重载）才生效；desktop profile 通过绝对路径共享 web 副本。`);
