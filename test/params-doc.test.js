// 文件同步檢查：URL 參數的「真理來源」是 widget 內的 QUERY_PARAMS 白名單，
// PARAMS.md（給 repo 讀者）與 params.html（部署給嵌入方的互動文件）都是它的投影。
// 三方參數名稱不一致就紅燈——新增參數忘了補文件、或文件寫了不存在的參數，都逃不掉。
// 用法：node test/params-doc.test.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failed = 0;
function check(cond, msg) {
    if (cond) {
        console.log(`  ok   ${msg}`);
    } else {
        console.log(`  FAIL ${msg}`);
        failed++;
    }
}

// 1) widget 的 QUERY_PARAMS 白名單，外加兩個白名單外手動處理的特例：
//    ids（逗號清單）與 preset（預設檔，展開成一整段 query string）。
// 白名單住在 js/params.js（0.38.0 起主程式拆進 js/，一檔一職責）
const widget = read('js/params.js');
const qpBlock = widget.match(/const QUERY_PARAMS = \{([\s\S]*?)\n\s*\};/);
check(!!qpBlock, '能在 widget 中找到 QUERY_PARAMS 區塊');
const widgetKeys = new Set(
    [...(qpBlock ? qpBlock[1] : '').matchAll(/(\w+):\s*\{\s*path/g)].map(m => m[1])
);
widgetKeys.add('ids');
widgetKeys.add('preset');
check(widgetKeys.size > 20, `widget 白名單解析出 ${widgetKeys.size} 個參數（含 ids）`);

// 2) PARAMS.md「參數總表」章節的每一列。
// 只認這一章：文件後面還有別的表格（postMessage 的指令表、回執欄位表），
// 那些的第一欄也是 `反引號`，不鎖章節就會被誤認成 URL 參數
const md = read('PARAMS.md');
const mdSection = md.match(/## 參數總表([\s\S]*?)(?=\n## )/);
check(!!mdSection, '能在 PARAMS.md 中找到「參數總表」章節');
const mdKeys = new Set(
    [...(mdSection ? mdSection[1] : '').matchAll(/^\| `(\w+)`/gm)].map(m => m[1])
);

// 3) params.html 資料陣列的 name 欄位
const page = read('params.html');
const pageBlock = page.match(/const PARAMS = \[([\s\S]*?)\n\s*\];/);
check(!!pageBlock, '能在 params.html 中找到 PARAMS 資料陣列');
const pageKeys = new Set(
    [...(pageBlock ? pageBlock[1] : '').matchAll(/name:\s*'(\w+)'/g)].map(m => m[1])
);

// 三方互相比對，缺漏與多餘都列出來
function diff(label, a, b) {
    const missing = [...a].filter(k => !b.set.has(k));
    check(missing.length === 0,
        `${b.label} 沒有漏掉 ${label} 的參數${missing.length ? `（缺：${missing.join(', ')}）` : ''}`);
}
const sources = [
    { label: 'widget 白名單', set: widgetKeys },
    { label: 'PARAMS.md',    set: mdKeys },
    { label: 'params.html',  set: pageKeys },
];
for (const a of sources) {
    for (const b of sources) {
        if (a !== b) diff(a.label, a.set, b);
    }
}

// 4) 預設檔同樣三方同步。js/params.js 的 PRESETS 是真理，PARAMS.md 與 params.html
// 各抄了一份「展開後長什麼樣」給人看——抄錯就是文件在騙人，而且騙得很難發現
const presetBlock = widget.match(/const PRESETS = \{([\s\S]*?)\n\};/);
check(!!presetBlock, '能在 widget 中找到 PRESETS 區塊');
const presets = [...(presetBlock ? presetBlock[1] : '').matchAll(/^\s{4}(\w+):\s*'([^']*)'/gm)];
check(presets.length > 0, `widget 解析出 ${presets.length} 個預設檔`);
for (const [, name, query] of presets) {
    check(md.includes(`\`${name}\``) && md.includes(query),
        `PARAMS.md 收錄預設檔 ${name}，展開內容一字不差`);
    check(page.includes(`name: '${name}'`) && page.includes(query),
        `params.html 收錄預設檔 ${name}，展開內容一字不差`);
}

console.log('==============================================');
if (failed) {
    console.log(`文件同步檢查失敗 ${failed} 項`);
    process.exit(1);
}
console.log(`文件同步檢查通過（三方各 ${widgetKeys.size} 個參數、${presets.length} 個預設檔一致）`);
