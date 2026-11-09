// [P4-C2] ② R2 重灌前等待本次检查点写完（bounded 30s，对齐 MiMo 的 waitForWriterSettlement）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-p4c2b-" + Date.now().toString(36), t);
const before = t.length;

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① 等待器 Map（挂在 P4C 缓存旁边）═══
rep(
  "    const P4C_PENDING = new Map();          // sid → 本次构建输入时算出的 lastMsgKey（供成功回调取用）",
  `    const P4C_PENDING = new Map();          // sid → 本次构建输入时算出的 lastMsgKey（供成功回调取用）
    const P4C_INTENT_WAIT = new Map();      // sid → 本次检查点写入的 Promise（R2 重灌前等待用，MiMo waitForWriter 同款）`,
  "waiter map"
);

// ═══ ② 压缩 handler：保存 spawn 返回的 Promise ═══
rep(
  `            let intentInput = text;
            try { intentInput = buildIntentInput(session, text); } catch (eIn) { intentInput = text; }
            spawnIntentCheckpoint(compactionId, intentInput, fname, parentAttempt, session.id);`,
  `            let intentInput = text;
            try { intentInput = buildIntentInput(session, text); } catch (eIn) { intentInput = text; }
            // [P4-C2] 保存本轮检查点 Promise：R2 重灌前要等它结算（否则灌的恒是上一版，用户实测指出）
            const _pW = spawnIntentCheckpoint(compactionId, intentInput, fname, parentAttempt, session.id);
            try {
              if (_pW && typeof _pW.then === "function") P4C_INTENT_WAIT.set(String(session.id), _pW);
            } catch (eWm) { /* 登记失败不影响检查点 */ }`,
  "save waiter"
);

// ═══ ③ R2 前等待（bounded 30s，超时降级用现有检查点）═══
rep(
  `                  rehydrate = await buildPostCompactRehydrate(targetAgent);`,
  `                  // [P4-C2][2026-11-02] 等本轮检查点写完再重灌（对齐 MiMo checkpoint.ts REBUILD_WAIT_MS=30s）。
                  //   不等待时 R2 与 writer 并行 ⇒ 灌的必然是上一版或空，用户实测指出该时序竞争。
                  //   超时/失败一律降级：用主题库里现有的最新检查点继续，绝不阻塞主会话。
                  try {
                    const _wp = P4C_INTENT_WAIT.get(String(session.id));
                    if (_wp && typeof _wp.then === "function") {
                      await Promise.race([
                        _wp.catch(() => null),
                        new Promise(function (r) { setTimeout(r, 30000); }),
                      ]);
                    }
                  } catch (eWait) { /* 等待失败 ⇒ 降级用现有检查点 */ }
                  rehydrate = await buildPostCompactRehydrate(targetAgent);`,
  "wait before rehydrate"
);

fs.writeFileSync(P, t, "utf8");
console.log("written:", before, "->", t.length);
