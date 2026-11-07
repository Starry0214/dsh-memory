# 452 · CRA 变更风险审计：严格指针判据 + 迁移句数口径

- 审计对象（工作副本，未构建/未部署/未改库）：
  - `index.js` sha8 **`3188938C`**（sha256 `3188938C…13E99`，1,513,899B，21,255 行）
  - `tools/migrate-note-compact.mjs` sha8 **`3CBF69E2`**（26,786B，459 行）
  - 测试：`test/_note-compact-selftest.mjs`（89/89 我实跑）、`test/_note-migrate-selftest.mjs`（**13/14，D1 FAIL**，见 §6）
- 方法：只读静态核对 + 只读 SQL（真库/备份）+ 临时库边界实验 + 备份副本重放迁移；未改代码、未写真库。
- 本报告按 `/change-risk-audit` 模板：表1 调用链 / 表2 状态竞态 / 表3 边界 / 结论（推荐方案+护栏+影响面）+ G-0/G-9.1/G-9.2。

---

## 0. 结论（先给判断）

**修了再上（3 处小修；改动方向正确，但「严格」目前只做了一半）。**

| # | 必须修 | 证据 |
|---|---|---|
| F1 | **采纳模型 pointer 太信任**：严格判据只校验**格式**，不校验 sid8/count ⇒ 实测「sid8=deadbeef」「N=999」被**原样采用写库**；回溯会指错会话、N 虚报。修：采纳前校验 `sid8 === 主题名 sid8` 且 `count === snap.count`，或**总是由插件重生成**（推荐，见 §5）。 | `index.js#4076`；实验 `_cra-adopt-diag`：wrong-sid8 `ok=true,regen=false,written=…deadbeef…`；wrong-count `ok=true,regen=false,written=…999 句…` |
| F2 | **STRICT 与生成器不一致**：`noteFormatPointer` 在 sid8 缺失时**不输出 sid8 段**（`#3805-3806`），而 STRICT 要求必须有 ⇒ `strict=false`；且 `noteCompactValidate` 的 `requirePointerFormat` 仍用**宽松**判据（`#4008`）⇒ 实测「无 sid8 主题」被**静默写成非严格指针**（`ok=true`，库内最后一句 strict=false）。修：STRICT 的 sid8 段改可选（与生成器同源对齐），并在 append 前用 STRICT 校验最终 pointer。 | `#3782` vs `#3805-3806`；`#4008`；实验：`"2026-11-06 已提炼 2 句 → T-0008"` strict=false 且写库成功 |
| F3 | **迁移自测非 hermetic**：`_note-migrate-selftest` D1 直接读**真实库**并断言输出含「已提炼 N 句」；真机迁移后 0 待迁移 ⇒ 我实跑 **13/14 FAIL**（自报 14/14 不可复现）。改成 fixture DB 或允许 0 待迁移。 | `test/_note-migrate-selftest.mjs#104-111`；实跑输出 `FAIL D1 真实库 dry-run 可跑且句数列存在` |

**已通过（无需改）**：严格判据**没有**误用到识别/幂等/统计（仅采纳点 `#4076`）；`_noteDistilled` 用宽松判据（`#3820`）⇒ 11 个 strict 主题下轮会被正确跳过；迁移 N 口径与备份重放**逐条一致**（11 主题、删 9、墓碑 205→214，N 全对）；迁移幂等（当前 dry-run 待迁移 0）。

**过程风险（强烈建议补）**：真机迁移已在**宿主运行中 `--force`** 执行（G-5/9.4 违反），且代码部署到 4 profile **尚未重启** ⇒ 重启前旧代码仍可再写 legacy 指针；重启后宽松判据会把「legacy 指针在末尾」当已收敛、**永不重写**。缓解：重启后再跑一次迁移（幂等）或加一次性扫描（§7）。

---

## 1. 表 1 · 调用链与语义（全仓列点）

| 判据 | 调用点 | 语义 | 可疑点 |
|---|---|---|---|
| `isNotePointerText`（宽松双格式 `#3780/#3791`） | `#3820` `_noteDistilled`（候选过滤/末句判据）；`#3828` `noteUnrefinedCount`（口径 A/统计）；`#4008` `noteCompactValidate.requirePointerFormat`；`#4055` 幂等 skip；`#4141` 断言②；`#18587` memory_note dedup；`tools/migrate-note-compact.mjs#50/#157` | **识别/统计/幂等**（legacy 也算"指针"） | `#4008` 把宽松判据用于**校验最终 pointer** ⇒ F2；其余用法正确（严格判据未侵入） |
| `isStrictNotePointer`（`#3782/#3793`） | **仅** `#4076`（模型 pointer 能否原样采用）+ 导出/测试 | 采纳门槛（新格式 + 必含 sid8） | 只校验**格式**，不校验 sid8/count 语义 ⇒ F1 |
| `noteFormatPointer`（`#3799-3806`） | compact 重生成 `#4079`；迁移 `#171/#290`；测试 | 生成标准指针 | sid8 空 ⇒ 无 sid8 段 ⇒ strict=false（F2） |
| `_noteDistilled`（`#3818-3821`） | 候选池 `_notePool`、提炼块 `_noteRows` | 末句是**宽松**指针 ⇒ 已提炼完 | 正确：strict 指针被识别，legacy 也被识别（过渡期正确；但会固化窗口期 legacy，见 §7） |
| `noteTopicCompact`（`#4042-4167`） | settle `#19996`、replay `#4189` | D1 skip → 快照 → 采纳/重生成 → C2' 校验 → pending → append → 删快照内 sha 匹配句 → 三断言 | 采纳/重生成在 validate 之前；validate 后重读 live（`#4092`），无新增竞态（表 2） |
| 迁移 N 口径（`migrate#120-147/#164-166`） | dry-run `#166/#171`、applyPlan `#254-276/#289-290` | `已提炼 N 句 = marker 前 live 句数 + 该主题墓碑数`（旧式缺 topicId 按 sentenceId 反查物理行） | 真机验证一致（§4）；墓碑按 **topicId 全量**统计，未按 ord 过滤（潜在口径外延，见 §3） |

**反直觉用法检查**：严格判据只出现在采纳点 ✓；迁移脚本**另抄**一份宽松判据（`migrate#46-51`，与 index.js 不同源，长期漂移风险，低）。

---

## 2. 表 2 · 状态 / 线程竞态

| 场景 | 风险 | 结论 / 护栏 |
|---|---|---|
| 主 agent 并发 append（dream 收敛期间） | 低（既有设计） | 快照 `maxId` 先行；只删 `id<=maxId` 且 sha 匹配句；validate 后重读 live（`#4092`）⇒ 快照后新句必然幸存。改动 A 只改 pointer 文本选择，不改时序，**未新增竞态** |
| per-topic 锁 | 低 | 进程内 Map + 5min（`#4047-4049`，finally 释放 `#4165`）；改动未动锁 |
| pending 重放 | 低 | pending 存 strict/旧 pointer；replay 走同一 compact（`#4189-4191`）⇒ 旧 pending 的 legacy pointer 会被 F1/F2 逻辑重生成（修复方向正确） |
| 采纳模型 pointer 与主题状态 | **中** | 模型 pointer 的 sid8/count 不受主题约束（F1）：写库后「指针字节」与主题身份/句数可矛盾；**非竞态但影响持久数据** |
| 并发迁移（宿主运行中 --force） | **中** | 已发生（19:41 真机 apply）；apply 内 re-read topic + 最后一句必须 legacy（`migrate#282-285`）提供兜底，但 G-5/9.4 要求未满足；备份在（`mem.db.bak-note-compact-20261106114138` 25.18MB） |

---

## 3. 表 3 · 边界场景（会发生什么 + 兜底）

| 边界 | 实测/推断 | 兜底 |
|---|---|---|
| ① 主题名无 `/sid8` 后缀（wsKey 含空格/改名） | **实测**：`noteFormatPointer` 输出 `"2026-11-06 已提炼 2 句 → T-0008"`，`strict=false`；compact `ok=true` 且**写库**（库内最后一句 strict=false）⇒ F2 静默非严格 | 当前正常路径 wsKey 由 `normalizeWorkspace` 清洗（非法字符→`-`，`p25-topics.js#179-207`），**正常不可达**；改名/未来格式变化可达。修 F2（STRICT 的 sid8 段可选 + append 前严格校验） |
| ② targets 为空 | `parseNoteCompactPayload` schema 已拒（`#3943`）；compact 侧 `noteCompactValidate` 拒（`#4002`）⇒ 不写指针；`noteFormatPointer` 空 targets 兜底 `T-0000`（strict=true）但到不了 append | 已有 |
| ③ `snap.count=0` | `#4063-4065` skip empty-snapshot，不 append | 已有（K6/K7） |
| ④ targets >1（`T-0279/T-0069`） | **实测** `noteFormatPointer` 输出 `→ T-0279/T-0069`，strict=true；真库 T-0576 即为双 target strict ✓ | 已有 |
| ⑤ 模型 pointer 严格格式但 **sid8 错**（deadbeef） | **实测** `ok=true, regen=false`，原样写库 | **无**（F1） |
| ⑥ 模型 pointer 严格格式但 **N 错**（999） | **实测** `ok=true, regen=false`，原样写库 | **无**（F1） |
| ⑦ 模型给 legacy 文本（正常 sid8 主题） | **实测** 强制重生成 strict 指针 ✓（L1-L5、我的实验均通过） | 已有 |
| ⑧ 重生成后仍不合法 | 当前 `noteFormatPointer` 输出恒满足**宽松**判据 ⇒ validate 恒过；只有「无 sid8」时输出非严格（F2）。**不会死循环**；但若未来把 validate/识别改为 strict，则每轮 `VALIDATION_FAILED`（写前失败、不回滚）⇒ 主题永不收敛、dream 每轮重复提炼（重复写长期库） | 修 F2 + append 前 strict 断言 |
| ⑨ 迁移重复跑 | **实测**：当前真库 dry-run → 待迁移 0（11 already-pointer + 1 last-not-marker）；备份副本 `--apply --force` → 迁移 11、复核 0 | 幂等 ✓ |
| ⑩ 迁移 N 口径 | **实测**：备份副本重放 11 主题，N 与真库当前 11 条 strict 指针**逐条相等**（T-0559=2、T-0560=74、T-0561=1、T-0562=6、T-0564=2、T-0566=2、T-0569=1、T-0570=5、T-0571=1、T-0575=1、T-0576=6）；删旧句 9；墓碑 205→214；**真机墓碑全在 marker 之前**（tombAfterMarker=0）⇒ 口径当前正确。**潜在**：口径按 topicId 统计**全部**墓碑，若未来某 legacy-last 主题存在 marker 之后的删除（marker 后新 note 被删），N 会多算；建议按 `ord < marker.ord` 过滤或文档化假设 | 建议加 ord 过滤 |
| ⑪ 迁移 targets 抽取 | 真机 T-0576 的 legacy marker 原文 `→ T-0279（…work-log 17:30 已入 T-0069）`，`notePointerTargets` 抽出 **T-0279/T-0069**，新 strict 指针列双 target。属「prose 中的 T-id 被当 target」；不影响功能（targets 仅展示/回溯），但语义略过宽 | 迁移可只取 marker 主 target（首 T-id）或标注 |

---

## 4. 真机事实核对（只读，可复现）

| 项 | 结果 |
|---|---|
| 当前库 | 12 个笔记主题：**11 STRICT / 0 legacy / 1 unmarked（T-0558，本会话，live=4）**；11 条 strict 的 sid8 与主题名 **11/11 一致**（程序核对） |
| 迁移前备份 | `mem.db.bak-note-compact-20261106114138`（25.18MB）：11 legacy / 1 unmarked；墓碑 205 条 |
| 当前库墓碑 | 214 条（205+9，与删旧句 9 一致） |
| 备份副本重放迁移 | 11 迁移、删 9、复核 0；N 与当前指针逐条相等（见上）；备份 mode=vacuum-into |
| 迁移幂等 | 当前库 dry-run：`待迁移 0 · 跳过 12（last-not-marker=1、already-pointer=11）` |
| G-0 证据 | ①**17:55 真机 dream 轮**（monitor `compact-ok T-0560 deleted=74`，UTC 09:55）用**旧采纳逻辑**把 legacy 文本写进 T-0560；②备份（19:41）T-0560 最后一句 = `已提炼 → T-0172（2026-11-06 dream：…）`；③`noteFormatPointer` **只会**生成日期格式（`#3799-3806`）⇒ legacy 文本必来自模型 ⇒ 前提「模型会给 legacy 文本」成立（**推断**：由格式来源反推；另有直接证据：会话日志 `9a5a613a#f41` 中 dream 曾 append `已提炼 → T-0172（2026-11-05 dream：…）`） |
| 测试 | `_note-compact-selftest` **89/89** ✓；`_note-migrate-selftest` **13/14**（D1 FAIL，非 hermetic，见 §6） |

---

## 5. 方案对比（≥2 个更小/更稳替代）

| 方案 | 内容 | 评价 |
|---|---|---|
| **A（推荐）· 总是重生成** | 模型 pointer 只当参考（甚至忽略），compact 一律 `noteFormatPointer({count: snap.count, targets, sid8})`；STRICT 与生成器对齐（sid8 段可选）；append 前用 STRICT 校验最终 pointer | **最小信任面**：消除 F1（错 sid8/count/legacy）与 F2 一半；diff 小（删采纳分支 + 改一行正则）；代价：不再原样采用模型文本（无信息损失，字节由插件负责） |
| B · 保留采纳 + 语义校验 | 采纳条件加：`sid8 === 主题名 sid8` 且 `count === snap.count`；STRICT 的 sid8 段可选；append 前 strict 校验 | 保留模型文本；多 3 个条件，测试矩阵变大；仍可能采用「格式对但语义不符」的其他文本 |
| C · 只放宽正则 | 仅把 STRICT 的 sid8 段改可选 | 修 F2 边界，但 **不修 F1**（错 sid8/count 仍被采用）；不推荐单独用 |

推荐 **A**；若产品要求保留模型 pointer 文本，退而求其次用 B（并加 F1 的两条校验）。

---

## 6. 护栏清单（实现必须加）

1. **生成器/判据同源**：STRICT 正则必须与 `noteFormatPointer` 语法一致（sid8 段可选），并加单测矩阵：sid8 有/无 × targets 0/1/2 × count 0/74，断言 `isStrictNotePointer(noteFormatPointer(...)) === true`（当前 sid8 缺失 → false，须修）。
2. **append 前严格校验**：compact 在写指针前用 STRICT 校验最终 `pointerText`；失败 ⇒ 不写、`monitorEvent` 带值（topicId/model/final/targets/sid8/count），不得依赖宽松 `requirePointerFormat`。
3. **采纳语义校验（或直接 always-regenerate）**：`sid8 === 主题名 sid8`、`count === snap.count`、targets 集合一致；否则重生成。
4. **日志带值**：采纳/regen 都要记 `topicId、modelPointer、finalPointer、targets、sid8、count、strict`（现在 regen 行有 targets+model，采纳无日志、无 sid8/count 校验）。
5. **迁移口径**：N 只统计 marker **之前**的墓碑（`ord < marker.ord`）或显式文档化「全量墓碑」假设；`targets` 抽取建议只取 marker 主 target（首 T-id）或注明 prose 可能带入额外 T-id。
6. **迁移自测 hermetic**：D1 改为 fixture DB（或用临时库造 legacy 场景），禁止读真实 `~/.dsh/memory`；否则迁移后门必红。
7. **部署顺序**：迁移已 apply + 代码未重启 ⇒ 重启后再跑一次 `migrate-note-compact`（幂等，0 待迁移即通过）以清理窗口期 legacy；或在启动时加一次性「legacy-last 扫描/改写」。
8. **一次性/幂等**：迁移已有单事务 + 幂等复核（✓）；不要新增常驻扫描（成本）。

---

## 7. 影响面结论（Q8）

| 面 | 是否波及 | 说明 |
|---|---|---|
| dream 收敛核心 | **是（弱）** | 采纳更严 ⇒ 更多重生成（预期）；识别/幂等/统计仍宽松 ⇒ 11 strict 主题正确跳过、T-0558 正常处理；无 legacy 反复提炼风险（严格判据未侵入识别） |
| 检索（session_search） | **是（间接）** | 指针 sid8 是回溯键；F1 采纳错 sid8 会误导回溯（当前真库 11/11 正确；未来风险） |
| 面板统计 | 否 | `noteUnrefinedCount`/`noteUnrefinedStats` 用宽松判据（`#3828`），strict 指针照常计 0 |
| 启动 | 否 | 无启动路径依赖 STRICT；pending 重放走同一 compact（旧 pending 会被重生成） |
| 数据一致性 | **是** | 迁移已 apply：N 口径与备份重放逐条一致（11/删 9/墓碑 205→214）、幂等 0；备份在。风险在过程（宿主运行中 --force）与窗口期 legacy |
| 性能 | 否 | 每 compact item 多一次正则判断，可忽略 |

---

## 8. G-0 观测证据（硬门）

- **前提「模型会给 legacy 文本」成立**：
  - 直接证据：会话日志 `9a5a613a#f41`（dream 曾 append `已提炼 → T-0172（2026-11-05 dream：…）`）；
  - 真机链路证据：2026-11-06 **17:55**（UTC 09:55）dream 轮 `compact-ok T-0560 deleted=74`（`.monitor.json` events），19:41 备份中 T-0560 最后一句仍是 **legacy** 格式；而 `noteFormatPointer` 只产日期格式 ⇒ 该 legacy 文本来自模型、被旧宽松采纳逻辑原样写库（**推断**：格式来源反推，但链条完整）。
- 结论：改动 A 的前提有真机证据；**但采纳语义校验缺失（F1）是同一链路上的新风险**。

## 9. G-9.1 产出物判据（本次改动**会改变写入库的指针字节**）

**基线（当前真库，2026-11-06 19:5x）**：12 笔记主题 = 11 STRICT / 0 legacy / 1 unmarked（T-0558）；11 条 strict 的 sid8 与主题名 11/11 一致。

**可执行验证（只读）**：

```bash
# 1) 列出每个非归档笔记主题的最后一句 + 分类（STRICT / legacy / unmarked）+ sid8 是否与主题名一致
node -e "const os=require('os'),path=require('path');const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(os.homedir(),'.dsh','memory','.memtopic','mem.db'),{readOnly:true});const R=/^\\d{4}-\\d{2}-\\d{2} 已提炼 \\d+ 句 → T-\\d+(?:\\/T-\\d+)*(?:[（(][^）)]*sid8=[0-9a-f]{8}[^）)]*[）)])$/;const L=/已提炼\\s*→\\s*T-\\d+/;const del=new Set(JSON.parse(String((db.prepare(\"SELECT value FROM meta WHERE key='deleted.index'\").get()||{}).value||'[]')).map(e=>Number(e.sentenceId)));for(const t of db.prepare(\"SELECT id,name FROM topics WHERE name LIKE '笔记·%' AND state!='archived'\").all()){const s=db.prepare('SELECT id,body FROM sentences WHERE topic_id=? ORDER BY ord').all(t.id).filter(r=>!del.has(Number(r.id)));const last=s.length?String(s[s.length-1].body):'';const ps=(/sid8=([0-9a-f]{8})/.exec(last)||[])[1]||'';const ns=(/^[^\\s/\\\\]{1,200}\\/([0-9a-f]{8})/.exec(String(t.name))||[])[1]||'';console.log(t.id, R.test(last.trim())?'STRICT':(L.test(last)?'legacy':'unmarked'), 'sid8Match='+(ps===ns), JSON.stringify(last.slice(0,90)));}"

# 2) 期望（现在）：11 行 STRICT + 1 行 unmarked（T-0558）；legacy=0；11 条 STRICT 的 sid8Match=true
# 3) 下次 dream 收敛后（重启生效后）：仍应 11 STRICT / 0 legacy；新增/更新的指针必须 STRICT 且 sid8Match=true
# 4) 不再出现 legacy：上表 legacy 计数必须为 0；另查 monitor：`compact-ok … regen=1` 说明模型给过 legacy 被重生成（正常），`compact-rollback` 必须为 0
# 5) 迁移幂等：node tools/migrate-note-compact.mjs  → 期望「待迁移 0 · already-pointer=11、last-not-marker=1」
```

**失败判据**：出现 legacy 行、或 STRICT 行 `sid8Match=false`、或 `待迁移>0` ⇒ 立即停手（G-9.4 单改动单验证）。

## 10. G-9.2 反面问题：它可能怎样让现有功能失效（≥3 条）

1. **采纳错 sid8/错 N（已实测）**：模型 pointer 严格格式但 sid8=deadbeef / N=999 被原样写库 ⇒ 指针回溯指错会话、句数虚报；G-9.1 的「命中 STRICT 且含 sid8」**看不出错**（格式仍合法）⇒ 必须补 sid8/count 校验。
2. **无 sid8 主题静默写非严格指针（已实测）**：`noteFormatPointer` 无 sid8 段 + validate 宽松 ⇒ 写库成功但 strict=false；若未来把识别/校验收紧为 STRICT，则每轮 `VALIDATION_FAILED`（写前失败、无回滚）⇒ 主题永不收敛、dream 每轮重复提炼并重复写长期库。
3. **窗口期 legacy 被固化**：代码部署 4 profile 未重启，旧宽松采纳逻辑仍可写 legacy 指针；重启后 `_noteDistilled` 用宽松判据 ⇒ 该主题被当「已收敛」跳过，**永不重写**；「0 legacy」目标落空（需重启后再跑迁移/一次性扫描）。
4. **迁移 N 口径外延**：若未来某 legacy-last 主题存在 marker 之后被删的 note（墓碑 ord > marker ord），N 会多算 ⇒ 「已提炼 N 句」虚报（不影响删句正确性；建议 ord 过滤）。
5. **迁移 targets 抽取过宽**：legacy marker 的 prose 里提到其他 T-id 会被当 target（真机 T-0576 → T-0279/T-0069）⇒ 指针归属语义变宽；不影响收敛，但影响人工回溯判断。
6. **迁移在宿主运行中 --force**：G-5/9.4 要求「单改动单验证 + 回滚包 + 停宿主」；本次已发生。若并发写正好落在 apply 窗口，依赖「最后一句必须 legacy + 事务回滚」兜底（代码有），但未做并发故障注入验证。

---

## 11. 诚实缺口

1. 未在真实宿主进程内观察下一次 dream 收敛（代码未重启生效）；「模型在新 JSON 通道下仍会给 legacy 文本」由 17:55 旧轮 + 格式来源反推（**推断**），非直接抓取模型 JSON。
2. 未做并发写故障注入（宿主运行中 --force 迁移的实际并发窗口）；只在备份副本重放验证。
3. 未验证 4 个 profile 的实际部署内容/重启状态（仅按任务书指纹核对工作副本）。
4. 未验证 `noteFormatPointer` 无 sid8 边界在**正常路径**的可达性（`normalizeWorkspace` 清洗非法字符 ⇒ 推断正常不可达；改名/未来格式变化可达）。
5. 未验证「迁移后再次出现 legacy-last」的自动清理（无该机制，需重启后手动再跑迁移）。
6. 未检查历史 legacy marker 的 targets 抽取全部案例（只抽查 T-0576/T-0559/T-0560）。

---

*CRA 只读审计：未修改代码、未构建、未部署、未写数据库。*
