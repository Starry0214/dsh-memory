// 验证 p25-topics API 签名（接线前）
import * as m from "../p25-topics.js";

const cwd = "E:\\工具\\插件开发调整";
const sid = "0ff4d999-476a-4bbc-941a-5c68aa8c0545";
const wsKey = m.normalizeWorkspace(cwd);
console.log("exports:", Object.keys(m).join(","));
console.log("normalizeWorkspace:", wsKey);
console.log("lineName:", m.lineName(wsKey));
console.log("sessionTopicName:", m.sessionTopicName(wsKey, "0ff4d999"));
console.log("sid8Of:", m.sid8Of ? m.sid8Of(sid) : "(no sid8Of)");
console.log("isSessionTopicName:", m.isSessionTopicName ? m.isSessionTopicName(m.sessionTopicName(wsKey, "0ff4d999")) : "?");
console.log("parse:", JSON.stringify(m.parseSessionTopicName(m.sessionTopicName(wsKey, "0ff4d999"))));
console.log("buildCheckpointHeader:", JSON.stringify(m.buildCheckpointHeader ? m.buildCheckpointHeader({ compactionId: "91a8aef6abcd", sessionId: sid, cwd }) : "(none)"));
