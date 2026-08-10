// =========================================================
// PokéStroll 單元測試
//
//   執行：node test/widget.test.js   （不需要 npm install，零依賴）
//
// widget 是純靜態單檔 HTML，邏輯全在 inline <script> 裡。這支測試把那段
// script 抽出來丟進 Node 的 vm，配一套最小 DOM stub 跑「真正的」Pokemon
// 類別 —— 不是複製一份邏輯來測，改壞了這裡就會紅燈。
//
// 兩個關鍵手法：
//   1. 假時鐘取代 setTimeout，才能斷言對話框自動收起的時序。
//   2. canvas stub 記錄每一次 fillRect，toDataURL 把像素格存進 Map，
//      所以像素圖（對話框外框、尾巴鏡像、心情圖示）是直接比對畫出來的
//      像素，不是靠眼睛看。
//
// 沒有涵蓋的部分（需要真的瀏覽器）：CSS 實際套用結果、GIF 載入、
// requestAnimationFrame 的真實時序、視覺上好不好看。
// =========================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pokemon_footer_widget.html'), 'utf8');

// ---- 取出最後一段 inline script（主程式）----
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1) throw new Error(`預期 1 段 inline script，實際 ${scripts.length}`);
const source = scripts[0];

// ---- 假時鐘 ----
let now = 0;
const timers = new Map();
let timerId = 1;
function setTimeoutStub(fn, ms) {
    const id = timerId++;
    timers.set(id, { fn, at: now + ms });
    return id;
}
function clearTimeoutStub(id) { timers.delete(id); }
function advance(ms) {
    const target = now + ms;
    let guard = 0;
    for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length || guard++ > 1000) break;
        const [id, t] = due[0];
        timers.delete(id);
        now = t.at;
        t.fn();
    }
    now = target;
}

// ---- 最小 DOM stub ----
const pixelGrids = new Map(); // dataURL -> 二維字串陣列（畫出來的像素）
let uriSeq = 0;

function makeCanvas() {
    const cells = [];
    let fillStyle = null;
    return {
        _isCanvas: true,
        width: 0, height: 0,
        style: {},
        getContext() {
            const ctx = {
                set fillStyle(v) { fillStyle = v; },
                get fillStyle() { return fillStyle; },
                // 依真正的 canvas 語意展開 w×h（心情圖示都是 1×1，
                // 地面貼片會用整列填色，兩種都要記到格子裡）
                fillRect(x, y, w = 1, h = 1) {
                    for (let dy = 0; dy < h; dy++) {
                        for (let dx = 0; dx < w; dx++) {
                            cells.push({ x: x + dx, y: y + dy, color: fillStyle });
                        }
                    }
                },
            };
            return ctx;
        },
        toDataURL() {
            const grid = Array.from({ length: this.height }, () => Array(this.width).fill('.'));
            for (const c of cells) if (grid[c.y]) grid[c.y][c.x] = c.color;
            const uri = `data:image/png;fake,${uriSeq++}`;
            pixelGrids.set(uri, grid.map(r => r.join('|')));
            return uri;
        },
    };
}

function makeStyle() {
    const props = {};
    return {
        _props: props,
        setProperty(k, v) { props[k] = v; },
        getPropertyValue(k) { return props[k]; },
    };
}

function makeElement(tag) {
    const el = {
        tagName: tag,
        style: makeStyle(),
        className: '',
        children: [],
        listeners: {},
        offsetWidth: 0,
        offsetHeight: 0,
        src: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        dispatch(type) { (this.listeners[type] || []).forEach(fn => fn()); },
    };
    if (tag === 'img') {
        // sprite 載入後才有尺寸：測試裡手動 dispatch('load') 前先塞好寬高
        el.offsetWidth = 120;
        el.offsetHeight = 128;
    }
    return el;
}

const appEl = makeElement('div');
const sandbox = {
    console,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    requestAnimationFrame: () => 0, // 不跑動畫迴圈
    fetch: () => Promise.reject(new Error('測試不打網路')),
    URLSearchParams,
    Math,
    JSON,
    Number,
    Object,
    Array,
    document: {
        createElement: tag => (tag === 'canvas' ? makeCanvas() : makeElement(tag)),
        getElementById: () => appEl,
    },
    location: { search: '' },
    window: {
        innerWidth: 1920,
        innerHeight: 200, // footer iframe 的典型高度（客串事件的飛行高度依它計算）
        POKE_CONFIG: null, // 下面注入
        POKE_HEIGHTS: { 25: 4, 143: 21 }, // 皮卡丘 0.4m（小）、卡比獸 2.1m（大）
        POKE_TYPES: { 25: 'electric', 143: 'normal' },
    },
};
sandbox.globalThis = sandbox;

// 載入真正的 config.js（同時驗證它語法正確、預設值正確）
const configSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
vm.runInNewContext(configSrc, sandbox);
const CONFIG = sandbox.window.POKE_CONFIG;

// 跑主程式，並把要測的東西掛到 globalThis
vm.runInNewContext(
    source + '\n;globalThis.__T = { Pokemon, buildBubbleFrame, getEmoteURI, EMOTE_ICONS, EMOTE_PALETTE, CONFIG, fallbackSizeScale, QUERY_PARAMS, initGround, buildGroundTexture, GROUND_THEMES, Cameo };',
    sandbox,
);
const T = sandbox.__T;

// ---- 測試框架 ----
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`); }
}
function group(name) { console.log(`\n${name}`); }

function newPokemon(id, { shiny = false, direction = 1, scale = 1 } = {}) {
    const savedChance = CONFIG.shinyChance;
    CONFIG.shinyChance = shiny ? 1 : 0;
    const p = new T.Pokemon(id, appEl, scale, 0);
    CONFIG.shinyChance = savedChance;
    p.direction = direction;
    p.placeBubble && p.bubbleName && p.placeBubble();
    return p;
}

// =========================================================
group('1. config.js 預設值');
check('count = 4', CONFIG.count === 4, `實際 ${CONFIG.count}`);
check('hopHeight = 3', CONFIG.hopHeight === 3, `實際 ${CONFIG.hopHeight}`);
check('shinyChance = 1/100', Math.abs(CONFIG.shinyChance - 0.01) < 1e-12, `實際 ${CONFIG.shinyChance}`);
check("bubblePosition = 'side'", CONFIG.bubblePosition === 'side');
check('baseSize = 128', CONFIG.baseSize === 128);
check('sizeTiers scale = 0.6 / 0.8 / 1',
    JSON.stringify(CONFIG.sizeTiers.map(t => t.scale)) === '[0.6,0.8,1]',
    JSON.stringify(CONFIG.sizeTiers.map(t => t.scale)));
check('sizeTiers 門檻 0.8 / 1.5 / Infinity',
    CONFIG.sizeTiers[0].maxMeters === 0.8 && CONFIG.sizeTiers[1].maxMeters === 1.5
    && CONFIG.sizeTiers[2].maxMeters === Infinity);

// =========================================================
group('2. 對話框外框：尾巴鏡像');
const frameR = T.buildBubbleFrame(20, 12, 1);
const frameL = T.buildBubbleFrame(20, 12, -1);
check('兩種朝向的尺寸一致',
    frameR.length === frameL.length && frameR[0].length === frameL[0].length);
check('朝左 = 朝右的逐列左右翻轉',
    frameL.every((row, i) => row === [...frameR[i]].reverse().join('')));
check('方框本體（非尾巴列）左右對稱、不受朝向影響',
    frameR.slice(0, frameR.length - 4).every((row, i) => row === frameL[i]),
    '前 N-4 列（方框）應完全相同');
// 尾巴的「勾」方向 = 尖端相對於根部開口中心的水平偏移
const tipX = rows => [...rows[rows.length - 1]].findIndex(ch => ch === '#');
const mouthCenter = rows => {
    const row = [...rows[rows.length - 4]]; // 尾巴根部：方框底邊上開口的那一列
    const ws = row.map((ch, i) => (ch === 'w' ? i : -1)).filter(i => i >= 0);
    return (ws[0] + ws[ws.length - 1]) / 2;
};
const mid = (frameR[0].length - 1) / 2;
check('朝右：尖端勾向根部右方', tipX(frameR) > mouthCenter(frameR),
    `tip=${tipX(frameR)}, mouth=${mouthCenter(frameR)}`);
check('朝左：尖端勾向根部左方', tipX(frameL) < mouthCenter(frameL),
    `tip=${tipX(frameL)}, mouth=${mouthCenter(frameL)}`);
check('勾的幅度相同，只是反向',
    tipX(frameR) - mouthCenter(frameR) === -(tipX(frameL) - mouthCenter(frameL)));
// 尾巴要在「它勾過去那一側」的下角，不是掛在正中央
check('朝右的尾巴在右下角、朝左的在左下角（勾向與所在角落一致）',
    mouthCenter(frameR) > mid && mouthCenter(frameL) < mid,
    `mouthR=${mouthCenter(frameR)}, mouthL=${mouthCenter(frameL)}, mid=${mid}`);
check('兩者與中線等距', Math.abs(mouthCenter(frameR) - mid) === Math.abs(mouthCenter(frameL) - mid));
check('尾巴比舊版（掛中央）更靠角落', mouthCenter(frameR) - mid > 2,
    `右移了 ${mouthCenter(frameR) - mid}px`);

// 所有實際會用到的框寬都要合法：列寬一致、尖端不掉出框外，
// 且距「勾過去那一側」邊緣的距離一致（窄框如驚嘆號會被夾住，但仍要在框內）
for (const [name, icon] of Object.entries(T.EMOTE_ICONS)) {
    const w = icon.frameWidth ?? 20;
    const innerRows = Math.max(12, icon.art.length + 4);
    for (const dir of [1, -1]) {
        const rows = T.buildBubbleFrame(w, innerRows, dir);
        const widths = new Set(rows.map(r => r.length));
        const tip = tipX(rows);
        const fromEdge = dir === 1 ? w - 1 - tip : tip;
        check(`${name}(w=${w}, dir=${dir})：列寬一致且尖端距該側邊緣 4px`,
            widths.size === 1 && [...widths][0] === w && fromEdge === 4,
            `列寬=${[...widths].join(',')}, 尖端x=${tip}, 距邊緣=${fromEdge}`);
    }
}

// =========================================================
group('3. 心情圖示不跟著鏡像（音符/問號不能變錯字）');
for (const name of ['note', 'question', 'zzz', 'poop']) {
    const icon = T.EMOTE_ICONS[name];
    const gridR = pixelGrids.get(T.getEmoteURI(name, 1));
    const gridL = pixelGrids.get(T.getEmoteURI(name, -1));
    // 比對圖示所佔的矩形區域：兩種朝向應完全相同（未被鏡像）
    const cut = grid => grid.slice(icon.top, icon.top + icon.art.length)
        .map(r => r.split('|').slice(icon.left, icon.left + icon.art[0].length).join('|'));
    check(`${name}：圖示區域兩朝向一致`, JSON.stringify(cut(gridR)) === JSON.stringify(cut(gridL)));
    // 並且確實有畫出圖示的顏色（不是全白）
    const inkChars = new Set([...icon.art.join('')].filter(c => c !== '.'));
    const inkColors = [...inkChars].map(c => T.EMOTE_PALETTE[c]);
    const flat = cut(gridR).join('|');
    check(`${name}：圖示確實畫上去了`, inkColors.some(col => flat.includes(col)));
}
check('快取：同 name 同朝向回傳同一個 URI', T.getEmoteURI('note', 1) === T.getEmoteURI('note', 1));
check('快取：同 name 不同朝向是不同圖', T.getEmoteURI('note', 1) !== T.getEmoteURI('note', -1));

// =========================================================
group("4. side 擺位：貼在本體側邊 + 尾巴朝內");
CONFIG.bubblePosition = 'side';
{
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    const { gap } = p.bubbleMetrics(); // 實際空隙由 bubbleSideGap 決定（可為負）
    check('面向右 → 框錨在右緣', p.bubble.style.left === '100%');
    check('面向右 → 位移為 +gap',
        p.bubble.style.transform === `translateX(${gap}px)`, p.bubble.style.transform);
    check('面向右 → 尾巴朝左（指回本體）',
        p.bubble.src === T.getEmoteURI('heart', -1));

    p.direction = -1;
    p.updateDOM();
    check('轉向左 → 自動換到左緣', p.bubble.style.left === '0');
    // 往左擺要再退自己一個身（-100%）再加空隙；正負號的組法在第 14 組另有專門測試
    const back = gap >= 0 ? `- ${gap}px` : `+ ${-gap}px`;
    check('轉向左 → 位移為 -(100% + gap)',
        p.bubble.style.transform === `translateX(calc(-100% ${back}))`, p.bubble.style.transform);
    check('轉向左 → 尾巴改朝右', p.bubble.src === T.getEmoteURI('heart', 1));
    check('垂直錨在身高六成處（+ bubbleSideLift 微調）',
        p.bubble.style.bottom === `calc(60% + ${CONFIG.bubbleSideLift}px)`, p.bubble.style.bottom);

    // 沒轉向時不應重設 DOM（避免每幀寫樣式）
    const before = p.bubble.src;
    p.bubble.src = '__SENTINEL__';
    p.updateDOM();
    check('方向未變 → 不重設擺位', p.bubble.style.display === 'block' && p.bubble.src === '__SENTINEL__');
    p.bubble.src = before;

    // 對話框收起後就算轉向也不該重擺
    p.hideEmote();
    p.bubble.src = '__SENTINEL2__';
    p.direction = 1;
    p.updateDOM();
    check('已收起 → 轉向不重擺', p.bubble.src === '__SENTINEL2__');
}

group("5. top 擺位維持原樣（尾巴用預設朝向）");
CONFIG.bubblePosition = 'top';
{
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('note');
    check('置中於頭頂', p.bubble.style.left === '50%' && p.bubble.style.bottom === 'calc(100% + 2px)');
    check('水平置中位移', p.bubble.style.transform === 'translateX(-50%)');
    check('尾巴用預設朝向', p.bubble.src === T.getEmoteURI('note', 1));
    p.direction = -1;
    p.updateDOM();
    check('top 模式轉向後仍置中', p.bubble.style.left === '50%' && p.bubble.style.transform === 'translateX(-50%)');
}

// =========================================================
group('6. 色違登場閃光的保護期');
CONFIG.bubblePosition = 'side';
{
    const p = newPokemon(143, { shiny: true });
    check('色違判定成立', p.isShiny === true);
    check('登場即亮出金色閃光（面向右 → 尾巴朝左）',
        p.bubble.style.display === 'block' && p.bubble.src === T.getEmoteURI('sparkle', -1));
    check('保護期已上鎖', p.bubbleLocked === true);
    check('bubbleName = sparkle', p.bubbleName === 'sparkle');

    // 保護期內：發呆隨機心情不得覆蓋
    CONFIG.bubbleChance = 1; // 逼 maybeShowEmote 一定要冒泡
    for (let i = 0; i < 50; i++) p.maybeShowEmote();
    check('保護期內：發呆心情無法覆蓋', p.bubbleName === 'sparkle');

    // 保護期內：被戳只跳、不換愛心
    const shown = p.showEmote('heart', 1600);
    check('保護期內：showEmote 回傳 false', shown === false);
    p.poke();
    check('保護期內：被戳仍是 sparkle', p.bubbleName === 'sparkle');
    check('保護期內：被戳照樣會跳', p.jumpV > 0);

    // 保護期內：發呆結束不得提前收起
    p.state = 'IDLE';
    p.idleTimer = 1;
    p.idle(16);
    check('保護期內：發呆結束不收起', p.bubble.style.display === 'block');
    check('發呆結束照樣回到 WALKING', p.state === 'WALKING');

    // 保護期內轉向仍會換邊 + 鏡像尾巴
    p.direction = -1;
    p.updateDOM();
    check('保護期內轉向仍換邊', p.bubble.style.left === '0'
        && p.bubble.src === T.getEmoteURI('sparkle', 1));

    // 4 秒到 → 解鎖並自動收起
    advance(3999);
    check('3999ms：還在演', p.bubble.style.display === 'block' && p.bubbleLocked === true);
    advance(2);
    check('4000ms：自動收起', p.bubble.style.display === 'none');
    check('4000ms：解鎖', p.bubbleLocked === false);

    // 解鎖後恢復正常
    check('解鎖後可以再冒別的心情', p.showEmote('scribble') === true && p.bubbleName === 'scribble');
    p.hideEmote();
    check('解鎖後 hideEmote 有效', p.bubble.style.display === 'none');
}

group('7. 非色違不受影響');
{
    const p = newPokemon(25, { shiny: false, scale: 0.6 });
    check('非色違登場不冒泡', p.bubble.style.display === 'none');
    check('非色違沒有保護期', p.bubbleLocked === false);
    p.poke();
    check('被戳冒愛心', p.bubbleName === 'heart' && p.bubble.style.display === 'block');
    advance(1599);
    check('1599ms：愛心還在', p.bubble.style.display === 'block');
    advance(2);
    check('1600ms：愛心自動收起', p.bubble.style.display === 'none');
    // 愛心期間再冒別的心情：不該被舊計時器誤傷
    p.poke();
    p.showEmote('question');
    advance(1601);
    check('後續心情不被前一個計時器誤收', p.bubble.style.display === 'block' && p.bubbleName === 'question');
}

group("8. bubblePosition = 'none' 仍完全關閉");
CONFIG.bubblePosition = 'none';
{
    const p = newPokemon(143, { shiny: true });
    check('色違也不冒泡', p.bubble.style.display === 'none');
    check('不會誤留鎖（否則永遠不解鎖）', p.bubbleLocked === false);
    check('showEmote 回傳 false', p.showEmote('heart', 1600) === false);
    p.poke();
    check('被戳仍只跳不冒泡', p.bubble.style.display === 'none' && p.jumpV > 0);
}
CONFIG.bubblePosition = 'side';

// =========================================================
group('9. 體型分級（新 baseSize / sizeTiers）');
{
    const tierFor = m => CONFIG.sizeTiers.find(t => m < t.maxMeters).scale;
    check('0.4m（皮卡丘）→ 小 0.6', tierFor(0.4) === 0.6);
    check('1.1m（皮卡丘進化）→ 中 0.8', tierFor(1.1) === 0.8);
    check('2.1m（卡比獸）→ 大 1', tierFor(2.1) === 1);
    const p = newPokemon(143, { scale: 1 });
    check('大體型 sprite 高度 = 128px', p.img.style.height === '128px');
    const s = newPokemon(25, { scale: 0.6 });
    check('小體型 sprite 高度 = 77px', s.img.style.height === '77px', s.img.style.height);
    check('小體型的對話框倍率仍是整數 2x', s.bubbleScale === 2);
    check('大體型的對話框倍率 3x', p.bubbleScale === 3);
}

// =========================================================
group('10. 星星特效未被波及');
{
    const p = newPokemon(143, { shiny: true });
    const before = p.el.children.length;
    p.celebrateShiny();
    const stars = p.el.children.filter(c => c.className === 'burst-star');
    check('炸出 10 顆星星', stars.length === 10, `實際 ${stars.length}`);
    check('時長吃 shinyBurstDuration',
        stars.every(s => s.style.animationDuration === `${CONFIG.shinyBurstDuration}ms`));
    check('每顆都有 --dx / --dy 飛行向量',
        stars.every(s => /px$/.test(s.style._props['--dx'] || '') && /px$/.test(s.style._props['--dy'] || '')));
    // 弧線刻意從水平線下方一點開始（-0.15π ~ 1.15π），所以少數星星會略往下飛；
    // 真正要守住的是「不會飛到頁面底邊以下被裁掉」——起點在身高一半處
    const launchY = Math.round(p.img.offsetHeight * 0.5);
    check(`向下飛的距離都在起飛高度 ${launchY}px 之內（不會被底邊裁掉）`,
        stars.every(s => parseInt(s.style._props['--dy'], 10) <= launchY),
        stars.map(s => s.style._props['--dy']).join(' '));
}

// =========================================================
group('11. 保底值不再寫死舊數字');
{
    check('查不到身高的保底 = sizeTiers 的中間一級 0.8', T.fallbackSizeScale() === 0.8,
        `實際 ${T.fallbackSizeScale()}`);
    // 換一組 tiers，保底值要自己跟上（不是寫死 0.75）
    const saved = CONFIG.sizeTiers;
    CONFIG.sizeTiers = [{ maxMeters: 1, scale: 0.3 }, { maxMeters: Infinity, scale: 0.9 }];
    check('改 sizeTiers 後保底值跟著變', T.fallbackSizeScale() === 0.9, `實際 ${T.fallbackSizeScale()}`);
    CONFIG.sizeTiers = [];
    check('sizeTiers 空陣列時保底 1（不會 undefined）', T.fallbackSizeScale() === 1);
    CONFIG.sizeTiers = saved;

    // config 少了 bubblePosition 這個 key 時，程式內建的預設值應與文件一致（side）
    const savedPos = CONFIG.bubblePosition;
    delete CONFIG.bubblePosition;
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    check('缺 bubblePosition key → 內建預設走 side',
        p.bubble.style.left === '100%' && p.bubble.src === T.getEmoteURI('heart', -1),
        `left=${p.bubble.style.left}`);
    CONFIG.bubblePosition = savedPos;
}

// =========================================================
group('12. 快出畫面就翻到內側');
CONFIG.bubblePosition = 'side';
{
    const W = sandbox.window.innerWidth;
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    const { width, gap } = p.bubbleMetrics();
    const bodyW = p.img.offsetWidth;

    check('畫面中央：照面向擺右側', p.bubbleSide === 1 && p.bubble.style.left === '100%');

    // 右側剛好差 1px 塞不下 → 翻到左邊
    p.x = W - bodyW - gap - width + 1;
    p.updateDOM();
    check('貼右邊界：面向右但翻到左側', p.bubbleSide === -1 && p.bubble.style.left === '0');
    check('翻邊後尾巴改朝右（仍指回本體）', p.bubble.src === T.getEmoteURI('heart', 1));
    check('只有對話框換邊，本體面向不動', p.direction === 1);
    check('翻邊後位移是 -(100% + gap)',
        p.bubble.style.transform
            === `translateX(calc(-100% ${gap >= 0 ? `- ${gap}px` : `+ ${-gap}px`}))`,
        p.bubble.style.transform);

    // 剛好塞得下就不翻
    p.x = W - bodyW - gap - width;
    p.updateDOM();
    check('右側剛好塞得下：維持面向那側', p.bubbleSide === 1 && p.bubble.style.left === '100%');

    // 左邊界 + 面向左 → 翻到右邊
    const q = newPokemon(143, { direction: -1 });
    q.showEmote('note');
    check('面向左：先擺左側', q.bubbleSide === -1);
    q.x = gap + width - 1; // 左側差 1px 塞不下
    q.updateDOM();
    check('貼左邊界：面向左但翻到右側', q.bubbleSide === 1 && q.bubble.style.left === '100%');
    check('翻邊後尾巴改朝左', q.bubble.src === T.getEmoteURI('note', -1));
    q.x = gap + width;
    q.updateDOM();
    check('左側剛好塞得下：翻回左側', q.bubbleSide === -1);

    // 走著走著逼近邊界（保護期中的色違會邊走邊冒泡）也要即時翻邊。
    // 起點在門檻左邊 40px、終點越過門檻 10px，中間分五幀走完
    // （門檻由 gap 決定，所以這裡從實際 metrics 推，不寫死）
    const r = newPokemon(143, { shiny: true, direction: 1 });
    check('色違登場先擺右側', r.bubbleSide === 1);
    // 門檻要用「這一隻自己的」框寬算：sparkle 是 16px 瘦框，比愛心的 20px 窄
    const rm = r.bubbleMetrics();
    const edgeX = W - bodyW - rm.gap - rm.width; // 剛好塞得下的最右位置
    for (let i = 0; i <= 5; i++) { r.x = edgeX - 40 + i * 10; r.updateDOM(); }
    check('邊走邊靠近右邊界 → 自動翻到左側', r.bubbleSide === -1, `x=${r.x}, 門檻=${edgeX}`);
    check('翻邊不影響保護期', r.bubbleLocked === true && r.bubbleName === 'sparkle');

    // 兩側都塞不下（視窗超窄）：維持面向，不要每幀左右彈跳
    sandbox.window.innerWidth = bodyW + 10;
    const s = newPokemon(143, { direction: 1 });
    s.showEmote('heart');
    s.x = 5;
    s.updateDOM();
    check('兩側都塞不下：維持面向那側', s.bubbleSide === 1, `實際 ${s.bubbleSide}`);
    s.updateDOM(); s.updateDOM();
    check('連續數幀也不左右彈跳', s.bubbleSide === 1);
    sandbox.window.innerWidth = W;

    // top / none 模式不受這套邏輯影響
    CONFIG.bubblePosition = 'top';
    const t = newPokemon(143, { direction: 1 });
    t.showEmote('heart');
    t.x = W - 1; // 極端貼邊
    t.updateDOM();
    check('top 模式：貼邊也不換邊，維持置中',
        t.bubble.style.left === '50%' && t.bubble.style.transform === 'translateX(-50%)');
    CONFIG.bubblePosition = 'side';
}

// =========================================================
group('13. bubbleLayer：對話框在本體之上／之下');
CONFIG.bubblePosition = 'side';
{
    check("config.js 預設 = 'front'", CONFIG.bubbleLayer === 'front', `實際 ${CONFIG.bubbleLayer}`);

    const saved = CONFIG.bubbleLayer;
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    // sprite 因為 will-change: transform 會被歸到 z-index:0 那一階，
    // 所以「之上」必須是正值才跨得過去（0 或 auto 會被 DOM 順序判輸）
    check("front → z-index 為正（跨過 sprite）", Number(p.bubble.style.zIndex) > 0,
        `實際 ${p.bubble.style.zIndex}`);

    CONFIG.bubbleLayer = 'behind';
    const q = newPokemon(143, { direction: 1 });
    q.showEmote('heart');
    check('behind → z-index 為負（躲回 sprite 後面）', Number(q.bubble.style.zIndex) < 0,
        `實際 ${q.bubble.style.zIndex}`);
    check('behind 仍在影子之上（影子 z-index -1，靠 DOM 順序勝出）',
        q.el.children.indexOf(q.bubble) > q.el.children.indexOf(q.shadow));

    // 換邊重擺時 z-index 不能掉
    q.direction = -1;
    q.updateDOM();
    check('換邊後 behind 的 z-index 還在', Number(q.bubble.style.zIndex) < 0);

    // top 模式同樣吃這個設定
    CONFIG.bubbleLayer = 'front';
    CONFIG.bubblePosition = 'top';
    const t = newPokemon(143, { direction: 1 });
    t.showEmote('heart');
    check('top 模式也照 bubbleLayer 分層', Number(t.bubble.style.zIndex) > 0);
    CONFIG.bubblePosition = 'side';

    // 缺 key 時退回 front（相容舊的 config.js）
    delete CONFIG.bubbleLayer;
    const r = newPokemon(143, { direction: 1 });
    r.showEmote('heart');
    check('缺 bubbleLayer key → 退回 front', Number(r.bubble.style.zIndex) > 0);
    CONFIG.bubbleLayer = saved;

    const spec = T.QUERY_PARAMS?.bubbleLayer;
    check('已登記在 QUERY_PARAMS', !!spec);
    check('型別 enum，允許值 front / behind',
        spec?.type === 'enum' && JSON.stringify(spec?.values) === '["front","behind"]');
}

// =========================================================
group('14. bubbleSideGap：side 對話框的左右空隙');
CONFIG.bubblePosition = 'side';
{
    check('config.js 預設 = -5（往身體上疊）', CONFIG.bubbleSideGap === -5,
        `實際 ${CONFIG.bubbleSideGap}`);

    const saved = CONFIG.bubbleSideGap;
    // 設定值是點陣圖 px，乘上放大倍率：大體型 3x、小體型 2x
    const big = newPokemon(143, { scale: 1 });      // bubbleScale 3
    const small = newPokemon(25, { scale: 0.6 });   // bubbleScale 2
    big.showEmote('heart');
    small.showEmote('heart');
    check('大體型（3x）預設空隙 = -15px', big.bubbleMetrics().gap === -15, `實際 ${big.bubbleMetrics().gap}`);
    check('小體型（2x）預設空隙 = -10px', small.bubbleMetrics().gap === -10, `實際 ${small.bubbleMetrics().gap}`);
    check('預設值套進 transform', big.bubble.style.transform === 'translateX(-15px)',
        big.bubble.style.transform);
    // 疊上去也不能疊過頭：框要有一半以上留在身體外面才看得清楚
    const bigW = big.bubbleMetrics().width;
    check('預設重疊量不超過框寬的一半', Math.abs(big.bubbleMetrics().gap) < bigW / 2,
        `重疊 ${-big.bubbleMetrics().gap}px / 框寬 ${bigW}px`);

    // 調大：右側往右推、左側往左退更多
    CONFIG.bubbleSideGap = 6;
    big.placeBubble(1);
    check('調成 6 → 大體型 18px', big.bubble.style.transform === 'translateX(18px)');
    big.placeBubble(-1);
    check('調成 6 → 左側是 calc(-100% - 18px)',
        big.bubble.style.transform === 'translateX(calc(-100% - 18px))');

    // 0：剛好貼齊本體邊緣
    CONFIG.bubbleSideGap = 0;
    big.placeBubble(1);
    check('0 → 右側零位移（貼齊邊緣）', big.bubble.style.transform === 'translateX(0px)');
    big.placeBubble(-1);
    check('0 → 左側剛好是 -100%', big.bubble.style.transform === 'translateX(calc(-100% - 0px))');

    // 負數：往身體上疊，且不能產生 calc(-100% - -6px) 這種雙負號
    CONFIG.bubbleSideGap = -2;
    big.placeBubble(1);
    check('-2 → 右側往內疊 -6px', big.bubble.style.transform === 'translateX(-6px)');
    big.placeBubble(-1);
    check('-2 → 左側改用加號，不出現雙負號',
        big.bubble.style.transform === 'translateX(calc(-100% + 6px))',
        big.bubble.style.transform);
    check('組出的 calc 沒有 "- -"', !big.bubble.style.transform.includes('- -'));

    // 非整數設定值要取整，避免半像素把點陣圖弄糊
    CONFIG.bubbleSideGap = 1.5;
    check('1.5 × 3x = 4.5 → 取整成 5', big.bubbleMetrics().gap === 5, `實際 ${big.bubbleMetrics().gap}`);
    big.placeBubble(1);
    check('transform 也是整數 px', big.bubble.style.transform === 'translateX(5px)');

    // 空隙會一併影響「快出畫面就翻到內側」的判斷
    CONFIG.bubbleSideGap = 2;
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    const { width } = p.bubbleMetrics();
    const bodyW = p.img.offsetWidth;
    p.x = sandbox.window.innerWidth - bodyW - 6 - width; // 用 gap=6 剛好塞得下
    p.updateDOM();
    check('gap 2：剛好塞得下，維持右側', p.bubbleSide === 1);
    CONFIG.bubbleSideGap = 3; // 空隙變大 → 同一個位置就塞不下了
    p.updateDOM();
    check('gap 3：同一位置變成塞不下 → 翻到左側', p.bubbleSide === -1);

    // 缺 key 時退回 2（相容舊的 config.js）
    delete CONFIG.bubbleSideGap;
    check('缺 bubbleSideGap key → 退回程式內建的 2（大體型 6px）',
        big.bubbleMetrics().gap === 6, `實際 ${big.bubbleMetrics().gap}`);
    CONFIG.bubbleSideGap = saved;
}

// =========================================================
group('15. bubbleSideLift：side 對話框的垂直微調');
CONFIG.bubblePosition = 'side';
{
    check('config.js 預設 = 2', CONFIG.bubbleSideLift === 2, `實際 ${CONFIG.bubbleSideLift}`);

    const saved = CONFIG.bubbleSideLift;
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    check('預設 → calc(60% + 2px)', p.bubble.style.bottom === 'calc(60% + 2px)', p.bubble.style.bottom);

    CONFIG.bubbleSideLift = 0;
    p.placeBubble(1);
    check('0 → 就是原本的 60%，不多包一層 calc', p.bubble.style.bottom === '60%', p.bubble.style.bottom);

    CONFIG.bubbleSideLift = 8;
    p.placeBubble(1);
    check('8 → calc(60% + 8px)', p.bubble.style.bottom === 'calc(60% + 8px)');

    // 負數往下，且不能組出 calc(60% + -3px)
    CONFIG.bubbleSideLift = -3;
    p.placeBubble(1);
    check('-3 → 改用減號往下移', p.bubble.style.bottom === 'calc(60% - 3px)', p.bubble.style.bottom);
    check('沒有出現 "+ -" 雙符號', !p.bubble.style.bottom.includes('+ -'));

    // 非整數取整（半像素會讓點陣圖糊掉）
    CONFIG.bubbleSideLift = 2.6;
    p.placeBubble(1);
    check('2.6 → 取整成 3px', p.bubble.style.bottom === 'calc(60% + 3px)', p.bubble.style.bottom);

    // 換邊時垂直位置不變
    CONFIG.bubbleSideLift = 2;
    p.placeBubble(-1);
    check('換到左側 → 垂直位置一樣', p.bubble.style.bottom === 'calc(60% + 2px)');

    // 不影響大小體型的相對錨點（六成是比例，lift 是固定 px）
    const small = newPokemon(25, { scale: 0.6 });
    small.showEmote('heart');
    check('小體型同樣是 60% + 2px（錨點比例照舊）',
        small.bubble.style.bottom === 'calc(60% + 2px)');

    // top 模式不吃這個設定
    CONFIG.bubblePosition = 'top';
    const t = newPokemon(143, { direction: 1 });
    t.showEmote('heart');
    check('top 模式仍是 calc(100% + 2px)（頭頂那顆固定值）',
        t.bubble.style.bottom === 'calc(100% + 2px)', t.bubble.style.bottom);
    CONFIG.bubblePosition = 'side';

    // 缺 key 時退回 2
    delete CONFIG.bubbleSideLift;
    p.placeBubble(1);
    check('缺 bubbleSideLift key → 退回 2', p.bubble.style.bottom === 'calc(60% + 2px)');
    CONFIG.bubbleSideLift = saved;

    const spec = T.QUERY_PARAMS?.bubbleSideLift;
    check('已登記在 QUERY_PARAMS', !!spec);
    check('型別 int 且允許負數', spec?.type === 'int' && spec?.min < 0);
}

// =========================================================
group('16. bubbleSideGap 的 URL 參數白名單');
{
    const spec = T.QUERY_PARAMS?.bubbleSideGap;
    check('已登記在 QUERY_PARAMS', !!spec);
    if (spec) {
        check('型別 int（半像素會糊掉）', spec.type === 'int');
        check('允許負數（可疊回身體上）', spec.min < 0);
        check('路徑指向 bubbleSideGap', JSON.stringify(spec.path) === '["bubbleSideGap"]');
    }
}

// =========================================================
group('17. theme 主題地面');
{
    check("config.js 預設 theme = 'none'（不鋪地面）", CONFIG.theme === 'none');
    const spec = T.QUERY_PARAMS?.theme;
    check('已登記在 QUERY_PARAMS（enum）', spec?.type === 'enum');
    check('允許值 = none + 7 種地形',
        JSON.stringify(spec?.values) === JSON.stringify(['none', 'grass', 'water', 'snow', 'sand', 'rock', 'dirt', 'lava']),
        JSON.stringify(spec?.values));
    check('每種地形都有主題定義（none 除外）',
        (spec?.values ?? []).filter(v => v !== 'none').every(v => T.GROUND_THEMES[v]));

    // none / 打錯字：不鋪地面、抬高 0，一切維持原樣
    const before = appEl.children.length;
    check("theme='none' 不鋪地面、抬高 0",
        T.initGround('none') === 0 && appEl.children.length === before);
    check('未知主題同樣安全（防拼錯）',
        T.initGround('rainbow') === 0 && appEl.children.length === before);

    // 鋪草地：元素進場、抬高量 = (貼片高 - 踩入深度) × 倍率
    const lift = T.initGround('grass');
    const ground = appEl.children[appEl.children.length - 1];
    check('鋪了 #ground 元素', ground && ground.id === 'ground');
    check('地面高度 = 12 × 2 = 24px', ground.style.height === '24px');
    check('抬高量 = (12 - inset 3) × 2 = 18px', lift === 18, `實際 ${lift}`);

    // 貼片像素：頂緣整列墨線、第二列整列亮色、中段以底色為大宗
    const uri = (ground.style.backgroundImage.match(/^url\((.+)\)$/) || [])[1];
    const grid = pixelGrids.get(uri);
    check('貼片有畫出來（256×12）', grid && grid.length === 12 && grid[0].split('|').length === 256);
    if (grid) {
        const t = T.GROUND_THEMES.grass;
        check('頂緣整列墨線色', grid[0].split('|').every(c => c === t.top[0]));
        check('第二列整列亮色', grid[1].split('|').every(c => c === t.top[1]));
        const midRow = grid[6].split('|');
        check('中段以底色為大宗（斑點與圖章只是點綴）',
            midRow.filter(c => c === t.fill).length > 256 * 0.6,
            `底色佔 ${midRow.filter(c => c === t.fill).length}/256`);
    }

    // 寶可夢站上地面：容器整個抬高（影子、對話框都在容器裡會跟上）
    const p = new T.Pokemon(25, appEl, 1, 0, lift);
    check('寶可夢容器 bottom = 抬高量', p.el.style.bottom === '18px', `實際 ${p.el.style.bottom}`);
    const p2 = new T.Pokemon(25, appEl, 1, 0, 0);
    check('沒有地面時不動 bottom（維持 CSS 的 0）', p2.el.style.bottom === undefined);

    // 水域：流動動畫 + 踩得更深（inset 5 → 抬高 14px）
    const waterLift = T.initGround('water');
    const water = appEl.children[appEl.children.length - 1];
    check('水域掛上流動動畫 class', water.className === 'ground-flow');
    check('流動一輪位移 = 貼片顯示寬（無縫循環）',
        water.style.getPropertyValue('--flow-width') === '-512px',
        `實際 ${water.style.getPropertyValue('--flow-width')}`);
    check('水域踩得更深（inset 5 → 抬高 14px）', waterLift === 14, `實際 ${waterLift}`);
    check('岩地幾乎不下陷（inset 1 → 抬高 22px）', T.initGround('rock') === 22);
}

// =========================================================
group('18. 客串事件（飛行系/傳說高速橫越）');
{
    // 名單檔在「獨立」context 驗證：主 sandbox 刻意不載 pokemon_cameo.js，
    // 否則排程器會啟動，假時鐘 advance 時客串就會隨機亂入其他測試
    const cameoSandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pokemon_cameo.js'), 'utf8'), cameoSandbox);
    const FLY = cameoSandbox.window.POKE_FLYING;
    const LEG = cameoSandbox.window.POKE_LEGENDARY;
    check('飛行池非空且都在 1~649', FLY?.length > 50 && FLY.every(n => n >= 1 && n <= 649),
        `共 ${FLY?.length} 隻`);
    check('傳說池 = 會飛的傳說 9 隻（三聖鳥/洛奇亞/鳳王/烈空坐/雲三家）',
        JSON.stringify(LEG) === JSON.stringify([144, 145, 146, 249, 250, 384, 641, 642, 645]),
        `實際 ${JSON.stringify(LEG)}`);
    check('不會飛的傳說進不了飛行客串（超夢/夢幻/固拉多/蓋歐卡）',
        ![150, 151, 383, 382].some(n => LEG.includes(n) || FLY.includes(n)));
    check('兩池不重疊（傳說不稀釋飛行池的平均分佈）', FLY.every(n => !LEG.includes(n)));
    check('抽查：噴火龍/比雕/暴鯉龍在飛行池', FLY.includes(6) && FLY.includes(18) && FLY.includes(130));
    check('主 sandbox 沒有名單 → 排程器不啟動（本測試的前提）',
        !sandbox.window.POKE_FLYING && !sandbox.window.POKE_LEGENDARY);

    // config 預設
    check('flybyDelay 預設 15~20 秒', CONFIG.flybyDelay.min === 15000 && CONFIG.flybyDelay.max === 20000);
    check('flybyChance 預設 0.25', CONFIG.flybyChance === 0.25);
    check('flybyLegendaryChance 預設 0.05（極低）', CONFIG.flybyLegendaryChance === 0.05);
    check('flybySpeed 預設 14', CONFIG.flybySpeed === 14);

    // URL 參數白名單
    for (const [name, pathStr] of [
        ['flybyDelayMin', '["flybyDelay","min"]'],
        ['flybyDelayMax', '["flybyDelay","max"]'],
        ['flybyChance', '["flybyChance"]'],
        ['flybyLegendaryChance', '["flybyLegendaryChance"]'],
        ['flybySpeed', '["flybySpeed"]'],
    ]) {
        const spec = T.QUERY_PARAMS?.[name];
        check(`${name} 已登記且路徑正確`, !!spec && JSON.stringify(spec.path) === pathStr);
    }
    check('delay 下限 1000ms（防 setTimeout 轟炸）',
        T.QUERY_PARAMS.flybyDelayMin.min >= 1000 && T.QUERY_PARAMS.flybyDelayMax.min >= 1000);

    // Cameo 行為
    const savedShiny = CONFIG.shinyChance;
    CONFIG.shinyChance = 0;
    const c = new T.Cameo(6, 1);
    check('從畫面外出發', c.x < 0 || c.x > 1920, `x=${c.x}`);
    check('速度 = flybySpeed ±15%', c.speed >= 14 * 0.85 && c.speed <= 14 * 1.15, `實際 ${c.speed}`);
    const x0 = c.x;
    check('行程中：update 回傳 true 且高速前進',
        c.update(1000 / 60) === true && Math.abs(c.x - x0) > 10,
        `一幀移動 ${Math.abs(c.x - x0).toFixed(1)}px`);
    c.x = c.direction === 1 ? 1920 + c.margin + 1 : -c.margin - 1;
    check('飛出對側畫面外 → 回報移除', c.update(16) === false);

    // 斜線航道 + 浮沉（stub 視窗高 200 → 高度帶 90 ~ 150）
    const yOf = el => Number((el.style.transform.match(/translate3d\([^,]+,\s*(-?\d+)px/) || [])[1]);
    const f = new T.Cameo(18, 1);
    check('起點高度在視窗高 45%~75%', f.startBottom >= 90 && f.startBottom <= 150, `實際 ${f.startBottom}`);
    check('終點高度獨立隨機、也在 45%~75%', f.endBottom >= 90 && f.endBottom <= 150, `實際 ${f.endBottom}`);
    check('斜率 = 高度差 ÷ 出發當下的全程距離',
        Math.abs(f.slope - (f.endBottom - f.startBottom) / (1920 + f.margin * 2)) < 1e-9);
    check('浮沉振幅 3~7px、節奏 0.003~0.006 rad/ms',
        f.floatAmp >= 3 && f.floatAmp <= 7 && f.floatFreq >= 0.003 && f.floatFreq <= 0.006);

    // 斜線：關掉浮沉，前進 500px 後高度 = 起點 + 500 × 斜率
    f.floatAmp = 0;
    f.x = f.startX + 500 * f.direction;
    f.render();
    check('前進 500px 後爬升/滑降到位',
        yOf(f.el) === -Math.round(f.startBottom + 500 * f.slope),
        `transform y=${yOf(f.el)}，期望 ${-Math.round(f.startBottom + 500 * f.slope)}`);

    // 浮沉：關掉斜率，sin 波峰與波谷高度差 = 2 × 振幅（有上有下，不是 |sin| 落地彈）
    f.slope = 0;
    f.floatAmp = 5;
    f.x = f.startX;
    f.floatPhase = Math.PI / 2;  f.render(); const crest = yOf(f.el);
    f.floatPhase = -Math.PI / 2; f.render(); const trough = yOf(f.el);
    check('浮沉波峰對波谷相差 2 × 振幅', crest - trough === -10, `實際 ${crest - trough}`);
    const phase0 = f.floatPhase;
    f.update(100);
    check('update 會推進浮沉相位', f.floatPhase > phase0);

    // 色違：吃全頁 shinyChance、走 shiny/ 目錄、拖星塵尾跡
    CONFIG.shinyChance = 1;
    const s = new T.Cameo(16, 0.6);
    check('色違判定吃全頁 shinyChance', s.isShiny === true);
    check('色違 sprite 走 shiny/ 目錄', s.img.src.includes('/shiny/'));
    const starsBefore = appEl.children.length;
    s.update(100);
    const tail = appEl.children[appEl.children.length - 1];
    check('飛行中撒出星塵尾跡（復用 burst-star）',
        appEl.children.length > starsBefore && tail.className === 'burst-star');
    CONFIG.shinyChance = savedShiny;

    // 載圖備援：動圖 → 靜圖 → 兩段都失敗就取消這次客串
    const d = new T.Cameo(6, 1);
    d.img.onerror();
    check('動圖失敗 → 退靜態圖', d.img.src.endsWith('/6.png'));
    d.img.onerror();
    check('靜圖也失敗 → 本幀回報移除，不留破圖', d.update(16) === false);
}

console.log(`\n${'='.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
