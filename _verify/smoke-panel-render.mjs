// 面板渲染冒烟：用真实 stats.json 的 cost 段跑 costPanelHtml，验证 ①不展示历史桶 ②空列自动隐藏
import fs from "node:fs";

const P = "C:/Users/Starry/.dsh/memory/.stats-panel.html";
const html = fs.readFileSync(P, "utf8");
const m = html.match(/\/\* #cost-pure-begin \*\/([\s\S]*?)\/\* #cost-pure-end \*\//);
if (!m) { console.error("pure block not found"); process.exit(1); }
const code = m[1];
const factory = new Function(code + "\nreturn { costPanelHtml: costPanelHtml, COST_KIND_ORDER: COST_KIND_ORDER };");
const api = factory();

// 取真实 cost 段
let cost = null;
try {
  const res = await fetch("http://127.0.0.1:49396/dsh-memory/stats.json");
  const j = await res.json();
  cost = j.cost;
  console.log("stats.json 取到 cost 段:", !!cost);
} catch (e) {
  console.log("HTTP 失败，回落 .monitor.json:", e.message);
  const mon = JSON.parse(fs.readFileSync("C:/Users/Starry/.dsh/memory/.monitor.json", "utf8"));
  cost = mon.cost;
}

const out = api.costPanelHtml(cost);
console.log("渲染输出长度:", out.length);
console.log("含「历史混合桶」:", out.includes("历史混合桶"));
console.log('含「宿主 usage」行:', out.includes("宿主 usage"));
console.log("含「输出字符」表头:", out.includes("输出字符"));
console.log('含「均时长」表头:', out.includes("均时长"));
console.log('含「真实 tokens 入/出」表头:', out.includes("真实 tokens 入/出"));
console.log('含「估算 tokens」表头:', out.includes("估算 tokens"));
console.log("降级卡:", out.includes("暂无消耗数据"));
// 抽出表格表头列表
const ths = [...out.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((x) => x[1].replace(/<[^>]+>/g, ""));
console.log("所有表头:", JSON.stringify(ths));
