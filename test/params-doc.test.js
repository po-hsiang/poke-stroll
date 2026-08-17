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
//    ids 與 team——兩個都收「逗號清單」，而白名單的型別只驗單一個值，
//    所以它們在 applyQueryOverrides 裡各自手工解析。
// 白名單住在 js/params.js（0.38.0 起主程式拆進 js/，一檔一職責）
const widget = read('js/params.js');
const qpBlock = widget.match(/const QUERY_PARAMS = \{([\s\S]*?)\n\s*\};/);
check(!!qpBlock, '能在 widget 中找到 QUERY_PARAMS 區塊');
const widgetKeys = new Set(
    [...(qpBlock ? qpBlock[1] : '').matchAll(/(\w+):\s*\{\s*path/g)].map(m => m[1])
);
widgetKeys.add('ids');
widgetKeys.add('team');
check(widgetKeys.size > 20, `widget 白名單解析出 ${widgetKeys.size} 個參數（含 ids、team）`);

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

// 4) 屬性名單三方同步。widget 的 POKE_TYPE_NAMES 是 team 參數的允許值，
// 兩份文件各抄了一份給人看——抄漏一種屬性，讀者就以為那一種不能打
const roster = read('js/roster.js');
const namesBlock = roster.match(/const POKE_TYPE_NAMES = \[([\s\S]*?)\n\];/);
check(!!namesBlock, '能在 widget 中找到 POKE_TYPE_NAMES 區塊');
const typeNames = [...(namesBlock ? namesBlock[1] : '').matchAll(/'(\w+)'/g)].map(m => m[1]);
check(typeNames.length === 18, `widget 解析出 ${typeNames.length} 種屬性（應為 18）`);
// 文件裡的完整清單長這樣：normal / fire / … / fairy（順序也一致才不會漏抄）
const typeList = typeNames.join(' / ');
check(md.includes(typeList), 'PARAMS.md 的 team 允許值收齊十八種屬性');
check(page.includes(typeList), 'params.html 的 team 允許值收齊十八種屬性');

console.log('==============================================');
if (failed) {
    console.log(`文件同步檢查失敗 ${failed} 項`);
    process.exit(1);
}
console.log(`文件同步檢查通過（三方各 ${widgetKeys.size} 個參數、${typeNames.length} 種屬性一致）`);
