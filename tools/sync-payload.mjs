#!/usr/bin/env node
/**
 * 把插件运行时文件打成可分发 payload zip + install-manifest.json。
 *
 *   node tools/sync-payload.mjs                 # 生成 payload/<name>.zip + install-manifest.json
 *   node tools/sync-payload.mjs --fixed-time    # generatedAt 固定 1980-01-01（CI/可复现自测用）
 *   node tools/sync-payload.mjs --stamp <ISO>   # 指定 generatedAt
 *   node tools/sync-payload.mjs --check         # 只校验现有产物是否与源文件一致（不写盘）
 *   node tools/sync-payload.mjs --list          # 列出将要打包的文件
 *   node tools/sync-payload.mjs --out /tmp/rel  # 换输出目录（zip 放 <out>/payload/，manifest 放 <out>/）
 *
 * 确定性约定：
 *   - zip 本身始终确定：条目按路径字典序排序；DOS 时间戳固定 1980-01-01 00:00:00；无 extra
 *     field；deflate level 固定；不写注释 —— 同样的输入产生逐字节相同的 zip。
 *   - manifest 的 generatedAt 默认是**真实构建时间**（用户排查"装的是哪一版"会看它）；
 *     需要可复现时加 --fixed-time（固定 1980-01-01T00:00:00.000Z）。
 *   - `--check` 比对 files/zip 的 sha 与大小（忽略 generatedAt 的时间差异）。
 *   - 依赖 Node 内置 zlib 的 deflateRawSync；跨大版本 Node 升级后 zip sha 可能变化，
 *     但 zip 与 manifest 总是一起重新生成，不影响安装器校验。
 *
 * 版本号来源：version.txt（并交叉校验 package.json==version.txt 与 index.js 的 PLUGIN_VERSION）。
 * 打包内容（相对插件根目录，写进 zip 的路径也长这样）：
 *   index.js / package.json / version.txt / AGENTS.template.md
 *   p3-cost.js / p3-triggers.js / p3-readside.js / p25-topics.js   （index.js 静态 import 的运行时模块，缺一即加载失败）
 *   client/**                （排除 node_modules / *.bak* / .config.json）
 *   memtopic/src/*.mjs       （全部运行时模块，含 migrate.mjs）
 *
 * 退出码：0 成功 / 一致；1 参数或校验失败；2 输入缺失。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const FIXED_STAMP = '1980-01-01T00:00:00.000Z';
const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000; // 00:00:00

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { out: ROOT, stamp: 'now', check: false, list: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (name) => {
      const eq = a.indexOf('=');
      if (eq >= 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${name}`);
      return v;
    };
    if (a === '--check') o.check = true;
    else if (a === '--list') o.list = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--fixed-time' || a === '--fixed') o.stamp = FIXED_STAMP;
    else if (a.startsWith('--out')) o.out = path.resolve(take('--out'));
    else if (a.startsWith('--stamp')) o.stamp = take('--stamp');
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return o;
}

function fail(msg) {
  console.error(`sync-payload: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 收集输入文件
// ---------------------------------------------------------------------------
const SKIP_NAME = [/^\.config\.json$/, /\.bak/i, /^_inj-boot-/i];
const SKIP_DIR = new Set(['node_modules', '_verify', '.git']);

function shouldSkip(rel, name) {
  if (SKIP_DIR.has(name)) return true;
  if (SKIP_NAME.some((re) => re.test(name))) return true;
  return false;
}

function walk(root, relDir, out) {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return;
  for (const name of fs.readdirSync(abs).sort()) {
    const rel = relDir ? `${relDir}/${name}` : name;
    const st = fs.statSync(path.join(abs, name));
    if (st.isDirectory()) {
      if (shouldSkip(rel, name)) continue;
      walk(root, rel, out);
    } else if (st.isFile()) {
      if (shouldSkip(rel, name)) continue;
      out.push(rel);
    }
  }
}

function collect() {
  const files = [];
  // [4.5.10 MF4] P3 模块必须随 payload 分发：index.js 静态 import 它们，缺文件 = 插件加载失败
  //   （本机走 _verify/deploy-p3.mjs 复制模块所以长期未暴露；从 payload/install.ps1 全新安装会挂）。
  for (const rel of ['index.js', 'package.json', 'version.txt', 'AGENTS.template.md', 'tools/session-search.mjs',
    'p3-cost.js', 'p3-triggers.js', 'p3-readside.js', 'p25-topics.js']) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) fail(`missing required input: ${rel}`);
    files.push(rel);
  }
  walk(ROOT, 'client', files);
  walk(ROOT, 'memtopic/src', files);
  // [4.5.14] 3D 图谱第三方库随 payload 分发：路由优先插件目录 vendor/，安装版图谱才能加载
  //   （历史只在 ~/.dsh/memory/vendor 手工放置，全新安装会 404）。
  walk(ROOT, 'vendor', files);
  // 只打 .mjs 运行时模块（spec/、.run/、*.json 不随 payload 分发）；vendor 只保留 .js 实体
  const filtered = files.filter((rel) => {
    if (rel.startsWith('memtopic/src/')) return rel.endsWith('.mjs');
    if (rel.startsWith('vendor/')) return rel.endsWith('.js');
    return true;
  });
  filtered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return filtered;
}

function readVersion() {
  const p = path.join(ROOT, 'version.txt');
  const v = fs.readFileSync(p, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) fail(`version.txt does not look like x.y.z: ${JSON.stringify(v)}`);
  return v;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// 最小 ZIP 写入器（deterministic / no dependency）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  // entries: [{ path, data }]
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed (2.0, deflate)
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    lfh.writeUInt16LE(8, 8); // method: deflate
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    local.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0x81a40000, 38); // external attrs: -rw-r--r--
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, eocd]);
}

// 读回 zip 的中央目录，逐个核对 name/crc/uncompressed 大小（--check 用）
function inspectZip(buf) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos < 0) fail('not a zip: EOCD not found');
  const count = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdStart = buf.readUInt32LE(eocdPos + 16);
  const entries = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('bad central directory signature');
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    entries.push({ name, crc, csize, usize, off });
    p += 46 + nlen + elen + clen;
  }
  if (p !== cdStart + cdSize) fail('central directory size mismatch');
  return entries;
}

function inflateEntry(zip, ent) {
  if (zip.readUInt32LE(ent.off) !== 0x04034b50) fail(`bad local header for ${ent.name}`);
  const nlen = zip.readUInt16LE(ent.off + 26);
  const elen = zip.readUInt16LE(ent.off + 28);
  const start = ent.off + 30 + nlen + elen;
  const comp = zip.subarray(start, start + ent.csize);
  const raw = ent.usize === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(comp);
  if (raw.length !== ent.usize) fail(`size mismatch for ${ent.name}`);
  if (crc32(raw) !== ent.crc) fail(`crc mismatch for ${ent.name}`);
  return raw;
}

// ---------------------------------------------------------------------------
// 构建 / 校验
// ---------------------------------------------------------------------------
function build(stamp) {
  const version = readVersion();
  const rels = collect();
  const entries = rels.map((rel) => ({ path: rel, data: fs.readFileSync(path.join(ROOT, rel)) }));
  const files = entries.map((e) => {
    const rec = { path: e.path, bytes: e.data.length, sha256: sha256(e.data) };
    // [2026-11-08 分发修复] CLI 条目附 version：安装器 CheckOnly / 覆盖判断用（旧安装器忽略未知字段，兼容）
    if (e.path === 'tools/session-search.mjs') {
      const m = e.data.toString('utf8').match(/const CLI_VERSION = "([^"]+)"/);
      if (m) rec.version = m[1];
    }
    return rec;
  });
  const zipBuf = buildZip(entries);
  const zipName = `dsh-memory-${version}.zip`;
  const generatedAt = stamp === 'now' ? new Date().toISOString() : new Date(stamp).toISOString();
  const manifest = {
    version,
    generatedAt,
    files,
    zip: { name: zipName, bytes: zipBuf.length, sha256: sha256(zipBuf) },
  };
  return { version, rels, entries, zipBuf, manifest, zipName };
}

function versionHints() {
  const lines = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const v = readVersion();
    if (pkg.version !== v) lines.push(`WARN package.json version ${pkg.version} != version.txt ${v}`);
  } catch (e) {
    lines.push(`WARN package.json unreadable: ${e.message}`);
  }
  try {
    const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const m = idx.match(/const PLUGIN_VERSION\s*=\s*"([^"]+)"/);
    const v = readVersion();
    if (m && m[1] !== v) lines.push(`WARN index.js PLUGIN_VERSION ${m[1]} != version.txt ${v}`);
    if (!m) lines.push('WARN index.js has no PLUGIN_VERSION constant');
  } catch (e) {
    lines.push(`WARN index.js unreadable: ${e.message}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'memtopic/src/migrate.mjs'))) {
    lines.push('NOTE memtopic/src/migrate.mjs 尚未就绪（task-51）：本次 payload 里 -Migrate 只能做检测');
  }
  return lines;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const built = build(o.stamp);
  const { version, entries, zipBuf, manifest, zipName } = built;
  const zipPath = path.join(o.out, 'payload', zipName);
  const manifestPath = path.join(o.out, 'install-manifest.json');
  const totalBytes = entries.reduce((n, e) => n + e.data.length, 0);

  if (o.list) {
    for (const e of entries) console.log(`${String(e.data.length).padStart(9)}  ${e.path}`);
    console.log(`---- ${entries.length} files, ${totalBytes} bytes`);
    return;
  }

  if (o.check) {
    const problems = [];
    if (!fs.existsSync(zipPath)) problems.push(`missing ${path.relative(ROOT, zipPath)}`);
    else {
      const onDisk = fs.readFileSync(zipPath);
      if (!onDisk.equals(zipBuf)) problems.push('payload zip differs from a fresh build');
      else {
        const entriesOnDisk = inspectZip(onDisk);
        if (entriesOnDisk.length !== entries.length) problems.push('zip entry count mismatch');
        const srcByName = new Map(entries.map((e) => [e.path, e.data]));
        for (const ent of entriesOnDisk) {
          const raw = inflateEntry(onDisk, ent);
          const src = srcByName.get(ent.name);
          if (!src) problems.push(`unexpected entry in zip: ${ent.name}`);
          else if (sha256(raw) !== sha256(src)) problems.push(`entry content mismatch: ${ent.name}`);
        }
      }
    }
    if (!fs.existsSync(manifestPath)) problems.push('missing install-manifest.json');
    else {
      const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const cmp = (k) => JSON.stringify(onDisk[k]) !== JSON.stringify(manifest[k]);
      // generatedAt 是构建时间，天然每次不同 —— 不参与一致性判定（--fixed-time 时才比较）
      for (const k of ['version', 'files', 'zip']) {
        if (cmp(k)) problems.push(`install-manifest.json differs from a fresh build (${k})`);
      }
      if (o.stamp !== 'now' && cmp('generatedAt')) problems.push('install-manifest.json differs from a fresh build (generatedAt)');
    }
    if (!o.quiet) {
      console.log(`payload : ${path.relative(ROOT, zipPath)}  ${zipBuf.length} bytes  sha256=${sha256(zipBuf)}`);
      console.log(`manifest: ${path.relative(ROOT, manifestPath)}`);
      console.log(`files   : ${entries.length} files, ${totalBytes} bytes`);
    }
    if (problems.length) {
      console.error('CHECK FAILED:');
      for (const p of problems) console.error('  - ' + p);
      process.exit(1);
    }
    console.log('CHECK OK: payload + manifest are in sync with the sources');
    return;
  }

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, zipBuf);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (!o.quiet) {
    for (const l of versionHints()) console.log(l);
    console.log(`wrote ${path.relative(ROOT, zipPath)}`);
    console.log(`wrote ${path.relative(ROOT, manifestPath)}`);
    console.log('');
    console.log(`version     : ${version}`);
    console.log(`generatedAt : ${manifest.generatedAt}`);
    console.log(`files       : ${entries.length} (${totalBytes} bytes raw)`);
    console.log(`zip         : ${zipBuf.length} bytes`);
    console.log(`zip sha256  : ${manifest.zip.sha256}`);
  }
}

main();
