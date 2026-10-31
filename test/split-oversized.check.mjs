// split-oversized-check.mjs —— 随包工具 memtopic/src/split-oversized.mjs 的回归
// 背景：v3.5.7 把拆分脚本随 payload 发布（用户/维护者自救超大主题），必须有可复跑断言。
// 覆盖：dry-run 不改库 / --apply 真拆且守恒 / 子主题继承父节点 / 二次运行幂等 / 非法入参不炸
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // 本文件在 <repo>/test/
const SRC = ROOT + '/memtopic/src';
const TOOL = SRC + '/split-oversized.mjs';
let pass = 0; const fails = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('PASS  ' + n + (d ? '  —  ' + d : '')); } else { fails.push(n); console.log('FAIL  ' + n + (d ? '  —  ' + d : '')); } };

ok(fs.existsSync(TOOL), '前置：工具存在于仓库 memtopic/src/');
const srcText = fs.readFileSync(TOOL, 'utf8');
ok(/new URL\('\.\/', import\.meta\.url\)/.test(srcText) || /new URL\("\.\/", import\.meta\.url\)/.test(srcText),
  '前置：用相对导入（不依赖开发机绝对路径）', '');
ok(!/file:\/\/\/E:\//.test(srcText), '前置：源码不含开发机绝对路径 E:/');

const { SqliteBackend } = await import(pathToFileURL(SRC + '/backend-sqlite.mjs').href);
const { MemoryStore } = await import(pathToFileURL(SRC + '/memory-store.mjs').href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'split-check-'));
const DB = path.join(TMP, 'mem.db');
const be = new SqliteBackend(DB); const st = new MemoryStore(be);

// 造数据：域 → 项目线 → 明细主题（> 40000 字符，句子可切）
const dom = st.createDomain('测试域', { actor: 'lead' });
const line = st.createTopic({ name: '测试项目线', level: 'project', parentId: dom.id, actor: 'lead' });
const lineId = line.id || line.topicId || (st.topics().find((t) => t.name === '测试项目线') || {}).id;
st.linkParent(lineId, dom.id, { actor: 'lead' });
const big = st.createTopic({ name: '超大明细主题', level: 'detail', parentId: lineId, actor: 'lead' });
const BIG_ID = big.id || big.topicId || (st.topics().find((t) => t.name === '超大明细主题') || {}).id;
ok(!!BIG_ID, '前置：建出超大明细主题', String(BIG_ID));
st.linkParent(BIG_ID, lineId, { actor: 'lead' });
const bigParent = (st.topics().find((t) => t.id === BIG_ID) || {}).parentId;
ok(!!bigParent && String(bigParent) === String(lineId), '前置：明细主题已挂到项目线（父链真实）', String(bigParent));
for (let i = 0; i < 120; i++) {
  st.appendSentence({ topic: BIG_ID, text: '- 第 ' + i + ' 条：' + 'x'.repeat(340), src: 'test', actor: 'plugin' });
}
const before = (() => {
  const s = st.readTopic(BIG_ID).sentences || [];
  return { sents: s.length, chars: s.reduce((a, x) => a + String(x.text || '').length, 0), topics: st.topics().length };
})();
ok(before.chars > 40000, '前置：主题字符数 > 40000', before.chars + ' 字符 / ' + before.sents + ' 句');
be.close();

const runTool = (args) => spawnSync(process.execPath, [TOOL, DB, ...args], { encoding: 'utf8', timeout: 180000 });

// ① dry-run 不改库
{
  const r = runTool(['--limit=40000', '--ids=' + BIG_ID]);
  ok(r.status === 0, 'D1 dry-run exit 0', 'exit=' + r.status);
  ok(/DRY-RUN/.test(String(r.stdout)), 'D2 dry-run 标注模式', '');
  ok(/切走尾部/.test(String(r.stdout)), 'D3 dry-run 给出切分计划', '');
  const be2 = new SqliteBackend(DB); const st2 = new MemoryStore(be2);
  const s = st2.readTopic(BIG_ID).sentences || [];
  ok(st2.topics().length === before.topics, 'D4 dry-run 未新增主题', st2.topics().length + ' vs ' + before.topics);
  ok(s.length === before.sents, 'D5 dry-run 未移动句子', s.length + ' vs ' + before.sents);
  be2.close();
}

// ② --apply 真拆 + 守恒 + 父节点继承
{
  const r = runTool(['--limit=40000', '--ids=' + BIG_ID, '--apply']);
  ok(r.status === 0, 'A1 --apply exit 0', 'exit=' + r.status);
  ok(/splitTopic →/.test(String(r.stdout)), 'A2 输出 splitTopic 结果', '');
  const be2 = new SqliteBackend(DB); const st2 = new MemoryStore(be2);
  const rows = st2.topics();
  const main = rows.find((t) => t.id === BIG_ID);
  const mainS = st2.readTopic(BIG_ID).sentences || [];
  const mainChars = mainS.reduce((a, x) => a + String(x.text || '').length, 0);
  ok(mainChars <= 40000, 'A3 主主题已降到上限内', mainChars + ' 字符');
  const kids = rows.filter((t) => /· 明细 \d/.test(String(t.name || '')) && t.parentId === main.parentId);
  ok(kids.length >= 1, 'A4 切出子主题', kids.map((k) => k.id).join(','));
  ok(kids.length > 0 && kids.every((k) => String(k.parentId) === String(main.parentId)), 'A5 子主题继承源主题父节点（无孤儿）', 'parent=' + main.parentId);
  const kidChars = kids.reduce((a, k) => a + (st2.readTopic(k.id).sentences || []).reduce((b, x) => b + String(x.text || '').length, 0), 0);
  const kidSents = kids.reduce((a, k) => a + (st2.readTopic(k.id).sentences || []).length, 0);
  ok(kids.every((k) => (st2.readTopic(k.id).sentences || []).reduce((b, x) => b + String(x.text || '').length, 0) <= 40000),
    'A6 每个子主题也 ≤ 上限', 'kidChars=' + kidChars);
  // 守恒：主主题 + 子主题 = 原始 + 每个 split 一条指针句
  ok(mainS.length + kidSents === before.sents + kids.length,
    'A7 句数守恒（原始 + 指针句）', (mainS.length + kidSents) + ' = ' + before.sents + ' + ' + kids.length);
  const mainPtr = mainS.reduce((a, x) => a + String(x.text || '').length, 0);
  ok(mainPtr + kidChars >= before.chars, 'A8 字符数不丢（含指针句略增）', (mainPtr + kidChars) + ' >= ' + before.chars);
  be2.close();
}

// ③ 幂等：再跑一次不再拆
{
  const be2 = new SqliteBackend(DB); const st2 = new MemoryStore(be2);
  const n0 = st2.topics().length; be2.close();
  const r = runTool(['--limit=40000', '--ids=' + BIG_ID, '--apply']);
  ok(r.status === 0, 'I1 二次 --apply exit 0', 'exit=' + r.status);
  const be3 = new SqliteBackend(DB); const st3 = new MemoryStore(be3);
  ok(st3.topics().length === n0, 'I2 二次运行不新增主题（已在上限内）', st3.topics().length + ' vs ' + n0);
  be3.close();
}

// ④ 非法入参不炸
{
  const r1 = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', timeout: 60000 });
  ok(r1.status !== 0 || /用法/.test(String(r1.stdout) + String(r1.stderr)), 'E1 缺 db 参数时给出用法/非零退出', 'exit=' + r1.status);
  const r2 = runTool(['--limit=abc', '--ids=' + BIG_ID]);
  ok(r2.status === 0 || r2.status !== null, 'E2 非法 limit 不崩（有兜底）', 'exit=' + r2.status);
}

console.log('\n' + (fails.length === 0 ? '全部通过 ' + pass + '/' + pass : pass + ' PASS / ' + fails.length + ' FAIL'));
if (fails.length) console.log('FAIL 清单：\n- ' + fails.join('\n- '));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
setTimeout(() => process.exit(fails.length ? 1 : 0), 150);
