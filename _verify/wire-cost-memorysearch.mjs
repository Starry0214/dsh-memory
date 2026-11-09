// P3-3c 记账补全 ③：memory_search 记账（高频点，只在 miss 时推 ev）
import fs from "node:fs";

const P = "E:/工具/插件开发调整/dsh-memory-plugin/index.js";
let t = fs.readFileSync(P, "utf8");
fs.writeFileSync(P + ".bak-cost4-" + Date.now().toString(36), t);
const before = t.length;

const ANCHOR = "        compatTool(toolSvc, memorySearchToolDef);";
const NEW = `        // [P3-3 记账][2026-11-02] memory_search 调用记账（结果字符 / 耗时 / 未命中）
        //   高频点：只在 miss 时推 ev —— 否则 500 条事件环会被检索记录挤满（压缩/检查点事件才是高价值明细）。
        try {
          const _msRaw = memorySearchToolDef.execute.bind(memorySearchToolDef);
          memorySearchToolDef.execute = async (a, e) => {
            const _msT0 = Date.now();
            let resultChars = 0, miss = 0, failed = 0;
            try {
              const r = await _msRaw(a, e);
              const s = String(r == null ? "" : r);
              resultChars = s.length;
              miss = /未命中|没有找到|0 命中|无匹配|no match/i.test(s) ? 1 : 0;
              return r;
            } catch (errMs) {
              failed = 1;
              throw errMs;
            } finally {
              try {
                p3CostBump("memorySearch",
                  { n: 1, resultChars: resultChars, durMs: Date.now() - _msT0, miss: miss },
                  miss ? { sid: "", trigger: "search", note: "miss" + (failed ? "+fail" : "") } : null);
              } catch (eP3ms) { /* 记账失败不影响检索 */ }
            }
          };
        } catch (eP3msWrap) { /* 包装失败不影响检索 */ }
        compatTool(toolSvc, memorySearchToolDef);`;

const i = t.indexOf(ANCHOR);
if (i < 0) throw new Error("memory_search anchor not found");
if (t.indexOf(ANCHOR, i + 1) >= 0) throw new Error("memory_search anchor not unique");
t = t.slice(0, i) + NEW + t.slice(i + ANCHOR.length);

fs.writeFileSync(P, t, "utf8");
console.log("written:", before, "->", t.length);
