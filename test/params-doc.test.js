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

// 3.5) 兩份文件的「預設」欄 vs config.js 的實際值。
// 名稱同步只擋「參數存在不存在」，擋不到「文件寫 4、程式其實是 6」——
// 那種漂移對讀者最傷（照文件推算的行為跟實際不一樣），而且改預設值時
// 最容易忘記回頭改文件。這裡一次比對全部參數，逐一列出對不上的。
//
// 文件是寫給人看的，所以允許三種表達方式：
//   —  / auto  = 這個參數在 config.js 裡沒有值（ids、team、sunTime）
//   1/100      = 分數照算（0.01）
//   0.33       = 四捨五入到文件寫的位數即可（config 是 1/3）
const vmBox = { window: {} };
require('vm').runInNewContext(read('config.js'), vmBox);
const cfg = vmBox.window.POKE_CONFIG;

// 白名單的 path 是取值路徑：boundsMin → ['bounds', 'min']
const paths = new Map(
    [...(qpBlock ? qpBlock[1] : '').matchAll(/(\w+):\s*\{\s*path:\s*\[([^\]]*)\]/g)]
        .map(m => [m[1], m[2].split(',').map(s => s.trim().replace(/'/g, ''))])
);
const actualOf = name => paths.get(name)?.reduce((o, k) => o?.[k], cfg);

// 文件寫的那一格 → 跟實際值比。回傳 null = 相符
function defMismatch(name, written) {
    const raw = written.replace(/`/g, '').trim();
    const actual = actualOf(name);
    if (raw === '—' || raw === 'auto') {
        return actual === null || actual === undefined ? null : `文件說沒有預設，實際是 ${actual}`;
    }
    if (actual === undefined) return `文件寫 ${raw}，但 config.js 沒有這個值`;
    if (typeof actual === 'string') {
        return raw === actual ? null : `文件寫 ${raw}，實際是 ${actual}`;
    }
    if (typeof actual === 'number') {
        const frac = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
        const want = frac ? Number(frac[1]) / Number(frac[2]) : Number(raw);
        if (Number.isNaN(want)) return `文件寫的 ${raw} 讀不出數字`;
        // 文件四捨五入到幾位，就用那幾位比（1/3 寫成 0.33 是合理的）
        const digits = frac ? 12 : (raw.split('.')[1] || '').length;
        const round = v => Number(v.toFixed(Math.min(digits, 12)));
        return round(want) === round(actual) ? null : `文件寫 ${raw}，實際是 ${actual}`;
    }
    return `config.js 的 ${name} 是 ${typeof actual}，比不了`;
}

// PARAMS.md：| `名稱` | 型別 | 允許範圍 | 預設 | 說明 |
const mdDefaults = [...(mdSection ? mdSection[1] : '').matchAll(/^\| `(\w+)` \|[^|]*\|[^|]*\| ([^|]*)\|/gm)]
    .map(m => [m[1], m[2]]);
check(mdDefaults.length === mdKeys.size,
    `PARAMS.md 的 ${mdDefaults.length} 列都讀得到「預設」欄（共 ${mdKeys.size} 個參數）`);
const mdBad = mdDefaults
    .map(([name, written]) => [name, defMismatch(name, written)])
    .filter(([, err]) => err);
check(mdBad.length === 0,
    `PARAMS.md 的預設值與 config.js 一致${mdBad.length ? `（${mdBad.map(([n, e]) => `${n}: ${e}`).join('; ')}）` : ''}`);

// params.html：{ name: 'count', …, def: '4', … }
const pageDefaults = [...(pageBlock ? pageBlock[1] : '')
    .matchAll(/name:\s*'(\w+)'[\s\S]*?def:\s*'([^']*)'/g)].map(m => [m[1], m[2]]);
check(pageDefaults.length === pageKeys.size,
    `params.html 的 ${pageDefaults.length} 筆都讀得到 def 欄（共 ${pageKeys.size} 個參數）`);
const pageBad = pageDefaults
    .map(([name, written]) => [name, defMismatch(name, written)])
    .filter(([, err]) => err);
check(pageBad.length === 0,
    `params.html 的預設值與 config.js 一致${pageBad.length ? `（${pageBad.map(([n, e]) => `${n}: ${e}`).join('; ')}）` : ''}`);

// 3.6) 兩份文件的「允許範圍」欄 vs 白名單的 min/max/values。
// 同樣是名稱同步擋不到的一種漂移：文件說 0 ~ 1、程式其實收到 5 也放行，
// 讀者就照文件寫死了上限。這裡逐一比對全部參數的邊界與 enum 允許值。
// （ids / team 不在白名單裡——兩個都收逗號清單，由 applyQueryOverrides
//   手工解析，範圍欄是寫給人看的文字，跳過不比）
const specs = new Map(
    [...(qpBlock ? qpBlock[1] : '').matchAll(/(\w+):\s*\{([^}]*)\}/g)].map(([, name, body]) => {
        const num = k => {
            const m = body.match(new RegExp(`${k}:\\s*(-?[\\d.]+)`));
            return m ? Number(m[1]) : undefined;
        };
        const vals = body.match(/values:\s*\[([^\]]*)\]/);
        return [name, {
            type: body.match(/type:\s*'(\w+)'/)?.[1],
            min: num('min'),
            max: num('max'),
            values: vals ? vals[1].split(',').map(s => s.trim().replace(/'/g, '')) : null,
        }];
    })
);

function rangeMismatch(name, written) {
    const spec = specs.get(name);
    if (!spec) return null; // ids / team：手工解析的特例
    const raw = written.replace(/`/g, '').trim();
    if (spec.type === 'enum') {
        const listed = raw.split('/').map(s => s.trim()).filter(Boolean);
        return JSON.stringify(listed) === JSON.stringify(spec.values)
            ? null : `文件列 ${listed.join('/')}，白名單是 ${spec.values.join('/')}`;
    }
    const m = raw.match(/^(-?[\d.]+)\s*~\s*(-?[\d.]+)/);
    if (!m) return `讀不出「a ~ b」的範圍：${raw}`;
    return Number(m[1]) === spec.min && Number(m[2]) === spec.max
        ? null : `文件寫 ${m[1]} ~ ${m[2]}，白名單是 ${spec.min} ~ ${spec.max}`;
}

// PARAMS.md 的第 3 欄、params.html 的 range 欄
const mdRanges = [...(mdSection ? mdSection[1] : '').matchAll(/^\| `(\w+)` \|[^|]*\| ([^|]*)\|/gm)]
    .map(m => [m[1], m[2]]);
const pageRanges = [...(pageBlock ? pageBlock[1] : '')
    .matchAll(/name:\s*'(\w+)'[\s\S]*?range:\s*'([^']*)'/g)].map(m => [m[1], m[2]]);
for (const [label, rows] of [['PARAMS.md', mdRanges], ['params.html', pageRanges]]) {
    const bad = rows.map(([name, written]) => [name, rangeMismatch(name, written)])
        .filter(([, err]) => err);
    check(bad.length === 0,
        `${label} 的允許範圍與白名單一致${bad.length ? `（${bad.map(([n, e]) => `${n}: ${e}`).join('; ')}）` : ''}`);
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
