// [P4-C2] ① 消息水位增量（MiMo 同款：记上次最后一条消息指纹 → 取之后的新消息）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-p4c2a-" + Date.now().toString(36), t);
const before = t.length;

function rep(oldS, newS, label) {
  const i = t.indexOf(oldS);
  if (i < 0) throw new Error("NOT FOUND: " + label);
  if (t.indexOf(oldS, i + 1) >= 0) throw new Error("NOT UNIQUE: " + label);
  t = t.slice(0, i) + newS + t.slice(i + oldS.length);
  console.log("OK:", label);
}

// ═══ ① 缓存结构升级：{ text, lastMsgKey }（含 pending key 暂存）═══
rep(
  `    const P4C_LAST_CP = new Map();
    const P4C_LAST_CP_CAP = 32;
    function p4cRememberCheckpoint(sid, text) {
      try {
        const k = String(sid || "");
        const body = String(text || "").trim();
        if (!k || !body) return;
        P4C_LAST_CP.set(k, body.slice(0, 2000));
        if (P4C_LAST_CP.size > P4C_LAST_CP_CAP) {
          const first = P4C_LAST_CP.keys().next().value;
          if (first !== undefined) P4C_LAST_CP.delete(first);
        }
      } catch (eC) { /* 缓存失败不影响检查点 */ }
    }
    function p4cLastCheckpoint(sid) {
      try { return P4C_LAST_CP.get(String(sid || "")) || ""; } catch (e) { return ""; }
    }`,
  `    const P4C_LAST_CP = new Map();          // sid → { text, lastMsgKey }（消息水位，MiMo 同款）
    const P4C_LAST_CP_CAP = 32;
    const P4C_PENDING = new Map();          // sid → 本次构建输入时算出的 lastMsgKey（供成功回调取用）
    /** 消息指纹：role + 文本前 120 字。DSH deriveMessages 不见得暴露稳定 id，用内容指纹当水位锚点；
     *  倒序匹配取**最后一条**同指纹消息，重复内容时也能落到最近一次。 */
    function p4cMsgKey(m) {
      try {
        const role = String((m && m.role) || "");
        let txt = "";
        try { txt = msgTextOf(m) || ""; } catch (e) { txt = ""; }
        if (!txt) {
          try { txt = String((m && m.content) || ""); } catch (e2) { txt = ""; }
        }
        return role + "|" + String(txt).slice(0, 120);
      } catch (e) { return ""; }
    }
    function p4cRememberCheckpoint(sid, text) {
      try {
        const k = String(sid || "");
        const body = String(text || "").trim();
        if (!k || !body) return;
        const lastMsgKey = P4C_PENDING.get(k) || "";
        P4C_LAST_CP.set(k, { text: body.slice(0, 2000), lastMsgKey: lastMsgKey });
        P4C_PENDING.delete(k);
        if (P4C_LAST_CP.size > P4C_LAST_CP_CAP) {
          const first = P4C_LAST_CP.keys().next().value;
          if (first !== undefined) P4C_LAST_CP.delete(first);
        }
      } catch (eC) { /* 缓存失败不影响检查点 */ }
    }
    function p4cLastCheckpoint(sid) {
      try {
        const v = P4C_LAST_CP.get(String(sid || ""));
        if (!v) return "";
        return (typeof v === "string") ? v : (v.text || "");
      } catch (e) { return ""; }
    }
    function p4cLastMsgKey(sid) {
      try {
        const v = P4C_LAST_CP.get(String(sid || ""));
        return (v && typeof v === "object" && v.lastMsgKey) ? v.lastMsgKey : "";
      } catch (e) { return ""; }
    }`,
  "P4C cache v2"
);

// ═══ ② buildRawDialogExcerpt 支持 afterKey（只取水位之后的消息）═══
rep(
  `      const arr = Array.isArray(msgs) ? msgs : [];
      const rev = [];   // 最新 → 最旧收集，最后反转
      for (let i = arr.length - 1; i >= 0; i--) {`,
  `      const arr = Array.isArray(msgs) ? msgs : [];
      // [P4-C2] 增量水位：找上次最后一条消息（倒序取最后匹配），只取它之后的消息。
      //   找不到锚点（压缩清空 / 内容漂移）⇒ floor=-1 回退全窗口，行为与改造前一致。
      let floor = -1;
      if (afterKey) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const kk = p4cMsgKey(arr[i]);
          if (kk && kk === afterKey) { floor = i; break; }
        }
      }
      const rev = [];   // 最新 → 最旧收集，最后反转
      for (let i = arr.length - 1; i > floor; i--) {`,
  "excerpt afterKey"
);

// ═══ ③ buildRawDialogExcerpt 签名加第 3 参 ═══
rep(
  "    function buildRawDialogExcerpt(session, maxChars) {",
  "    function buildRawDialogExcerpt(session, maxChars, afterKey) {",
  "excerpt signature"
);

// ═══ ④ buildIntentInput：传水位 + 记录本次 pending key ═══
rep(
  `      let prevCp = "";
      try { prevCp = p4cLastCheckpoint(session && session.id); } catch (eP) { prevCp = ""; }
      if (prevCp) parts.push("===== 上次检查点（增量基线）=====\\n" + prevCp);`,
  `      let prevCp = "";
      let prevKey = "";
      try {
        prevCp = p4cLastCheckpoint(session && session.id);
        prevKey = p4cLastMsgKey(session && session.id);
      } catch (eP) { prevCp = ""; prevKey = ""; }
      if (prevCp) parts.push("===== 上次检查点（增量基线）=====\\n" + prevCp);
      // [P4-C2] 记录本次构建时的最后一条消息指纹：检查点写成功时作为下一轮的水位锚点。
      try {
        const _sidP = String((session && session.id) || "");
        if (_sidP) {
          let _msgsP = [];
          try { _msgsP = session.deriveMessages ? (session.deriveMessages() || []) : []; } catch (eM) { _msgsP = []; }
          const _last = _msgsP.length ? p4cMsgKey(_msgsP[_msgsP.length - 1]) : "";
          if (_last) P4C_PENDING.set(_sidP, _last);
        }
      } catch (ePk) { /* 水位记录失败不影响本次检查点 */ }`,
  "input watermark"
);

// ═══ ⑤ 原文段改用 afterKey（增量窗口）═══
rep(
  `      let raw = "";
      try { raw = buildRawDialogExcerpt(session, P2_RAW_DIALOG_MAX); } catch (e) { raw = ""; }`,
  `      let raw = "";
      // [P4-C2] 有上次检查点水位时只取「水位之后」的新消息（纯增量）；无则整窗（首次行为不变）。
      let _prevKeyForRaw = "";
      try { _prevKeyForRaw = p4cLastMsgKey(session && session.id); } catch (eK) { _prevKeyForRaw = ""; }
      try { raw = buildRawDialogExcerpt(session, P2_RAW_DIALOG_MAX, _prevKeyForRaw); } catch (e) { raw = ""; }`,
  "raw incremental"
);

// ═══ ⑥ 标记段名（增量时段头区分）═══
rep(
  `      parts.push("===== 最近对话原文 =====\\n" + (raw || "（无可用原始消息）"));`,
  `      const _rawHead = _prevKeyForRaw ? "===== 最近对话原文（自上次检查点以来的新增部分）=====" : "===== 最近对话原文 =====";
      parts.push(_rawHead + "\\n" + (raw || (_prevKeyForRaw ? "（上次检查点之后无新消息）" : "（无可用原始消息）")));`,
  "raw head"
);

fs.writeFileSync(P, t, "utf8");
console.log("written:", before, "->", t.length);
