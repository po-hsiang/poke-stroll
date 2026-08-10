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

// 1) widget 的 QUERY_PARAMS 白名單（＋ids：白名單外手動處理的特例）
const widget = read('pokemon_footer_widget.html');
const qpBlock = widget.match(/const QUERY_PARAMS = \{([\s\S]*?)\n\s*\};/);
check(!!qpBlock, '能在 widget 中找到 QUERY_PARAMS 區塊');
const widgetKeys = new Set(
    [...(qpBlock ? qpBlock[1] : '').matchAll(/(\w+):\s*\{\s*path/g)].map(m => m[1])
);
widgetKeys.add('ids');
check(widgetKeys.size > 20, `widget 白名單解析出 ${widgetKeys.size} 個參數（含 ids）`);

// 2) PARAMS.md 參數總表的每一列
const mdKeys = new Set(
    [...read('PARAMS.md').matchAll(/^\| `(\w+)`/gm)].map(m => m[1])
);

// 3) params.html 資料陣列的 name 欄位
const pageBlock = read('params.html').match(/const PARAMS = \[([\s\S]*?)\n\s*\];/);
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

console.log('==============================================');
if (failed) {
    console.log(`文件同步檢查失敗 ${failed} 項`);
    process.exit(1);
}
console.log(`文件同步檢查通過（三方各 ${widgetKeys.size} 個參數一致）`);
