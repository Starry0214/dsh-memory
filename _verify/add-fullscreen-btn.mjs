// [3D 图谱] 加「全屏」按钮（Fullscreen API + 3D/canvas 尺寸重算）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-fs-" + Date.now().toString(36), t);

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① CSS：全屏样式 ═══
rep(
  `#tdbg .tdbg-modes button.on { background: rgba(125,140,255,.28); font-weight: 600; }`,
  `#tdbg .tdbg-modes button.on { background: rgba(125,140,255,.28); font-weight: 600; }
/* [全屏][2026-11-02] 全屏时卡片撑满视口、图区吃掉剩余高度 */
#tdbg:fullscreen { background: #0b1020; padding: 16px 18px; display: flex; flex-direction: column; height: 100vh; overflow: auto; }
#tdbg:fullscreen .tdbg-main { flex: 1 1 auto; min-height: 0; }
#tdbg:fullscreen #tdbg-canvas, #tdbg:fullscreen #tdbg-3d { height: 100%; min-height: 420px; }
#tdbg:fullscreen #tdbg-detail { max-height: 100%; overflow: auto; }
#tdbg #tdbg-fullscreen.on { background: rgba(18,184,134,.22); border-color: rgba(18,184,134,.5); }`,
  "CSS fullscreen"
);

// ═══ ② HTML：工具条加全屏按钮 ═══
rep(
  `      <span class="tdbg-modes" title="渲染模式（默认 3D）"><button type="button" id="tdbg-mode-3d" class="on">3D</button><button type="button" id="tdbg-mode-2d">2D</button></span>`,
  `      <span class="tdbg-modes" title="渲染模式（默认 3D）"><button type="button" id="tdbg-mode-3d" class="on">3D</button><button type="button" id="tdbg-mode-2d">2D</button></span>
      <button type="button" id="tdbg-fullscreen" title="全屏查看（ESC 退出）">⛶ 全屏</button>`,
  "HTML fullscreen btn"
);

// ═══ ③ JS：全屏逻辑（插在 setMode 函数之后）═══
rep(
  `    if (!quiet && MODE === "3d" && !S.g) load(null, 2);
  }`,
  `    if (!quiet && MODE === "3d" && !S.g) load(null, 2);
  }
  /* ---------- [全屏][2026-11-02] 图区块全屏（Fullscreen API；ESC 退出） ---------- */
  var fsBtn = document.getElementById("tdbg-fullscreen");
  function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function afterFsResize() {
    // 全屏/退出后容器尺寸变了：3D 要通知 three.js 重算，2D 要重绘
    setTimeout(function () {
      try {
        if (MODE === "3d" && G3 && box3d) {
          var w = box3d.clientWidth || 800, h = box3d.clientHeight || 560;
          if (G3.width) G3.width(w);
          if (G3.height) G3.height(h);
        } else if (hasCanvas && S.g) {
          render();
        }
      } catch (e) {}
      if (fsBtn) {
        if (isFs()) fsBtn.classList.add("on");
        else fsBtn.classList.remove("on");
      }
    }, 140);
  }
  function toggleFullscreen() {
    var box = document.getElementById("tdbg");
    if (!box) return;
    try {
      if (isFs()) {
        var ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) ex.call(document);
        afterFsResize();
        return;
      }
      var rf = box.requestFullscreen || box.webkitRequestFullscreen;
      if (!rf) { if (msgBox) msgBox.textContent = "当前浏览器不支持全屏 API"; return; }
      var p = rf.call(box);
      if (p && typeof p.then === "function") {
        p.then(afterFsResize).catch(function (e) {
          if (msgBox) msgBox.textContent = "全屏失败：" + String((e && e.message) || e) + "（部分环境需用户手势触发）";
        });
      } else {
        afterFsResize();
      }
    } catch (e) {
      if (msgBox) msgBox.textContent = "全屏失败：" + String((e && e.message) || e);
    }
  }
  try {
    document.addEventListener("fullscreenchange", afterFsResize);
    document.addEventListener("webkitfullscreenchange", afterFsResize);
  } catch (eFsEv) {}`,
  "JS fullscreen"
);

// ═══ ④ 初始化：绑定按钮 ═══
rep(
  `    if (btn2d) btn2d.addEventListener("click", function () { setMode("2d"); });`,
  `    if (btn2d) btn2d.addEventListener("click", function () { setMode("2d"); });
    var _fsb = document.getElementById("tdbg-fullscreen");
    if (_fsb) _fsb.addEventListener("click", toggleFullscreen);`,
  "bind fullscreen"
);

fs.writeFileSync(P, t, "utf8");
console.log("written:", t.length);
