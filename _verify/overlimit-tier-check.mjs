// overlimit-tier-check.mjs —— 容量三档口径（Lead 2026-10-31）
// 背景：9,000 原本是 md 注入层预算，套到明细/索引主题上会永久误报（真机 dream 每轮都报
//   T-0263 408,198 字符 / T-0182 158,966 / T-0324 96,247「连续 N 轮未处理」）。
// 三档：主主题 9,000 ｜ 明细 detail 40,000 ｜ 索引类 200,000。
// 断言用**假 store**（buildOverLimitHealthLibWith 钩子），不碰真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/工具/插件开发调整';
const PLUGIN = ROOT + '/dsh-memory-plugin/index.js';
let pass = 0; const fails = [];
function ok(c, n, d) { if (c) { pass++; console.log('PASS  ' + n + (d ? '  —  ' + d : '')); } else { fails.push(n); console.log('FAIL  ' + n + (d ? '  —  ' + d : '')); } }

// 临时 MEMORY_ROOT（插件模块加载时会读 env）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-check-'));
const HOME = path.join(TMP, 'dsh-home'); const MEM = path.join(HOME, 'memory');
fs.mkdirSync(path.join(MEM, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(MEM, 'global.md'), '# g\n', 'utf8');
fs.writeFileSync(path.join(MEM, 'index.md'), '# i\n', 'utf8');
process.env.DSH_HOME = HOME; process.env.DSH_MEMORY_ROOT = MEM;
process.env.MEMTOPIC_DB = path.join(MEM, '.memtopic', 'mem.db');
delete process.env.MEMTOPIC_DIR;

const mod = await import(pathToFileURL(PLUGIN).href + '?tier=' + Date.now());
// 钩子在 apply() 末尾装配（模块级只是空壳）⇒ 必须真跑一次 apply 才有 buildOverLimitHealthLibWith
const { createFixtureCtx } = await import(pathToFileURL(ROOT + '/dsh-memory-plugin/_fixture-ctx.mjs').href);
const fx = createFixtureCtx({});
try { mod.default.apply(fx.ctx, {}); } catch (e) { console.log('apply 抛错:', e.message); }
await new Promise((r) => setTimeout(r, 150));
const hooks = mod.__dreamHooks || mod.DREAM_TEST_HOOKS || mod.__dreamTestHooks;
ok(!!hooks && typeof hooks.buildOverLimitHealthLibWith === 'function', '前置：测试钩子 buildOverLimitHealthLibWith 存在');
const limits = hooks && hooks.limits || {};
ok(limits.main === 9000 && limits.detail === 40000 && limits.index === 200000,
  '前置：三档常量 9000/40000/200000', JSON.stringify(limits));

// ── 假 store：topics() + readTopic() + levelOf() ──
function makeStore(defs) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    topics: () => defs.map((d) => ({ id: d.id, name: d.name, state: d.state || 'active' })),
    readTopic: (id) => ({ sentences: [{ text: 'x'.repeat(byId.get(id).chars) }] }),
    levelOf: (id) => byId.get(id).level,
  };
}

// E1 索引类 408,198 字符 ⇒ 走索引档、无「连续 N 轮未处理」、有季度分片建议
{
  const st = makeStore([{ id: 'T-IDX', name: '精确字面量索引（dsh-memory §9.12③）', chars: 408198, level: 'detail' }]);
  const r = hooks.buildOverLimitHealthLibWith(st, {});
  const line = (r.healthLines || []).join(' | ');
  ok(/索引类主题/.test(line), 'E1 索引类主题走独立条目', line.slice(0, 90));
  ok(!/连续\s*\d+\s*轮未处理/.test(line), 'E1b 索引类不得出现「连续 N 轮未处理」', line.slice(0, 90));
  ok(/按季度分片/.test(line), 'E1c 索引类提示按季度分片', '');
  ok(r.stuck && r.stuck['T-IDX'] && r.stuck['T-IDX'].tier === 'index' && r.stuck['T-IDX'].limit === 200000,
    'E1d stuck 记录 tier=index / limit=200000', JSON.stringify(r.stuck && r.stuck['T-IDX']));
}
// E2 索引类 50,000（< 200,000）⇒ 完全不告警
{
  const st = makeStore([{ id: 'T-IDX2', name: '精确字面量索引', chars: 50000, level: 'detail' }]);
  const r = hooks.buildOverLimitHealthLibWith(st, {});
  ok((r.healthLines || []).length === 0, 'E2 索引类 50,000 字符不告警', JSON.stringify(r.healthLines));
}
// E3 主主题 9,500 ⇒ 仍按 9,000 报（不因三档放宽）
{
  const st = makeStore([{ id: 'T-MAIN', name: '某项目线', chars: 9500, level: 'project' }]);
  const r = hooks.buildOverLimitHealthLibWith(st, {});
  const line = (r.healthLines || []).join(' | ');
  ok(/超限 9500 字符（上限 9000）/.test(line), 'E3 主主题 9,500 仍按 9,000 报', line.slice(0, 90));
  ok(r.stuck['T-MAIN'] && r.stuck['T-MAIN'].tier === 'main', 'E3b tier=main', JSON.stringify(r.stuck['T-MAIN']));
}
// E9 明细 45,000 ⇒ 按 40,000 报（不是 9,000），且无「连续 N 轮未处理」
{
  const st = makeStore([{ id: 'T-DET', name: '某明细', chars: 45000, level: 'detail' }]);
  const r = hooks.buildOverLimitHealthLibWith(st, { prevStuck: { 'T-DET': { rounds: 5 } } });
  const line = (r.healthLines || []).join(' | ');
  ok(/明细上限 40000/.test(line) && !/上限 9000/.test(line), 'E9 明细 45,000 按 40,000 报', line.slice(0, 100));
  ok(!/连续\s*\d+\s*轮未处理/.test(line), 'E9b 明细即使 rounds=5 也不催「连续 N 轮未处理」', line.slice(0, 100));
}
// E10 明细 39,000（我刚拆完的 5 段就在这个量级）⇒ 不告警
{
  const st = makeStore([{ id: 'T-DET2', name: '徕卡一瞬-近距漂移复刻1007-1008 · 明细 1', chars: 39919, level: 'detail' }]);
  const r = hooks.buildOverLimitHealthLibWith(st, {});
  ok((r.healthLines || []).length === 0, 'E10 明细 39,919 字符（拆分后实测值）不告警', JSON.stringify(r.healthLines));
}
// E11 主主题 rounds 升级逻辑保留
{
  const st = makeStore([{ id: 'T-MAIN2', name: '某项目线', chars: 12000, level: 'project' }]);
  const r = hooks.buildOverLimitHealthLibWith(st, { prevStuck: { 'T-MAIN2': { rounds: 1 } } });
  const line = (r.healthLines || []).join(' | ');
  ok(/连续 2 轮未处理/.test(line), 'E11 主主题第 2 轮仍升级为「连续 2 轮未处理」', line.slice(0, 100));
}
// E12 未超任何档 ⇒ 空
{
  const st = makeStore([
    { id: 'T-A', name: '普通主主题', chars: 8500, level: 'project' },
    { id: 'T-B', name: '普通明细', chars: 39000, level: 'detail' },
    { id: 'T-C', name: '精确字面量索引', chars: 150000, level: 'detail' },
  ]);
  const r = hooks.buildOverLimitHealthLibWith(st, {});
  ok((r.healthLines || []).length === 0, 'E12 三档都未超 ⇒ 零告警', JSON.stringify(r.healthLines));
}
// E5/E6 降噪：源码级断言（自动路径 no-candidate 不打 cwarn；显式 rel 仍打）
{
  const src = fs.readFileSync(PLUGIN, 'utf8');
  ok(/dbRes\.why === "no-candidate" && !rel/.test(src), 'E5 自动路径 no-candidate 有静默守卫（源码含 !rel 条件）');
  ok(/日摘要过期：库内归档不可用/.test(src), 'E6 显式 rel 的 warn 文案仍在（未被整段删除）');
}

console.log('\n' + (fails.length === 0 ? '全部通过 ' + pass + '/' + pass : pass + ' PASS / ' + fails.length + ' FAIL'));
if (fails.length) console.log('FAIL 清单：\n- ' + fails.join('\n- '));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
setTimeout(() => process.exit(fails.length ? 1 : 0), 200);
