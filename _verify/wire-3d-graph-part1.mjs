// [3D 图谱][2026-11-02] ①上限 600→2000 ②vendor 路由 ③CSS/HTML/JS 加 3D 视图 + 2D/3D 切换（默认 3D）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-3d-" + Date.now().toString(36), t);
const before = t.length;

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① 上限 600 → 2000 ═══
rep(
  "const TOPICDB_GRAPH_HARD_MAX_NODES = 600;",
  "const TOPICDB_GRAPH_HARD_MAX_NODES = 2000;   // [3D][2026-11-02] 600→2000：3D 视图能扛，2D 仍按请求参数收窄",
  "HARD_MAX_NODES"
);

// ═══ ② vendor 路由 handler（插在 graph handler 之后）═══
rep(
  "// ── [topicdb][task-29] 图谱区块：CSS / HTML / 内联 JS 三段（模板字面量内**不含**反引号与 ${}，保证可安全拼接）──",
  `/** [3D 图谱][2026-11-02] GET /dsh-memory/vendor/<file> —— 同源按需加载第三方 JS（白名单，只读）。
 *  为什么不内联进 HTML：3d-force-graph.min.js 1.39MB，内联会让每次打开面板都下载整包；
 *  按需加载只有切到 3D 视图时才拉一次，且浏览器缓存 1 天（cache-control）。 */
const TOPICDB_VENDOR_FILES = Object.freeze({
  "/dsh-memory/vendor/3d-force-graph.min.js": "3d-force-graph.min.js",
});
function topicDbVendorHttpHandler(req, res) {
  try {
    const raw = String((req && req.url) || "");
    const rel = TOPICDB_VENDOR_FILES[raw.split("?")[0]];
    if (!rel) { res.statusCode = 404; res.end("not found"); return; }
    const file = path.join(MEMORY_ROOT, "vendor", rel);
    const buf = fs.readFileSync(file);
    res.setHeader("content-type", "application/javascript; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=86400");
    res.end(buf);
  } catch (e) {
    try { res.statusCode = 404; res.end("not found"); } catch (e2) { /* 客户端已断开 */ }
  }
}

// ── [topicdb][task-29] 图谱区块：CSS / HTML / 内联 JS 三段（模板字面量内**不含**反引号与 \${}，保证可安全拼接）──`,
  "vendor handler"
);

// ═══ ③ 路由注册（graph.json 注册之后）═══
rep(
  '    clog("[dsh-memory] [topicdb] 知识图谱端点已注册：/dsh-memory/graph.json");',
  `    clog("[dsh-memory] [topicdb] 知识图谱端点已注册：/dsh-memory/graph.json");
    // [3D 图谱] 3d-force-graph 按需加载端点（同源、只读、白名单）
    try {
      wsrv.register({ kind: "exact", path: "/dsh-memory/vendor/3d-force-graph.min.js", handler: topicDbVendorHttpHandler });
      clog("[dsh-memory] [3D] 3d-force-graph 端点已注册：/dsh-memory/vendor/3d-force-graph.min.js");
    } catch (e3d) { cwarn("[dsh-memory] [3D] vendor 端点注册失败:", (e3d && e3d.message) || String(e3d)); }`,
  "vendor route"
);

// ═══ ④ CSS 追加 3D 样式（@media 之前）═══
rep(
  `@media (max-width: 900px) {
  #tdbg .tdbg-main { flex-direction: column; }
  #tdbg #tdbg-detail { flex: 1 1 auto; max-width: none; }
  #tdbg #tdbg-canvas { height: 400px; }
}`,
  `/* [3D 图谱][2026-11-02] 3D 容器与切换：2D canvas 与 3D div 同尺寸、互斥显示 */
#tdbg #tdbg-3d { flex: 1 1 auto; width: 100%; height: 560px; min-width: 0; border-radius: 10px; overflow: hidden; background: radial-gradient(circle at 50% 40%, rgba(40,52,90,.55), rgba(10,14,26,.9)); position: relative; }
#tdbg #tdbg-3d canvas { display: block; border-radius: 10px; }
#tdbg.tdbg-mode-3d #tdbg-canvas { display: none !important; }
#tdbg:not(.tdbg-mode-3d) #tdbg-3d { display: none !important; }
#tdbg .tdbg-modes { display: inline-flex; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; overflow: hidden; }
#tdbg .tdbg-modes button { border: 0; border-radius: 0; padding: 5px 10px; background: transparent; }
#tdbg .tdbg-modes button.on { background: rgba(125,140,255,.28); font-weight: 600; }
@media (max-width: 900px) {
  #tdbg .tdbg-main { flex-direction: column; }
  #tdbg #tdbg-detail { flex: 1 1 auto; max-width: none; }
  #tdbg #tdbg-canvas { height: 400px; }
  #tdbg #tdbg-3d { height: 400px; }
}`,
  "CSS 3D"
);

// ═══ ⑤ HTML：切换按钮 + 3D 容器 ═══
rep(
  `      <button type="button" id="tdbg-zoomin" title="放大">+</button>`,
  `      <span class="tdbg-modes" title="渲染模式（默认 3D）"><button type="button" id="tdbg-mode-3d" class="on">3D</button><button type="button" id="tdbg-mode-2d">2D</button></span>
      <button type="button" id="tdbg-zoomin" title="放大">+</button>`,
  "HTML mode buttons"
);
rep(
  `      <canvas id="tdbg-canvas"></canvas>`,
  `      <canvas id="tdbg-canvas"></canvas>
      <div id="tdbg-3d" hidden></div>`,
  "HTML 3d container"
);

// ═══ ⑥ JS：状态变量（note 判空之后）═══
rep(
  `  if (!note || !qInput) return;
  var hasCanvas = !!(canvas && canvas.getContext && canvas.getContext("2d"));`,
  `  if (!note || !qInput) return;
  var hasCanvas = !!(canvas && canvas.getContext && canvas.getContext("2d"));
  // ── [3D 图谱][2026-11-02] 渲染模式：默认 3D（localStorage 记住选择）────────────────
  var MODE = "3d";
  try { var _pm = localStorage.getItem("tdbg-mode"); if (_pm === "2d" || _pm === "3d") MODE = _pm; } catch (eM) {}
  var G3 = null;        // ForceGraph3D 实例（懒建）
  var LIB3 = null;      // 库加载 Promise（只发一次请求）
  var box3d = document.getElementById("tdbg-3d");
  var btn3d = document.getElementById("tdbg-mode-3d");
  var btn2d = document.getElementById("tdbg-mode-2d");
  var rootEl = document.getElementById("tdbg");`,
  "JS state"
);

fs.writeFileSync(P, t, "utf8");
console.log("written. size:", before, "->", t.length);
