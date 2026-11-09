// P3-3c 记账补全：checkpointWrite 成功/失败/重试（4 处，锚点唯一）
import fs from "node:fs";

const FILE = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(FILE, "utf8");
fs.writeFileSync(FILE + ".bak-costwire2-" + Date.now().toString(36), t);
const before = t.length;

function insertAfter(text, anchor, addition, label) {
  const i = text.indexOf(anchor);
  if (i < 0) throw new Error("anchor NOT FOUND: " + label);
  if (text.indexOf(anchor, i + 1) >= 0) throw new Error("anchor NOT UNIQUE: " + label);
  const end = i + anchor.length;
  console.log("OK:", label, "@char", i);
  return text.slice(0, end) + addition + text.slice(end);
}

// ═══ ① 重试 + 起点计时（INTENT_RUNNING = true 之后）═══
const A1 = "      INTENT_RUNNING = true;";
const ADD1 = `
      const _p3t0 = Date.now();   // [P3-3 记账] 量 spawn→settle 真实耗时（成功记账用）
      if (_retryCall) {
        try { p3CostBump("checkpointWrite", { n: 0, retry: 1 }, { sid: sessionId, trigger: "I-retry", note: "intent-retry" }); } catch (eP3r) {}
      }`;
t = insertAfter(t, A1, ADD1, "retry+t0");

// ═══ ② 成功·DB 路由（intentRetrySucceed 落库成功那条之后）═══
const A2 = "          intentRetrySucceed(compactionId);   // P0-2：落库成功才进去重集 + 清重试队列";
const ADD2 = `
          // [P3-3 记账] 检查点真的写成功（n:0 不重复计"压缩次数"；outChars/durMs/fail 正常累加）
          try {
            const _p3d = Date.now() - _p3t0;
            p3CostBump("checkpointWrite", { n: 0, outChars: sum.length, estTokens: p3Cost.estTokens(sum.length), durMs: _p3d },
              { sid: sessionId, trigger: "I-ok", ok: 1, outChars: sum.length, durMs: _p3d, note: "intent-ok-db" + (_retryCall ? "-retry" : "") });
          } catch (eP3o1) {}`;
t = insertAfter(t, A2, ADD2, "ok-db");

// ═══ ③ 成功·md 写回 ═══
const A3 = "        intentRetrySucceed(compactionId);   // P0-2：md 写回成功才进去重集 + 清重试队列";
const ADD3 = `
        // [P3-3 记账] 检查点写 md 成功（同上口径）
        try {
          const _p3d2 = Date.now() - _p3t0;
          p3CostBump("checkpointWrite", { n: 0, outChars: sum.length, estTokens: p3Cost.estTokens(sum.length), durMs: _p3d2 },
            { sid: sessionId, trigger: "I-ok", ok: 1, outChars: sum.length, durMs: _p3d2, note: "intent-ok-md" + (_retryCall ? "-retry" : "") });
        } catch (eP3o2) {}`;
t = insertAfter(t, A3, ADD3, "ok-md");

// ═══ ④ 失败唯一收口（let enq = null; 之后）═══
const A4 = "      let enq = null;";
const ADD4 = `
        // [P3-3 记账] 检查点失败唯一收口（5 个早退分支 + throw 都经 intentRetryFail）
        try {
          p3CostBump("checkpointWrite", { n: 0, fail: 1, timeout: /abort|timeout|hard/i.test(String(reason || "")) ? 1 : 0 },
            { sid: sessionId, trigger: "I-fail", ok: 0, note: String(reason || "").slice(0, 80) });
        } catch (eP3f) {}`;
t = insertAfter(t, A4, ADD4, "fail");

fs.writeFileSync(FILE, t, "utf8");
console.log("written. size:", before, "->", t.length);
