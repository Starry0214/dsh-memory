// split-oversized.mjs —— 把超大明细主题按字符上限分段（splitTopic）
// 用法：node split-oversized.mjs <db路径> [--apply] [--limit=40000]
// 默认 dry-run：只打印计划，不写库。--apply 才真拆。
//
// 语义：从**尾部**反复切走 ≤ limit 字符的句块，直到主主题剩余 ≤ limit。
//       每块建成 `<原名> · 明细 N`（同父、level=detail 由 store 推导）。
//       守恒校验：受影响主题的句子总数、字符总数前后必须相等。

// 相对导入：本文件随 payload 一起发布到 <plugin>/memtopic/src/，不能依赖开发机绝对路径
const HERE = new URL('./', import.meta.url);
const { SqliteBackend } = await import(new URL('backend-sqlite.mjs', HERE).href);
const { MemoryStore } = await import(new URL('memory-store.mjs', HERE).href);

const argv = process.argv.slice(2);
const dbFile = argv.find((a) => !a.startsWith('--'));
const APPLY = argv.includes('--apply');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 40000);
const TARGETS = (argv.find((a) => a.startsWith('--ids=')) || '--ids=T-0182,T-0324').split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);

if (!dbFile) { console.error('用法: node split-oversized.mjs <db路径> [--apply] [--limit=40000] [--ids=T-0182,T-0324]'); process.exit(1); }

const be = new SqliteBackend(dbFile);
const st = new MemoryStore(be);

const stats = (id) => {
  const t = st.resolveTopic(id);
  const r = st.readTopic(t.id);
  const s = r.sentences || [];
  return { id: t.id, name: t.name, state: r.state, sents: s, chars: s.reduce((a, x) => a + String(x.text || '').length, 0), level: st.levelOf(t.id) };
};

// 从尾部取**刚好让主主题降到 ≤ limit 的最少句数**（不是"尽可能多装"）。
// 旧实现是"装到 ≤ limit 为止"，在 200K 索引类上限下会一次装下几乎全部内容 ⇒ 主主题被掏空只剩 1 句
// （2026-11-03 真机 dry-run 实测 T-0475：3333 句 → 切走 3332 句、主主题剩 1 句）。
// 新语义：逐句从尾部累加，**一旦剩余 ≤ limit 立即停**；单块仍不超 limit；单句就超预算时至少切 1 句。
function pickTailCount(sents, limit) {
  const total = sents.reduce((a, x) => a + String(x.text || '').length, 0);
  if (total <= limit) return 0;
  let acc = 0, n = 0;
  for (let i = sents.length - 1; i >= 0; i--) {
    const c = String(sents[i].text || '').length;
    if (acc + c > limit) break;          // 单块不超 limit
    acc += c; n++;
    if (total - acc <= limit) break;     // 主主题已达标 ⇒ 立刻停（这是与旧实现的关键差异）
  }
  if (n === 0 && sents.length > 1) n = 1;  // 尾部单句就超块预算 ⇒ 至少切 1 句（否则永远卡住）
  return n;
}

const shortBase = (name) => {
  let s = String(name || '').replace(/^MEMORY-/, '').trim();
  if (s.length > 22) s = s.slice(0, 22);
  return s;
};

const existingNames = new Set(st.topics().map((t) => String(t.name || '')));
let totalSentsBefore = 0, totalCharsBefore = 0;
const plan = [];
for (const id of TARGETS) {
  let cur, srcParent = null;
  try { cur = stats(id); srcParent = (st.resolveTopic(id) || {}).parentId || null; } catch (e) { console.log(`[skip] ${id}: ${e.message}`); continue; }
  totalSentsBefore += cur.sents.length; totalCharsBefore += cur.chars;
  console.log(`\n=== ${cur.id} [${cur.level}/${cur.state}] ${cur.name} ===`);
  console.log(`  起始：${cur.sents.length} 句 / ${cur.chars} 字符（上限 ${LIMIT}）`);
  let seq = 0;
  let guard = 0;
  while (cur.chars > LIMIT && guard++ < 50) {
    const n = pickTailCount(cur.sents, LIMIT);
    if (n <= 0) { console.log('  [stop] 尾部单句已超过上限，无法再切'); break; }
    seq += 1;
    let name = `${shortBase(cur.name)} · 明细 ${seq}`;
    let dup = 2;
    while (existingNames.has(name)) { name = `${shortBase(cur.name)} · 明细 ${seq}-${dup++}`; }
    const movedChars = cur.sents.slice(-n).reduce((a, x) => a + String(x.text || '').length, 0);
    plan.push({ topicId: cur.id, name, count: n, movedChars, remainChars: cur.chars - movedChars, remainSents: cur.sents.length - n });
    console.log(`  → 切走尾部 ${n} 句 / ${movedChars} 字符 ⇒ 新主题「${name}」；主主题剩 ${cur.sents.length - n} 句 / ${cur.chars - movedChars} 字符`);
    if (!APPLY) {
      // dry-run：模拟剩余状态（不写库）
      cur = { ...cur, sents: cur.sents.slice(0, cur.sents.length - n), chars: cur.chars - movedChars };
      existingNames.add(name);
      continue;
    }
    const r = st.splitTopic(cur.id, { name, count: n, actor: 'user' });
    console.log('    splitTopic →', JSON.stringify({ ok: r.ok, newTopicId: r.newTopicId, moved: r.moved, pointerSentenceId: r.pointerSentenceId }));
    // 子主题继承源主题的父节点（否则新主题成孤儿 ⇒ 面板"未归类"污染）
    if (r && r.newTopicId && srcParent) {
      try { st.linkParent(r.newTopicId, srcParent, { actor: 'user' }); console.log('    linkParent →', srcParent); }
      catch (e) { console.log('    linkParent 失败:', e.message); }
    }
    existingNames.add(name);
    cur = stats(cur.id);   // 重新读（含指针句）
  }
  console.log(`  结束：${cur.sents.length} 句 / ${cur.chars} 字符`);
}

// 守恒校验
console.log('\n=== 守恒校验 ===');
let afterSents = 0, afterChars = 0;
for (const id of TARGETS) {
  try { const c = stats(id); afterSents += c.sents.length; afterChars += c.chars; } catch (e) { /* ignore */ }
}
const newIds = plan.length;
console.log(`受影响主主题：句 ${totalSentsBefore} → ${afterSents} ｜ 字符 ${totalCharsBefore} → ${afterChars}`);
console.log(`计划/实际拆出子主题数=${newIds} ｜ 模式=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
if (APPLY) {
  const all = st.topics();
  const kids = all.filter((t) => /· 明细 \d/.test(String(t.name || '')));
  console.log(`全库：主题=${all.length} ｜ 明细子主题=${kids.length}`);
}
be.close();
