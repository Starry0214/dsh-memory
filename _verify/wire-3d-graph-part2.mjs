// [3D 图谱] Part 2：3D 渲染函数 + 模式切换 + load 集成 + 初始化
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-3d2-" + Date.now().toString(36), t);
const before = t.length;

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① 3D 渲染函数（插在「渲染」段之前）═══
rep(
  "  /* ---------- 渲染 ---------- */\n  function render() {",
  `  /* ---------- [3D 图谱][2026-11-02] 3D 视图（3d-force-graph 按需加载，默认开启） ---------- */
  function loadLib3() {
    if (typeof window.ForceGraph3D === "function") return Promise.resolve(window.ForceGraph3D);
    if (LIB3) return LIB3;
    LIB3 = new Promise(function (resolve, reject) {
      var sc = document.createElement("script");
      sc.src = "/dsh-memory/vendor/3d-force-graph.min.js";
      sc.async = true;
      sc.onload = function () {
        if (typeof window.ForceGraph3D === "function") resolve(window.ForceGraph3D);
        else reject(new Error("加载后未暴露 ForceGraph3D"));
      };
      sc.onerror = function () { reject(new Error("3d-force-graph.min.js 加载失败")); };
      document.head.appendChild(sc);
    });
    return LIB3;
  }
  function render3D() {
    if (!box3d || !S.g) return;
    loadLib3().then(function (FG) {
      if (!G3) {
        G3 = FG()(box3d);
        try {
          G3.backgroundColor("rgba(0,0,0,0)").showNavInfo(false).nodeRelSize(4)
            .nodeColor(function (n) { return colorOf(n); })
            .nodeVal(function (n) { return Math.max(1, Number(n.r || radiusOf(n))); })
            .nodeLabel(function (n) { return shortName(n.name) + "（" + (LEVEL_LABEL[n.level] || n.level || "") + "）"; })
            .nodeOpacity(0.92)
            .linkColor(function (l) { return EDGE_COLOR[l && l.type] || "rgba(160,170,200,0.35)"; })
            .linkOpacity(0.55)
            .linkWidth(function (l) { return l && l.type === "tree" ? 1.1 : 0.6; })
            .onNodeClick(function (n) { if (n) select(n); });
        } catch (eCfg) { /* 个别配置项不支持不影响渲染 */ }
      }
      var nodes = (S.g.nodes || []).map(function (n) { return Object.assign({}, n); });
      var ids = {};
      for (var i = 0; i < nodes.length; i++) ids[nodes[i].id] = 1;
      var links = (S.g.links || []).map(function (l) { return { source: l.s, target: l.t, type: l.type, w: (l.w || 1) }; })
        .filter(function (l) { return ids[l.source] && ids[l.target]; });
      G3.graphData({ nodes: nodes, links: links });
      if (msgBox) msgBox.textContent = "";
    }).catch(function (e) {
      if (msgBox) msgBox.textContent = "3D 视图不可用（" + String((e && e.message) || e) + "），已回退 2D。";
      setMode("2d", true);
    });
  }
  /** 切换渲染模式；quiet=true 只同步 UI（初始化用，不触发数据加载） */
  function setMode(m, quiet) {
    MODE = (m === "2d") ? "2d" : "3d";
    try { localStorage.setItem("tdbg-mode", MODE); } catch (e) {}
    if (rootEl) { if (MODE === "3d") rootEl.classList.add("tdbg-mode-3d"); else rootEl.classList.remove("tdbg-mode-3d"); }
    if (box3d) box3d.hidden = MODE !== "3d";
    if (canvas) canvas.hidden = MODE === "3d";
    if (btn3d) btn3d.className = MODE === "3d" ? "on" : "";
    if (btn2d) btn2d.className = MODE === "2d" ? "on" : "";
    if (MODE === "3d") { if (S.g) render3D(); }
    else if (S.g) { if (hasCanvas) render(); else renderList(); }
    if (!quiet && MODE === "3d" && !S.g) load(null, 2);
  }

  /* ---------- 渲染 ---------- */
  function render() {`,
  "3D functions"
);

// ═══ ② load()：3D 请求更多节点 ═══
rep(
  '    if (includeArchivedOn()) qs.push("includeArchived=1");   // [task-39] 含归档开关',
  '    if (includeArchivedOn()) qs.push("includeArchived=1");   // [task-39] 含归档开关\n' +
  '    qs.push("maxNodes=" + (MODE === "3d" ? "1200" : "350"));   // [3D] 3D 视图放宽节点上限（2D 保持原口径）',
  "load maxNodes"
);

// ═══ ③ load() 末尾：3D 模式下触发 3D 渲染 ═══
rep(
  "      layout();\n      updateLegend();\n      render();\n    }).catch(function (e) {",
  "      layout();\n      updateLegend();\n      render();\n      if (MODE === \"3d\") render3D();   // [3D] 数据就绪后渲染 3D（2D 布局仍算，切回 2D 立刻可用）\n    }).catch(function (e) {",
  "load render3D"
);

// ═══ ④ IIFE 末尾：按钮绑定 + 初始化 ═══
const tail = "  /* ---------- [3D] 初始化：默认 3D + 模式按钮绑定 ---------- */\n" +
  "  try {\n" +
  "    if (btn3d) btn3d.addEventListener(\"click\", function () { setMode(\"3d\"); });\n" +
  "    if (btn2d) btn2d.addEventListener(\"click\", function () { setMode(\"2d\"); });\n" +
  "    setMode(MODE, true);   // 同步初始 UI（3D 库在首次渲染时才懒加载，不阻塞首屏）\n" +
  "  } catch (eInit3d) {}\n\n";
const idx = t.indexOf("\n})();\n`;");
if (idx < 0) throw new Error("IIFE end anchor not found");
t = t.slice(0, idx + 1) + tail + t.slice(idx + 1);
console.log("OK: init tail");

fs.writeFileSync(P, t, "utf8");
console.log("written. size:", before, "->", t.length);
