// [3D 修复] 剔除 2D 坐标 + 随机三维初始位置 + 调大节点体积（否则全从原点出发塌成一条线）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-3dfix-" + Date.now().toString(36), t);

const OLD = `      var nodes = (S.g.nodes || []).map(function (n) { return Object.assign({}, n); });
      var ids = {};`;
const NEW = `      var nodes = (S.g.nodes || []).map(function (n) {
        var m = Object.assign({}, n);
        // [3D 修复][2026-11-02] load() 把 2D 坐标初始化成 x=y=0 / vx=vy=0，原样传进来会让
        //   3d-force-graph 所有节点从**同一原点**出发 ⇒ 力导向对称展开成一条直线（用户实测踩到）。
        //   这里剔除 2D 布局字段，并显式给随机三维初始位置。
        delete m.x; delete m.y; delete m.z;
        delete m.vx; delete m.vy; delete m.vz;
        delete m.fx; delete m.fy; delete m.fz;
        m.x = (Math.random() - 0.5) * 900;
        m.y = (Math.random() - 0.5) * 900;
        m.z = (Math.random() - 0.5) * 900;
        return m;
      });
      var ids = {};`;

if (t.indexOf(OLD) < 0) throw new Error("nodes anchor not found");
if (t.indexOf(OLD, t.indexOf(OLD) + 1) >= 0) throw new Error("nodes anchor not unique");
t = t.replace(OLD, NEW);
console.log("OK nodes");

// nodeVal 调大（3d-force-graph 的 nodeVal 是体积语义，r=4~18 太小会挤成球）
const OLD2 = `            .nodeVal(function (n) { return Math.max(1, Number(n.r || radiusOf(n))); })`;
const NEW2 = `            .nodeVal(function (n) { return Math.max(3, Number(n.r || radiusOf(n)) * 2.2); })   // 体积语义：调大防重叠`;
if (t.indexOf(OLD2) < 0) throw new Error("nodeVal anchor not found");
t = t.replace(OLD2, NEW2);
console.log("OK nodeVal");

// 加快收敛：cooldownTicks + alphaDecay（默认会一直微动）
const OLD3 = `            .onNodeClick(function (n) { if (n) select(n); });`;
const NEW3 = `            .onNodeClick(function (n) { if (n) select(n); })
            .cooldownTicks(180)
            .d3AlphaDecay(0.035)
            .d3VelocityDecay(0.32);`;
if (t.indexOf(OLD3) < 0) throw new Error("cooldown anchor not found");
t = t.replace(OLD3, NEW3);
console.log("OK cooldown");

fs.writeFileSync(P, t, "utf8");
console.log("written:", t.length);
