// 面板优化：① 不展示 hostUsage（历史混合桶）② 分环节表 / Top 会话表自动隐藏全空列
import fs from "node:fs";

const P = "C:/Users/Starry/.dsh/memory/.stats-panel.html";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-hidecols-" + Date.now().toString(36), t);

// ── ① COST_KIND_ORDER 去掉 hostUsage ──
const O1 = 'var COST_KIND_ORDER = ["checkpointWrite", "rebuildInject", "startupInject", "recallReminder", "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export", "hostSub", "hostMain", "hostUsage"];';
const N1 = 'var COST_KIND_ORDER = ["checkpointWrite", "rebuildInject", "startupInject", "recallReminder", "hintA", "hintB", "hintC", "memorySearch", "dream", "maint", "archive", "export", "hostSub", "hostMain"];   // hostUsage（历史混合桶）不展示';
if (t.indexOf(O1) < 0) throw new Error("O1 not found");
t = t.replace(O1, N1);
console.log("OK ORDER");

// ── ② 替换 costKindsHtml（动态列 + 过滤 hostUsage）──
const KIND_START = "function costKindsHtml(cost) {";
const KIND_END = "function costTopHtml(cost) {";
const ki = t.indexOf(KIND_START), kj = t.indexOf(KIND_END);
if (ki < 0 || kj < 0 || ki > kj) throw new Error("kinds func boundary not found");
const NEW_KINDS = `function costKindsHtml(cost) {
  // [2026-11-02] 两处改动：① hostUsage（历史混合桶，主+子混、totalTokens 虚高）不再展示；
  //   ② 全空列自动隐藏 —— 检查点「输出字符/真实 tokens/均时长」要等 writer 结算记账后才有，
  //   硬渲染成一排 "-" 会让人误以为数据丢失。
  var order = ((Array.isArray(cost.kindList) && cost.kindList.length) ? cost.kindList.slice() : COST_KIND_ORDER.slice())
    .filter(function (k) { return k !== "hostUsage"; });
  var todayKinds = costIsObj(cost.byKind) ? cost.byKind : (costIsObj(cost.today) && costIsObj(cost.today.kinds) ? cost.today.kinds : null);
  var cumKinds = (costIsObj(cost.cumulative) && costIsObj(cost.cumulative.kinds)) ? cost.cumulative.kinds : null;
  var kinds = todayKinds, scope = "今日";
  if (!kinds || !costKindsActive(kinds, order)) {
    if (cumKinds && costKindsActive(cumKinds, order)) { kinds = cumKinds; scope = "累计（今日暂无环节记账）"; }
  }
  var h = '<div class="card glass span2 cost-card" id="cost-kinds">';
  h += '<h2>分环节消耗<span class="h2n">' + costEsc(scope) + " · kindList 固定顺序</span></h2>";
  if (!kinds || !costKindsActive(kinds, order)) {
    h += '<div class="cost-empty">暂无消耗数据（各环节尚无记账记录，cost.today.kinds 与 cost.cumulative.kinds 均为空）</div></div>';
    return h;
  }
  // 第一遍：收集行数据 + 判定列可见性
  var rowsData = [];
  for (var i = 0; i < order.length; i++) {
    var kind = order[i];
    if (typeof kind !== "string" || !kind) continue;
    var rec = costIsObj(kinds[kind]) ? kinds[kind] : {};
    if (!costHasActivity(kind, rec)) continue;
    var n = /^host/.test(kind) ? (costN(rec.turns) || costN(rec.n)) : costN(rec.n);
    var inTok = costN(rec.inTokens), outTok = costN(rec.outTokens), totalTok = costN(rec.totalTokens);
    var estTok = costN(rec.estTokens), durMs = costN(rec.durMs);
    var fail = costN(rec.fail), retry = costN(rec.retry), timeout = costN(rec.timeout);
    var chIn = "-";
    if (kind === "memorySearch") { if (costN(rec.resultChars) > 0) chIn = costShort(costN(rec.resultChars)); }
    else if (costN(rec.inChars) > 0) chIn = costShort(costN(rec.inChars));
    else if (costN(rec.injectedChars) > 0) chIn = costShort(costN(rec.injectedChars));
    var chOut = costN(rec.outChars) > 0 ? costShort(costN(rec.outChars)) : "-";
    var realCell = (inTok || outTok) ? (costShort(inTok) + " / " + costShort(outTok)) : (totalTok ? costShort(totalTok) : "-");
    var durCell = costDur(durMs, n);
    var failCell = fail ? ('<span class="warn">' + costNum(fail) + "</span>") : (retry ? "重试 " + costNum(retry) : (timeout ? "超时 " + costNum(timeout) : "0"));
    rowsData.push({ kind: kind, rec: rec, n: n, chIn: chIn, chOut: chOut, realCell: realCell, estTok: estTok, durCell: durCell, failCell: failCell });
  }
  var show = { out: false, real: false, est: false, dur: false, fail: false };
  for (var q = 0; q < rowsData.length; q++) {
    var x = rowsData[q];
    if (x.chOut !== "-") show.out = true;
    if (x.realCell !== "-") show.real = true;
    if (x.estTok) show.est = true;
    if (x.durCell !== "-") show.dur = true;
    if (x.failCell !== "0") show.fail = true;
  }
  var cols = 2 + (show.out ? 1 : 0) + (show.real ? 1 : 0) + (show.est ? 1 : 0) + (show.dur ? 1 : 0) + (show.fail ? 1 : 0);
  h += "<table><thead><tr>" + '<th style="width:30%">环节</th><th style="width:9%">次数</th><th style="width:16%">输入/注入字符</th>';
  if (show.out) h += '<th style="width:12%">输出字符</th>';
  if (show.real) h += '<th style="width:16%">真实 tokens 入/出</th>';
  if (show.est) h += '<th style="width:12%">估算 tokens</th>';
  if (show.dur) h += '<th style="width:10%">均时长</th>';
  if (show.fail) h += '<th style="width:8%">失败</th>';
  h += "</tr></thead><tbody>";
  for (var j = 0; j < rowsData.length; j++) {
    var r = rowsData[j];
    h += "<tr" + costTip(costRecTip(r.kind, r.rec, r.n)) + ">";
    h += '<td class="ell">' + costEsc(COST_KIND_LABEL[r.kind] || r.kind) + "</td>";
    h += '<td class="mono">' + costNum(r.n) + "</td>";
    h += '<td class="mono">' + r.chIn + "</td>";
    if (show.out) h += '<td class="mono">' + r.chOut + "</td>";
    if (show.real) h += '<td class="mono">' + r.realCell + "</td>";
    if (show.est) h += '<td class="mono">' + (r.estTok ? costShort(r.estTok) : "-") + "</td>";
    if (show.dur) h += '<td class="mono">' + r.durCell + "</td>";
    if (show.fail) h += '<td class="mono">' + r.failCell + "</td>";
    h += "</tr>";
  }
  if (!rowsData.length) h += '<tr><td colspan="' + cols + '" class="muted">暂无消耗数据</td></tr>';
  h += "</tbody></table>";
  h += '<div class="cost-note">次数 = 记账次数（host* 行为宿主轮次）；「真实 tokens 入/出」仅 checkpointWrite / dream / maint / archive 等有真实值；空列已自动隐藏（writer 结算后才会出现输出字符/均时长）。</div>';
  h += "</div>";
  return h;
}
`;
t = t.slice(0, ki) + NEW_KINDS + t.slice(kj);
console.log("OK costKindsHtml replaced");

// ── ③ 替换 costTopHtml（动态列）──
const TOP_START = "function costTopHtml(cost) {";
const TOP_END = "/** 主渲染入口";
const ti = t.indexOf(TOP_START), tj = t.indexOf(TOP_END);
if (ti < 0 || tj < 0 || ti > tj) throw new Error("top func boundary not found");
const NEW_TOP = `function costTopHtml(cost) {
  var list = Array.isArray(cost.topSessions) ? cost.topSessions : [];
  var rows = [];
  for (var i = 0; i < list.length && rows.length < 10; i++) if (costIsObj(list[i])) rows.push(list[i]);
  var h = '<div class="card glass span2 cost-card" id="cost-top">';
  h += '<h2>Top 会话<span class="h2n">按检查点写入估算 tokens 排序 · 最多 10 行</span></h2>';
  if (!rows.length) {
    h += '<div class="cost-empty">暂无会话级记账（无 checkpointWrite 事件或事件未带会话 id）</div></div>';
    return h;
  }
  // 动态列：全空的列不渲染（输出字符/估算/均时长要等 writer 结算记账后才有）
  var show = { out: false, est: false, dur: false, fail: false };
  for (var q = 0; q < rows.length; q++) {
    var rr = rows[q];
    if (costN(rr.outChars)) show.out = true;
    if (costN(rr.estTokens)) show.est = true;
    if (costN(rr.durMs)) show.dur = true;
    if (costN(rr.fail)) show.fail = true;
  }
  var cols = 3 + (show.out ? 1 : 0) + (show.est ? 1 : 0) + (show.dur ? 1 : 0) + (show.fail ? 1 : 0);
  h += '<table><thead><tr><th style="width:' + (show.out || show.est || show.dur || show.fail ? "50%" : "62%") + '">会话</th><th style="width:9%">写入</th><th style="width:14%">输入字符</th>';
  if (show.out) h += '<th style="width:12%">输出字符</th>';
  if (show.est) h += '<th style="width:13%">估算 tokens</th>';
  if (show.dur) h += '<th style="width:10%">均时长</th>';
  if (show.fail) h += '<th style="width:9%">失败</th>';
  h += "</tr></thead><tbody>";
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    var sid = (typeof r.sid === "string" && r.sid) ? r.sid : "（未知会话）";
    var n = costN(r.n), fail = costN(r.fail);
    h += "<tr>";
    h += '<td class="mono ell"' + costTip("会话：" + sid + "\\n写入次数 " + costNum(n)) + ">" + costEsc(sid) + "</td>";
    h += '<td class="mono">' + costNum(n) + "</td>";
    h += '<td class="mono">' + (costN(r.inChars) ? costShort(costN(r.inChars)) : "-") + "</td>";
    if (show.out) h += '<td class="mono">' + (costN(r.outChars) ? costShort(costN(r.outChars)) : "-") + "</td>";
    if (show.est) h += '<td class="mono">' + (costN(r.estTokens) ? costShort(costN(r.estTokens)) : "-") + "</td>";
    if (show.dur) h += '<td class="mono">' + costDur(r.durMs, n) + "</td>";
    if (show.fail) h += '<td class="mono">' + (fail ? '<span class="warn">' + costNum(fail) + "</span>" : "0") + "</td>";
    h += "</tr>";
  }
  h += "</tbody></table>";
  h += '<div class="cost-note">Top 会话由服务端（p3-cost.js buildTopSessions）按检查点写入估算 tokens 降序给出；同分时按输入字符、次数。会话 id 悬停可看全名；空列已自动隐藏。</div>';
  h += "</div>";
  return h;
}
`;
t = t.slice(0, ti) + NEW_TOP + t.slice(tj);
console.log("OK costTopHtml replaced");

fs.writeFileSync(P, t, "utf8");
console.log("panel written:", t.length);
