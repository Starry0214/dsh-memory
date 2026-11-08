// _p25-wire-selftest.mjs — P2.5 会话主题接线（写侧）端到端自测
//
// 验证（对应 .task/1101-dsh-mimo-survey/12-p25-design.md §6 验收标准）：
//   A 首写：建「会话检查点·<wsKey>」线 + `<wsKey>/<sid8>` 主题 + 1 句
//   B 同会话二次写：覆盖更新，恒 1 句（不追加），内容是新
//   C 同工作区不同会话：独立主题、共享同一线
//   D 不同工作区：独立线（不串族）
//   E 无 cwd：回退原日期主题（老行为不变）
//   F 同 compactionId：幂等（duplicate，不再写）
//   G state=active（mem-p25 实测坑：结构性长名 seedTopic 会落 needs_review，必须显式置 active）
//
// 安全：os.tmpdir() 临时 home；不碰真实 ~/.dsh/memory。
import { useHome, mkHome, freshPlugin, makeCtx, applyPlugin, waitTopicDb, seedD8, todayStr, makeReporter, finish } from "./_accept-p0-lib.mjs";

const R = makeReporter("P2.5 会话主题接线（写侧）");
const CFG_ON = { memoryTopicDbEnabled: true };
const rand = () => Math.random().toString(36).slice(2, 7);
const SUM = (mark) => "## 本次目标\n- " + mark + "\n## 下一步状态\n- 自测造数\n## 关键结论\n- p25 wire";
const CWD_A = "E:\\工具\\测试项目A";
const CWD_B = "D:\\其他\\测试项目B";

useHome(mkHome("p25wire"));
const mod = await freshPlugin();
const { ctx } = makeCtx();
applyPlugin(mod, CFG_ON, ctx);
const ready = await waitTopicDb(mod);
R.ok(ready, "A0 前置：主题库就绪", ready ? "ready" : "not-ready");
const seeded = seedD8(mod);
R.ok(!!seeded, "A1 造数：D8 域 + 「会话检查点」线已建");
const store = mod.__topicdb && mod.__topicdb.store;
R.ok(!!store, "A1b 取到 store 句柄");
if (!store) { finish(R, true); }

// ═══ A：首写 ═══
const cid1 = "p25w-a-" + rand();
const r1 = mod.__topicdbIntentRoute(cid1, "a1b2c3d4", SUM("P25-MARK-1"), todayStr() + ".md", "session-a1b2c3d4", CWD_A);
R.ok(r1 && r1.mode === "db" && r1.ok !== false, "A2 首写成功（mode=db）", JSON.stringify(r1).slice(0, 200));
R.ok(r1 && r1.p25 === true, "A3 走会话主题路径（p25=true）", String(r1 && r1.p25));
R.ok(r1 && r1.topicName === "E-工具-测试项目A/a1b2c3d4", "A4 主题名 = <wsKey>/<sid8>", String(r1 && r1.topicName));
R.ok(r1 && r1.lineName === "会话检查点·E-工具-测试项目A", "A5 线名 = 会话检查点·<wsKey>", String(r1 && r1.lineName));
const sents1 = (store.readTopic(r1.topicId).sentences || []);
R.ok(sents1.length === 1, "A6 首写后句子数 = 1", "n=" + sents1.length);
R.ok(sents1.length === 1 && String(sents1[0].text).includes("P25-MARK-1"), "A7 正文含本次标记", "");
R.ok(sents1.length === 1 && String(sents1[0].text).includes("cwd E:\\工具\\测试项目A"), "A8 正文首行带 cwd（可审计）", "");
const tRow1 = store.topics().find((t) => t.id === r1.topicId);
R.ok(tRow1 && tRow1.state === "active", "A9 主题 state=active（不被 seed 判 needs_review）", String(tRow1 && tRow1.state));

// ═══ B：同会话二次写 ⇒ 覆盖，恒 1 句 ═══
const cid2 = "p25w-b-" + rand();
const r2 = mod.__topicdbIntentRoute(cid2, "a1b2c3d4", SUM("P25-MARK-2"), todayStr() + ".md", "session-a1b2c3d4", CWD_A);
R.ok(r2 && r2.p25 === true, "B1 二次写仍走会话主题", JSON.stringify(r2).slice(0, 160));
R.ok(r2 && r2.replaced === true, "B2 触发覆盖更新（replaced=true）", String(r2 && r2.replaced));
R.ok(r2 && r2.topicId === r1.topicId, "B3 同一主题（不新建）", String(r2 && r2.topicId) + " vs " + r1.topicId);
const sents2 = (store.readTopic(r1.topicId).sentences || []);
R.ok(sents2.length === 1, "B4 覆盖后仍恒 1 句（不追加）", "n=" + sents2.length);
R.ok(sents2.length === 1 && String(sents2[0].text).includes("P25-MARK-2") && !String(sents2[0].text).includes("P25-MARK-1"), "B5 内容是新的（旧句被替换）", "");

// ═══ C：同工作区不同会话 ⇒ 独立主题、共享线 ═══
const cid3 = "p25w-c-" + rand();
const r3 = mod.__topicdbIntentRoute(cid3, "b2c3d4e5", SUM("P25-MARK-3"), todayStr() + ".md", "session-b2c3d4e5", CWD_A);
R.ok(r3 && r3.p25 === true, "C1 同工作区另一会话写成功", "");
R.ok(r3 && r3.topicId !== r2.topicId, "C2 独立主题（不覆盖别人）", String(r3 && r3.topicId) + " vs " + r2.topicId);
R.ok(r3 && r3.lineName === r2.lineName, "C3 但共享同一条工作区线", String(r3 && r3.lineName));
R.ok(r3 && r3.topicName === "E-工具-测试项目A/b2c3d4e5", "C4 主题名带自己的 sid8", String(r3 && r3.topicName));

// ═══ D：不同工作区 ⇒ 独立线 ═══
const cid4 = "p25w-d-" + rand();
const r4 = mod.__topicdbIntentRoute(cid4, "c3d4e5f6", SUM("P25-MARK-4"), todayStr() + ".md", "session-c3d4e5f6", CWD_B);
R.ok(r4 && r4.p25 === true, "D1 另一工作区写成功", "");
R.ok(r4 && r4.lineName !== r3.lineName, "D2 独立线（跨工作区不串族）", String(r4 && r4.lineName));
R.ok(r4 && r4.lineName === "会话检查点·D-其他-测试项目B", "D3 线名按盘符+末两级归一", String(r4 && r4.lineName));

// ═══ E：无 cwd ⇒ 回退日期主题（老行为） ═══
const cid5 = "p25w-e-" + rand();
const r5 = mod.__topicdbIntentRoute(cid5, "d4e5f6a7", SUM("P25-MARK-5"), todayStr() + ".md", "session-d4e5f6a7");
R.ok(r5 && r5.mode === "db" && !r5.p25, "E1 无 cwd ⇒ 不走会话主题（回退日期主题）", JSON.stringify(r5).slice(0, 160));
R.ok(r5 && String(r5.topicName) === todayStr(), "E2 回退主题 = 日期", String(r5 && r5.topicName));

// ═══ F：幂等 ═══
const r6 = mod.__topicdbIntentRoute(cid1, "a1b2c3d4", SUM("P25-MARK-1"), todayStr() + ".md", "session-a1b2c3d4", CWD_A);
R.ok(r6 && r6.duplicate === true, "F1 同 compactionId 幂等（duplicate，不再写）", JSON.stringify(r6).slice(0, 160));

// ═══ G：D8 域唯一（不重复建域） ═══
const doms = store.topics().filter((t) => t && String(t.name).includes("日记忆（按天流水）"));
R.ok(doms.length === 1, "G1 全库只有 1 个 D8 域（未重复建域）", "n=" + doms.length);

// ═══ H：读侧 —— 同工作区取「上一个会话」，排除自己，跨区隔离 ═══
const prevAll = mod.__p25ReadPreviousSession(store, CWD_A, "ffffffff");
R.ok(prevAll && prevAll.sid8, "H1 读侧：取到同工作区最近的会话", String(prevAll && prevAll.sid8));
R.ok(prevAll && (prevAll.sid8 === "a1b2c3d4" || prevAll.sid8 === "b2c3d4e5"), "H2 读侧：只取本工作区会话", String(prevAll && prevAll.sid8));
const prevSelf = mod.__p25ReadPreviousSession(store, CWD_A, "a1b2c3d4");
R.ok(!prevSelf || prevSelf.sid8 !== "a1b2c3d4", "H3 读侧：排除当前会话自己", String(prevSelf && prevSelf.sid8));
R.ok(prevSelf && prevSelf.sid8 === "b2c3d4e5", "H4 读侧：排除自己后取到另一会话", String(prevSelf && prevSelf.sid8));
const prevB = mod.__p25ReadPreviousSession(store, CWD_B, "");
R.ok(prevB && prevB.sid8 === "c3d4e5f6", "H5 读侧：按工作区隔离（CWD_B 只读到自己的）", String(prevB && prevB.sid8));
const prevNone = mod.__p25ReadPreviousSession(store, "Z:\\不存在\\目录", "");
R.ok(prevNone === null, "H6 读侧：无匹配工作区 ⇒ null（不跨区兜底）", String(prevNone));
const prevText = prevAll && prevAll.text ? String(prevAll.text) : "";
R.ok(prevText.includes("## 检查点") && prevText.includes("P25-MARK"), "H7 读侧：返回 8 节检查点正文（含标记）", prevText.slice(0, 40));

finish(R, true);
