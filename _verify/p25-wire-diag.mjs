// 诊断：p25WriteSessionTopic 为什么返回 ok:false
import { useHome, mkHome, freshPlugin, makeCtx, applyPlugin, waitTopicDb, seedD8, todayStr } from "../test/_accept-p0-lib.mjs";

const CFG_ON = { memoryTopicDbEnabled: true };
const CWD_A = "E:\\工具\\测试项目A";

useHome(mkHome("p25diag"));
const mod = await freshPlugin();
const { ctx } = makeCtx();
applyPlugin(mod, CFG_ON, ctx);
const ready = await waitTopicDb(mod);
console.log("topicdb ready:", ready);
const seeded = seedD8(mod);
console.log("seedD8:", JSON.stringify(seeded));
const store = mod.__topicdb.store;
console.log("store keys:", Object.keys(store).join(","));

const r = mod.__p25WriteSessionTopic(store, {
  compactionId: "diag-1",
  sid8: "sidp25a",
  sessionId: "session-p25a",
  cwd: CWD_A,
  sum: "## 本次目标\n- 诊断\n## 关键结论\n- ok",
  fname: todayStr() + ".md",
});
console.log("p25WriteSessionTopic =>", JSON.stringify(r, null, 1));

if (r && r.ok) {
  console.log("sentences:", JSON.stringify((store.readTopic(r.topicId).sentences || []).map((s) => String(s.text).slice(0, 40))));
  const t = store.topics().find((x) => x.id === r.topicId);
  console.log("topic row:", JSON.stringify({ id: t.id, name: t.name, parentId: t.parentId, state: t.state }));
  const line = store.topics().find((x) => x.id === r.lineId);
  console.log("line row:", JSON.stringify({ id: line.id, name: line.name, parentId: line.parentId, state: line.state }));
  console.log("all topics:", JSON.stringify(store.topics().map((x) => ({ id: x.id, name: x.name, p: x.parentId, st: x.state })), null, 1));
}
