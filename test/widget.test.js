// =========================================================
// PokéStroll 單元測試
//
//   執行：node test/widget.test.js   （不需要 npm install，零依賴）
//
// widget 是純靜態 HTML + js/ 底下的一組傳統 <script src>（一檔一職責）。
// 這支測試照 HTML 的標籤順序把每個檔案逐一丟進同一個 Node vm context，
// 配一套最小 DOM stub 跑「真正的」Pokemon 類別 —— 不是複製一份邏輯來測，
// 改壞了主程式這裡就會紅燈；載入順序寫錯（先用到後面檔案的東西）也會炸。
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

// ---- 從 HTML 讀出主程式清單（js/ 底下；載入順序的真理來源是 HTML 本身）----
const jsFiles = [...html.matchAll(/<script src="\.\/(js\/[^"]+)"><\/script>/g)].map(m => m[1]);
if (jsFiles.length < 10) throw new Error(`js/ 主程式清單只抓到 ${jsFiles.length} 個，疑似 HTML 結構變了`);

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
        removed: false,
        remove() { this.removed = true; }, // stub 不真的拆樹，記旗標供斷言
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
        hidden: false, // 分頁可見度：背景分頁防護的測試會切這個開關
        // 丟果實餵食掛在 document 的 click 上；測試從 listeners 餵假事件
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    },
    location: { search: '' },
    window: {
        innerWidth: 1920,
        innerHeight: 200, // footer iframe 的典型高度（客串事件的飛行高度依它計算）
        POKE_CONFIG: null, // 下面注入
        POKE_HEIGHTS: { 25: 4, 143: 21 }, // 皮卡丘 0.4m（小）、卡比獸 2.1m（大）
        POKE_TYPES: { 25: 'electric', 143: 'normal' },
        // postMessage 遙控會掛 message 監聽器；測試從 listeners 取出直接餵假事件
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    },
};
sandbox.globalThis = sandbox;

// 載入真正的 config.js（同時驗證它語法正確、預設值正確）
vm.createContext(sandbox);
const configSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
vm.runInContext(configSrc, sandbox, { filename: 'config.js' });
const CONFIG = sandbox.window.POKE_CONFIG;

// config 預設的地面主題另存一份給第 17 組驗證，隨即釘回 'none'：
// 主程式一載入就會跑 init() → initGround(CONFIG.theme)，預設的 'random'
// 會讓 groundLevel 隨機，果實落點、抓取高度……一票斷言全會翻車
const DEFAULT_THEME = CONFIG.theme;
CONFIG.theme = 'none';

// 照 HTML 的載入順序逐檔執行主程式——跟瀏覽器一樣一個檔案一個 script，
// 跨檔的載入順序問題（load 時就呼叫後面檔案的東西）在這裡會直接炸
for (const f of jsFiles) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
// 把要測的東西掛到 globalThis：頂層 let/const/class 活在同一個
// global lexical scope（與瀏覽器的傳統 <script> 一致），跨檔拿得到
vm.runInContext(
    'globalThis.__T = { Pokemon, buildBubbleFrame, getEmoteURI, EMOTE_ICONS, EMOTE_PALETTE, CONFIG, fallbackSizeScale, QUERY_PARAMS, initGround, buildGroundTexture, GROUND_THEMES, Cameo, scheduleFlyby, spawnFlyby, cameos, pokemons, remoteStamps, throwBerry, updateBerries, feedingBusy, removeBerry, BERRY_ART, BERRY_PALETTE, getBerries: () => berries, Snatcher, updateSnatch, getSnatch: () => activeSnatch, getPending: () => pendingSnatch, resolveTheme, initWeather, THEME_WEATHER, updateBerryShadow };',
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

    // 飛散範圍倍率：2x 的最小半徑要明顯大於 0.5x 的最大半徑
    //（大體型基礎半徑 26~42 × 1.2：2x 落在 62~101、0.5x 落在 16~26）
    check('shinyBurstScale 已登記（float 0.1 ~ 5）',
        T.QUERY_PARAMS?.shinyBurstScale?.type === 'float'
        && T.QUERY_PARAMS.shinyBurstScale.min === 0.1 && T.QUERY_PARAMS.shinyBurstScale.max === 5);
    check('config.js 預設 shinyBurstScale = 1', CONFIG.shinyBurstScale === 1);
    const radius = s => Math.hypot(
        parseInt(s.style._props['--dx'], 10), parseInt(s.style._props['--dy'], 10));
    const savedBurstScale = CONFIG.shinyBurstScale;
    CONFIG.shinyBurstScale = 2;
    p.celebrateShiny();
    CONFIG.shinyBurstScale = 0.5;
    p.celebrateShiny();
    CONFIG.shinyBurstScale = savedBurstScale;
    const allStars = p.el.children.filter(c => c.className === 'burst-star');
    const bigR = allStars.slice(10, 20).map(radius);
    const smallR = allStars.slice(20, 30).map(radius);
    check('shinyBurstScale=2 → 半徑加倍（全部 ≥ 60px）',
        bigR.every(r => r >= 60), bigR.map(Math.round).join(' '));
    check('shinyBurstScale=0.5 → 半徑縮半（全部 ≤ 27px）',
        smallR.every(r => r <= 27), smallR.map(Math.round).join(' '));
    check('倍率只調範圍：每輪仍是 10 顆星星', allStars.length === 30, `實際 ${allStars.length}`);
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
    check("config.js 預設 theme = 'random'（每次載入隨機抽一種）", DEFAULT_THEME === 'random');
    const spec = T.QUERY_PARAMS?.theme;
    check('已登記在 QUERY_PARAMS（enum）', spec?.type === 'enum');
    check('允許值 = none + random + 7 種地形',
        JSON.stringify(spec?.values) === JSON.stringify(['none', 'random', 'grass', 'water', 'snow', 'sand', 'rock', 'dirt', 'lava']),
        JSON.stringify(spec?.values));
    check('每種地形都有主題定義（none / random 除外）',
        (spec?.values ?? []).filter(v => v !== 'none' && v !== 'random').every(v => T.GROUND_THEMES[v]));

    // none / 打錯字：不鋪地面、抬高 0，一切維持原樣
    const before = appEl.children.length;
    check("theme='none' 不鋪地面、抬高 0",
        T.initGround('none') === 0 && appEl.children.length === before);
    check('未知主題同樣安全（防拼錯）',
        T.initGround('rainbow') === 0 && appEl.children.length === before);

    // random：載入時擲一次骰，隨機池 = 七種地形 + 'none'（無地板也抽得到）
    const origRandom = Math.random;
    Math.random = () => 0; // randomInt(0, 7) → 0 → 池子第一種（草地）
    check("theme='random' 抽到地形 → 正常鋪（抬高 > 0）", T.initGround('random') > 0);
    Math.random = () => 0.999; // → 7 → 池子最後一格 'none'
    const beforeNone = appEl.children.length;
    check("theme='random' 也抽得到無地板（抬高 0、不鋪元素）",
        T.initGround('random') === 0 && appEl.children.length === beforeNone);
    Math.random = origRandom;
    check("'random' 不是地形定義（靠 initGround 解析，不靠查表）",
        T.GROUND_THEMES.random === undefined);

    // 鋪草地：元素進場、抬高量 = 地面高度 - 踩入深度 × 倍率
    check("config.js 預設 themeHeight = 12", CONFIG.themeHeight === 12);
    check('themeHeight 已登記在 QUERY_PARAMS', T.QUERY_PARAMS?.themeHeight?.type === 'int');
    const lift = T.initGround('grass');
    const ground = appEl.children[appEl.children.length - 1];
    check('鋪了 #ground 元素', ground && ground.id === 'ground');
    check('地面高度 = themeHeight 預設 12px', ground.style.height === '12px');
    check('抬高量 = 12 - inset 3 × 2 = 6px', lift === 6, `實際 ${lift}`);

    // 貼片像素：頂緣整列墨線、第二列整列亮色、中段以底色為大宗
    const uri = (ground.style.backgroundImage.match(/^url\((.+)\)$/) || [])[1];
    const grid = pixelGrids.get(uri);
    check('貼片有畫出來（256×6）', grid && grid.length === 6 && grid[0].split('|').length === 256);
    if (grid) {
        const t = T.GROUND_THEMES.grass;
        check('頂緣整列墨線色', grid[0].split('|').every(c => c === t.top[0]));
        check('第二列整列亮色', grid[1].split('|').every(c => c === t.top[1]));
        const midRow = grid[4].split('|');
        check('中段以底色為大宗（斑點與圖章只是點綴）',
            midRow.filter(c => c === t.fill).length > 256 * 0.6,
            `底色佔 ${midRow.filter(c => c === t.fill).length}/256`);
    }

    // themeHeight 客製：40px → 高 40、抬高 40 - 6 = 34
    CONFIG.themeHeight = 40;
    const tallLift = T.initGround('grass');
    const tall = appEl.children[appEl.children.length - 1];
    check('themeHeight=40 → 地面高 40px', tall.style.height === '40px');
    check('抬高量跟著變（40 - 6 = 34px）', tallLift === 34, `實際 ${tallLift}`);
    CONFIG.themeHeight = 12;

    // 寶可夢站上地面：容器整個抬高（影子、對話框都在容器裡會跟上）
    const p = new T.Pokemon(25, appEl, 1, 0, lift);
    check('寶可夢容器 bottom = 抬高量', p.el.style.bottom === '6px', `實際 ${p.el.style.bottom}`);
    const p2 = new T.Pokemon(25, appEl, 1, 0, 0);
    check('沒有地面時不動 bottom（維持 CSS 的 0）', p2.el.style.bottom === undefined);

    // 水域：流動動畫 + 踩得更深（inset 5 → 抬高 2px）
    const waterLift = T.initGround('water');
    const water = appEl.children[appEl.children.length - 1];
    check('水域掛上流動動畫 class', water.className === 'ground-flow');
    check('流動一輪位移 = 貼片顯示寬（無縫循環）',
        water.style.getPropertyValue('--flow-width') === '-512px',
        `實際 ${water.style.getPropertyValue('--flow-width')}`);
    check('水域踩得更深（inset 5 → 抬高 2px）', waterLift === 2, `實際 ${waterLift}`);
    check('岩地幾乎不下陷（inset 1 → 抬高 10px）', T.initGround('rock') === 10);
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
    check('flybySpeed 預設 5', CONFIG.flybySpeed === 5);

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
    check('速度 = flybySpeed ±15%', c.speed >= 5 * 0.85 && c.speed <= 5 * 1.15, `實際 ${c.speed}`);
    const x0 = c.x;
    check('行程中：update 回傳 true 且高速前進',
        c.update(1000 / 60) === true && Math.abs(c.x - x0) > 3,
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

// =========================================================
group('19. 色違星星特效定時重播');
{
    check('config 預設重播間隔 15~20 秒',
        CONFIG.shinyBurstDelay.min === 15000 && CONFIG.shinyBurstDelay.max === 20000);
    for (const [name, pathStr] of [
        ['shinyBurstDelayMin', '["shinyBurstDelay","min"]'],
        ['shinyBurstDelayMax', '["shinyBurstDelay","max"]'],
    ]) {
        const spec = T.QUERY_PARAMS?.[name];
        check(`${name} 已登記且路徑正確`, !!spec && JSON.stringify(spec.path) === pathStr);
    }

    const p = newPokemon(25, { shiny: true });
    p.img.dispatch('load'); // 本體現身 → 放第一輪
    const stars = () => p.el.children.filter(el => el.className === 'burst-star').length;
    const first = stars();
    check('登場先放一輪（10 顆星）', first === 10, `實際 ${first}`);
    advance(20001);
    check('15~20 秒後自動重播一輪', stars() >= first + 10, `實際 ${stars()} 顆`);
    advance(20001);
    check('之後持續重播、不會只放兩輪', stars() >= first + 20, `實際 ${stars()} 顆`);
}

// =========================================================
// 最後一組：客串生成是 async（等身高查詢），要 flush 微任務才能斷言，
// 所以包在 async IIFE 裡，總結與離場也一併搬進來
(async () => {
    group('20. 背景分頁防護（rAF 停了就別生東西）');

    const starsOf = p => p.el.children.filter(el => el.className === 'burst-star').length;

    // 開頁時就在背景：登場那輪跳過，但排程有排，切回可見補得到
    sandbox.document.hidden = true;
    const bg = newPokemon(25, { shiny: true });
    bg.img.dispatch('load');
    check('隱藏中登場 → 該輪星星跳過', starsOf(bg) === 0, `實際 ${starsOf(bg)}`);
    sandbox.document.hidden = false;
    advance(20001);
    check('切回可見 → 下一輪重播照放', starsOf(bg) === 10, `實際 ${starsOf(bg)}`);

    // 可見登場 → 隱藏期間重播跳過 → 排程不斷鏈，恢復可見就繼續
    const p = newPokemon(25, { shiny: true });
    p.img.dispatch('load');
    check('可見登場先放一輪', starsOf(p) === 10);
    sandbox.document.hidden = true;
    advance(20001);
    check('隱藏期間：重播跳過', starsOf(p) === 10, `實際 ${starsOf(p)}`);
    advance(20001);
    check('連續跳過也不會斷鏈', starsOf(p) === 10);
    sandbox.document.hidden = false;
    advance(20001);
    check('恢復可見：重播繼續', starsOf(p) === 20, `實際 ${starsOf(p)}`);

    // 客串排程：隱藏時擲骰作廢（rAF 停著，生出來只會凍在半空累積），
    // 排程照鏈，恢復可見後照常生成。皮卡丘在 stub 身高表裡，不會打網路
    sandbox.window.POKE_FLYING = [25];
    CONFIG.flybyChance = 1; // 每次擲骰必中，測的是可見度那一關
    T.scheduleFlyby();
    sandbox.document.hidden = true;
    advance(60000); // 至少擲了 3 次骰
    await new Promise(r => setImmediate(r));
    check('隱藏期間：必中的骰也不生客串', T.cameos.length === 0, `實際 ${T.cameos.length} 隻`);
    sandbox.document.hidden = false;
    advance(20001); // 下一個擲骰時點必到
    await new Promise(r => setImmediate(r));
    check('恢復可見：客串照常生成', T.cameos.length > 0, `實際 ${T.cameos.length} 隻`);
    // 排程鏈停不下來（scheduleFlyby 永遠自我續約），機率直接歸零讓之後的
    // advance 都空轉——信使鳥空投不需要名單池，光刪 POKE_FLYING 擋不住
    // 預設 flybyDeliveryChance 的擲骰，客串會隨機亂入後面的測試
    CONFIG.flybyChance = 0;
    delete sandbox.window.POKE_FLYING;

    // =====================================================
    group('21. postMessage 遙控');

    // 參數登記 + config 預設
    check('remote 已登記（enum on/off）',
        T.QUERY_PARAMS?.remote?.type === 'enum'
        && JSON.stringify(T.QUERY_PARAMS.remote.values) === '["on","off"]');
    check('remoteRateLimit 已登記（int，下限 ≥ 1）',
        T.QUERY_PARAMS?.remoteRateLimit?.type === 'int' && T.QUERY_PARAMS.remoteRateLimit.min >= 1);
    check("config.js 預設 remote = 'on'", CONFIG.remote === 'on');
    check('config.js 預設 remoteRateLimit = 10', CONFIG.remoteRateLimit === 10);

    // 監聽器真的掛在 window 上（不是只寫了函式沒註冊）
    const handlers = sandbox.window.listeners.message ?? [];
    check('message 監聽器已註冊', handlers.length === 1, `實際 ${handlers.length} 個`);

    // 從監聽器餵假事件；回執記到 replies
    const replies = [];
    const send = data => handlers.forEach(fn => fn({
        data, origin: 'https://example.com',
        source: { postMessage: m => replies.push(m) },
    }));
    const lastReply = () => replies[replies.length - 1];

    // 固定陣容：清掉 init() 生的隨機成員，換成一隻皮卡丘 + 一隻色違卡比獸
    T.pokemons.length = 0;
    const pika = newPokemon(25, { scale: 0.6 });
    const snor = newPokemon(143, { shiny: true });
    T.pokemons.push(pika, snor);
    T.remoteStamps.length = 0; // 前面測試沒發過指令，保險歸零

    // 不是寄給我們的信：沒有 ns 就完全無視（連回執都沒有）
    send({ cmd: 'poke' });
    check('沒帶 ns → 無視、不回執', replies.length === 0 && pika.jumpV === 0);
    send('!pokemon 25');
    check('非物件訊息 → 無視不炸', replies.length === 0);

    // 未知指令：回執 ok:false
    send({ ns: 'poke-stroll', cmd: 'dance' });
    check('未知指令 → 回執 ok:false', lastReply()?.ok === false && lastReply()?.re === 'dance');

    // poke：全員開心跳
    send({ ns: 'poke-stroll', cmd: 'poke' });
    check('poke → 全員起跳', pika.jumpV > 0 && snor.jumpV > 0);
    check('poke 回執 count = 2', lastReply()?.ok === true && lastReply()?.count === 2);

    // poke 指定 id：只戳那一隻
    pika.jumpV = 0; snor.jumpV = 0; pika.jumpY = 0; snor.jumpY = 0;
    send({ ns: 'poke-stroll', cmd: 'poke', id: 25 });
    check('poke id=25 → 只有皮卡丘跳', pika.jumpV > 0 && snor.jumpV === 0);
    check('poke id 回執 count = 1', lastReply()?.count === 1);

    // burst：色違立刻重播，且重播鏈維持單一條
    snor.img.dispatch('load'); // 登場先放一輪（同時排下一輪重播）
    const snorStars = () => snor.el.children.filter(el => el.className === 'burst-star').length;
    check('（前置）登場一輪 10 顆', snorStars() === 10);
    send({ ns: 'poke-stroll', cmd: 'burst' });
    check('burst → 色違立刻再放一輪', snorStars() === 20, `實際 ${snorStars()}`);
    check('burst 回執 count = 1（只算色違）', lastReply()?.ok === true && lastReply()?.count === 1);
    advance(20001);
    check('重播鏈不因手動 burst 疊加（+10 而非 +20）', snorStars() === 30, `實際 ${snorStars()}`);

    // spawn 指定 id：生一隻客串（async，flush 微任務再驗收）
    const cameosBefore = T.cameos.length;
    send({ ns: 'poke-stroll', cmd: 'spawn', id: 25 });
    check('spawn id=25 → 回執 ok', lastReply()?.ok === true);
    await new Promise(r => setImmediate(r));
    check('spawn id=25 → 客串 +1', T.cameos.length === cameosBefore + 1, `實際 ${T.cameos.length}`);

    // spawn 的參數驗證與環境防護
    send({ ns: 'poke-stroll', cmd: 'spawn', id: 'abc' });
    check('spawn id 非數字 → ok:false', lastReply()?.ok === false);
    send({ ns: 'poke-stroll', cmd: 'spawn', id: 9999 });
    check('spawn id 超範圍 → ok:false', lastReply()?.ok === false);
    send({ ns: 'poke-stroll', cmd: 'spawn' }); // 主 sandbox 沒載名單檔
    check('spawn 不帶 id 且名單未載入 → ok:false', lastReply()?.ok === false
        && lastReply()?.reason === 'cameo pools not loaded');
    sandbox.document.hidden = true;
    send({ ns: 'poke-stroll', cmd: 'spawn', id: 25 });
    check('背景分頁 → spawn 拒收（跟排程器同一套防護）',
        lastReply()?.ok === false && lastReply()?.reason === 'page hidden');
    sandbox.document.hidden = false;

    // join：加一隻常駐（async，flush 微任務再驗收）
    T.remoteStamps.length = 0;
    send({ ns: 'poke-stroll', cmd: 'join', id: 7 });
    check('join id=7 → 回執 ok 且帶 id', lastReply()?.ok === true && lastReply()?.id === 7);
    await new Promise(r => setImmediate(r));
    check('join id=7 → 常駐 +1', T.pokemons.length === 3, `實際 ${T.pokemons.length}`);
    const joined = T.pokemons[2];
    check('join 生的是常駐 Pokemon（會散步，不是客串）',
        joined instanceof T.Pokemon && joined.id === 7);
    send({ ns: 'poke-stroll', cmd: 'join', id: 'abc' });
    check('join id 非數字 → ok:false', lastReply()?.ok === false);
    send({ ns: 'poke-stroll', cmd: 'join' });
    check('join 不帶 id → 隨機抽（minId ~ maxId 內）', lastReply()?.ok === true
        && lastReply()?.id >= CONFIG.minId && lastReply()?.id <= CONFIG.maxId);
    await new Promise(r => setImmediate(r));
    T.pokemons.length = 3; // 隨機加入的那隻退場，固定陣容（pika + snor + joined）繼續測
    while (T.pokemons.length < T.QUERY_PARAMS.count.max) T.pokemons.push(pika); // 灌滿隊伍
    send({ ns: 'poke-stroll', cmd: 'join' });
    check('隊伍滿了 → party is full',
        lastReply()?.ok === false && lastReply()?.reason === 'party is full');
    T.pokemons.length = 3;

    // feed：天降果實，「一隻只追一顆」的配對制就是上限
    T.remoteStamps.length = 0;
    check('（前置）三隻都有空', T.pokemons.every(p => !p.isFeeding()));
    send({ ns: 'poke-stroll', cmd: 'feed', count: 99 });
    check('feed count=99 → 夾到有空的成員數 3',
        lastReply()?.ok === true && lastReply()?.count === 3);
    check('場上 3 顆果實、三隻全在忙',
        T.getBerries().length === 3 && T.pokemons.every(p => p.isFeeding()));
    check('果實從畫面上半段落下', T.getBerries().every(b => b.bottom >= 100 && b.bottom <= 180));
    send({ ns: 'poke-stroll', cmd: 'feed' });
    check('大家都在忙 → everyone is busy',
        lastReply()?.ok === false && lastReply()?.reason === 'everyone is busy');
    CONFIG.berry = 'off';
    send({ ns: 'poke-stroll', cmd: 'feed' });
    check("feed 於 berry='off' → berry is off", lastReply()?.reason === 'berry is off');
    CONFIG.berry = 'on';
    sandbox.document.hidden = true;
    send({ ns: 'poke-stroll', cmd: 'feed' });
    check('背景分頁 → feed 拒收', lastReply()?.reason === 'page hidden');
    sandbox.document.hidden = false;
    send({ ns: 'poke-stroll', cmd: 'feed', count: 0 });
    check('feed count=0 → count must be >= 1',
        lastReply()?.ok === false && lastReply()?.reason === 'count must be >= 1');

    // leave：送走成員，正在追的果實一併收走
    T.remoteStamps.length = 0;
    send({ ns: 'poke-stroll', cmd: 'leave', id: 7 });
    check('leave id=7 → 回執帶 id、常駐 -1',
        lastReply()?.ok === true && lastReply()?.id === 7 && T.pokemons.length === 2);
    check('走的那隻追的果實一併收走（3 → 2 顆）', T.getBerries().length === 2);
    send({ ns: 'poke-stroll', cmd: 'leave', id: 999 });
    check('leave id 不在場上 → id not found',
        lastReply()?.ok === false && lastReply()?.reason === 'id not found');
    send({ ns: 'poke-stroll', cmd: 'leave' });
    check('leave 不帶 id → 隨機送走一隻（2 → 1）',
        lastReply()?.ok === true && T.pokemons.length === 1);
    send({ ns: 'poke-stroll', cmd: 'leave' });
    check('最後一隻不送 → last one standing',
        lastReply()?.ok === false && lastReply()?.reason === 'last one standing');

    // 陣容與場面復原：清光果實、回到固定的 pika + snor，給後面的節流測試用
    T.getBerries().slice().forEach(b => T.removeBerry(b));
    pika.state = 'WALKING'; pika.targetBerry = null;
    snor.state = 'WALKING'; snor.targetBerry = null;
    T.pokemons.length = 0;
    T.pokemons.push(pika, snor);

    // 節流：滑動窗超額整道丟棄
    T.remoteStamps.length = 0;
    const savedLimit = CONFIG.remoteRateLimit;
    CONFIG.remoteRateLimit = 3;
    const okBefore = replies.filter(r => r.ok).length;
    for (let i = 0; i < 5; i++) send({ ns: 'poke-stroll', cmd: 'poke', id: 25 });
    const okAfter = replies.filter(r => r.ok).length;
    check('限速 3/秒 → 5 連發只放行 3 道', okAfter - okBefore === 3, `放行 ${okAfter - okBefore}`);
    check('超額的回執 rate limited', lastReply()?.reason === 'rate limited');
    CONFIG.remoteRateLimit = savedLimit;

    // 總開關：off = 靜默，連回執都不給
    T.remoteStamps.length = 0;
    CONFIG.remote = 'off';
    const repliesBefore = replies.length;
    pika.jumpV = 0;
    send({ ns: 'poke-stroll', cmd: 'poke' });
    check("remote='off' → 靜默無視（不動作、不回執）",
        replies.length === repliesBefore && pika.jumpV === 0);
    CONFIG.remote = 'on';

    // =====================================================
    group('22. 丟果實餵食');

    // 發呆是每幀擲骰的隨機行為：收尾回到 WALKING 後若多跑幾幀，
    // 有機率隨機進入 IDLE 害斷言翻車（CI 就骰到過）。整組關掉，結束再還原
    const savedIdleChance = CONFIG.idleChance;
    CONFIG.idleChance = 0;

    // 參數登記 + config 預設 + 果實圖
    check('berry 已登記（enum on/off）',
        T.QUERY_PARAMS?.berry?.type === 'enum'
        && JSON.stringify(T.QUERY_PARAMS.berry.values) === '["on","off"]');
    check("config.js 預設 berry = 'on'", CONFIG.berry === 'on');
    check('果實點陣圖每列同寬', new Set(T.BERRY_ART.map(r => r.length)).size === 1);
    check('果實點陣圖只用調色盤上的字',
        [...T.BERRY_ART.join('')].every(ch => ch === '.' || T.BERRY_PALETTE[ch]));

    // document 上掛了 click 監聽器；空白處點擊 = 丟果實
    const clickHandlers = sandbox.document.listeners.click ?? [];
    check('document 上掛了 click 監聽器', clickHandlers.length === 1, `實際 ${clickHandlers.length}`);
    const clickAt = (x, y) => clickHandlers.forEach(fn => fn({ clientX: x, clientY: y }));

    // 沒有寶可夢：點了也不掉（果實沒人吃）
    T.pokemons.length = 0;
    clickAt(500, 100);
    check('場上沒人 → 不掉果實', T.getBerries().length === 0 && !T.feedingBusy());

    // 陣容：一近一遠
    const near = newPokemon(25, { scale: 0.6 });
    const far = newPokemon(143, { scale: 1 });
    near.x = 900; far.x = 200;
    T.pokemons.push(near, far);

    // 總開關 off：點了無事發生
    CONFIG.berry = 'off';
    clickAt(1000, 60);
    check("berry='off' → 點空白處無事發生", T.getBerries().length === 0 && !T.feedingBusy());
    CONFIG.berry = 'on';

    // 丟第一顆：從點擊高度生成、指派最近的那隻、冒發現的驚嘆號
    clickAt(1000, 60); // bottom = 200 - 60 = 140
    const b1 = T.getBerries()[0];
    check('果實生成（class = berry）', b1?.el.className === 'berry');
    check('生成高度 = 點擊高度', Math.abs(b1.bottom - 140) < 1, `實際 ${b1?.bottom}`);
    check('餵食進行中', T.feedingBusy() === true);
    check('指派「最近」的那隻（900 vs 200）', b1.feeder === near);
    check('被指派者進入 SEEK_BERRY', near.state === 'SEEK_BERRY');
    check('發現果實 → 冒驚嘆號', near.bubbleName === 'exclaim'
        && near.bubble.style.display === 'block');

    // 第二顆：near 忙碌中不會發現（即使距離比較近），改指派有空的 far
    clickAt(950, 80); // 離 near(900) 比 far(200) 近
    check('第二顆可以丟（一人一顆）', T.getBerries().length === 2);
    const b2 = T.getBerries()[1];
    check('忙碌中的不會發現 → 指派給有空的那隻', b2.feeder === far && far.state === 'SEEK_BERRY');

    // 上限 = 常駐數量：兩隻都在忙，第三顆丟不出去
    clickAt(400, 100);
    check('大家都在忙 → 第三顆丟不出去', T.getBerries().length === 2);

    // 掉落物理：兩顆各自獨立墜地、落點 = 地面
    for (let i = 0; i < 400 && (b1.state !== 'LANDED' || b2.state !== 'LANDED'); i++) T.updateBerries(16);
    check('兩顆果實各自落地（bottom = 0）',
        b1.state === 'LANDED' && b1.bottom === 0 && b2.state === 'LANDED' && b2.bottom === 0);

    // 奔向自己的果實：面向正確、確實在移動
    const seekX0 = near.x;
    near.update(16, T.pokemons);
    check('朝果實方向小跑（面向右、往右移）', near.direction === 1 && near.x > seekX0);
    for (let i = 0; i < 2000 && near.state === 'SEEK_BERRY'; i++) near.update(16, T.pokemons);
    check('抵達果實旁 → 開吃', near.state === 'EATING', `實際 ${near.state}`);
    check('嘴邊誤差 ≤ 6px', Math.abs(b1.x - near.centerX()) <= 6);

    // 三口吃掉 → 開心跳 + 愛心 → FEED_HEART 收尾（只吃自己那顆）
    let shrunk = false;
    for (let i = 0; i < 100 && near.state === 'EATING'; i++) {
        near.update(16, T.pokemons);
        if (b1.el.style.transform.includes('scale(0.72)')) shrunk = true;
    }
    check('吃到一半果實有變小（咬痕）', shrunk);
    check('吃完自己那顆消失、別隻的還在',
        !T.getBerries().includes(b1) && T.getBerries().includes(b2));
    check('吃完開心跳 + 冒愛心', near.jumpV > 0 && near.bubbleName === 'heart');
    check('愛心期間仍算忙碌', near.state === 'FEED_HEART' && near.isFeeding());

    // 愛心中不接新果實：far 也還在半路 → 沒人有空，丟不出去
    clickAt(890, 100);
    check('愛心中也不接新果實 → 丟不出去', T.getBerries().length === 1);

    // 愛心演完 → 回到散步，又能發現新果實
    for (let i = 0; i < 110; i++) near.update(16, T.pokemons);
    check('愛心演完 → 回到 WALKING', near.state === 'WALKING' && !near.isFeeding());
    clickAt(890, 100);
    check('忙完 → 又能發現新果實', T.getBerries().length === 2
        && T.getBerries()[1].feeder === near && near.state === 'SEEK_BERRY');

    // 全場收工：兩隻各自吃完自己的那顆 → 場上清空
    for (let i = 0; i < 3000 && (near.isFeeding() || far.isFeeding()); i++) {
        T.updateBerries(16);
        near.update(16, T.pokemons);
        far.update(16, T.pokemons);
    }
    check('全部吃完 → 場上清空、解鎖', T.getBerries().length === 0 && !T.feedingBusy());

    // 發呆中被指派：立刻放下手邊的事；活動範圍外的點擊，果實釘到搆得到的位置
    near.x = 900; far.x = 200;
    far.state = 'IDLE';
    far.idleTimer = 99999;
    far.showEmote('note');
    clickAt(1, 100); // 最左邊：離 far(200) 比 near 近，且在 bounds 左界外
    const b3 = T.getBerries()[0];
    check('發呆中也被指派 → 立刻 SEEK_BERRY', b3.feeder === far && far.state === 'SEEK_BERRY');
    check('進行中的心情對話框換成發現的驚嘆號', far.bubbleName === 'exclaim');
    const minReach = 1920 * CONFIG.bounds.min + far.img.offsetWidth / 2;
    check('範圍外的點擊 → 果實釘在搆得到的最近位置',
        b3.x === minReach, `實際 ${b3.x}，期望 ${minReach}`);
    CONFIG.idleChance = savedIdleChance;

    // =====================================================
    group('23. 偶遇打招呼');
    {
        const savedIdle = CONFIG.idleChance;
        const savedGreet = CONFIG.greetChance;
        CONFIG.idleChance = 0;

        check('config 預設 greetChance = 0.1', CONFIG.greetChance === 0.1);
        check('greetChance 已登記（float 0 ~ 1）',
            T.QUERY_PARAMS?.greetChance?.type === 'float'
            && T.QUERY_PARAMS.greetChance.min === 0 && T.QUERY_PARAMS.greetChance.max === 1);

        // 場面：兩隻面對面走近（前一組留下的果實與陣容先清乾淨）
        T.getBerries().slice().forEach(x => T.removeBerry(x));
        T.pokemons.length = 0;
        const ga = newPokemon(25, { scale: 0.6 });
        const gb = newPokemon(143);
        ga.x = 500; ga.direction = 1;
        gb.x = 500 + CONFIG.personalSpace - 10; gb.direction = -1;
        T.pokemons.push(ga, gb);

        CONFIG.greetChance = 0; // 0 = 關閉：照舊掉頭
        ga.update(16, T.pokemons);
        check('greetChance=0 → 照舊掉頭不寒暄', ga.state === 'WALKING' && ga.direction === -1);
        ga.direction = 1; ga.avoidCooldown = 0;

        CONFIG.greetChance = 1; // 必定寒暄
        ga.update(16, T.pokemons);
        check('相遇 → 兩隻都進入 GREETING（先讓位，還不開聊）',
            ga.state === 'GREETING' && gb.state === 'GREETING'
            && ga.greetPhase === 'SPACING' && gb.greetPhase === 'SPACING');
        check('讓位階段還沒有對話框', ga.bubble.style.display === 'none'
            && gb.bubble.style.display === 'none');
        // 站位幾何：stub 的 img 寬固定 120，中心 = 目標 x + 60
        const gaC = ga.greetTargetX + 60, gbC = gb.greetTargetX + 60;
        check('站位中心距 = 半身寬相加 + 空隙（120 + 16）',
            gbC - gaC === 136, `實際 ${gbC - gaC}`);
        check('站位以兩隻中點為基準往外讓開',
            Math.abs((gaC + gbC) / 2 - (ga.centerX() + gb.centerX()) / 2) < 2,
            `目標中點 ${(gaC + gbC) / 2}，當下中點 ${(ga.centerX() + gb.centerX()) / 2}`);
        check('互相記住對方', ga.greetPartner === gb && gb.greetPartner === ga);
        check('寒暄中不算餵食忙碌（果實叫得動牠）', !ga.isFeeding() && !gb.isFeeding());

        // 走到站位 → 面對面 → 同一刻開聊
        for (let i = 0; i < 400 && ga.greetPhase !== 'CHAT'; i++) {
            ga.update(16, T.pokemons);
            gb.update(16, T.pokemons);
        }
        check('雙方就位後才開聊', ga.greetPhase === 'CHAT' && gb.greetPhase === 'CHAT');
        check('站上讓開的位置（身體不重疊、留有空隙）',
            ga.x === ga.greetTargetX && gb.x === gb.greetTargetX
            && gb.x - (ga.x + 120) === 16, `間隙 ${gb.x - (ga.x + 120)}`);
        check('面對面（ga 朝右、gb 朝左）', ga.direction === 1 && gb.direction === -1);
        check('開聊才冒出音符或愛心', ['note', 'heart'].includes(ga.bubbleName)
            && ga.bubble.style.display === 'block'
            && ['note', 'heart'].includes(gb.bubbleName)
            && gb.bubble.style.display === 'block');
        check('聊天時長 1600 ~ 2600ms 且兩隻同款時長', ga.greetDuration >= 1600
            && ga.greetDuration <= 2600 && ga.greetDuration === gb.greetDuration);

        // 聊完各自轉身走開 + 進冷卻
        for (let i = 0; i < 200 && ga.state === 'GREETING'; i++) {
            ga.update(16, T.pokemons);
            gb.update(16, T.pokemons);
        }
        check('聊完回到 WALKING', ga.state === 'WALKING' && gb.state === 'WALKING');
        check('各自轉身走開（ga 朝左、gb 朝右）', ga.direction === -1 && gb.direction === 1);
        check('對話框收起', ga.bubble.style.display === 'none' && gb.bubble.style.display === 'none');
        check('寒暄進入冷卻（8 ~ 15 秒）', ga.greetCooldown >= 7000 && gb.greetCooldown >= 7000);
        check('掉頭冷卻也有，不會下一幀又互相觸發', ga.avoidCooldown > 0 && gb.avoidCooldown > 0);

        // 冷卻期內再相遇 → 照舊掉頭
        ga.x = 500; ga.direction = 1; ga.avoidCooldown = 0;
        gb.x = 540; gb.direction = -1; gb.avoidCooldown = 0;
        ga.update(16, T.pokemons);
        check('冷卻期內 → 不寒暄、照舊掉頭', ga.state === 'WALKING' && ga.direction === -1);

        // 對方在忙（追果實中）→ 不寒暄
        ga.greetCooldown = 0; gb.greetCooldown = 0;
        ga.x = 500; ga.direction = 1; ga.avoidCooldown = 0;
        gb.state = 'SEEK_BERRY';
        ga.update(16, T.pokemons);
        check('對方在忙 → 不寒暄、照舊掉頭', ga.state === 'WALKING' && ga.direction === -1);
        gb.state = 'WALKING';

        // 寒暄中被果實叫走 → 自己去辦正事、對方也解脫
        ga.greetCooldown = 0; gb.greetCooldown = 0;
        ga.x = 500; ga.direction = 1; ga.avoidCooldown = 0;
        gb.x = 540; gb.direction = -1;
        ga.update(16, T.pokemons);
        check('（前置）再次寒暄', ga.state === 'GREETING' && gb.state === 'GREETING');
        clickAt(600, 100); // 離 gb(中心 600) 比 ga(中心 560) 近 → gb 被叫走
        check('寒暄中被果實叫走 → SEEK_BERRY + 驚嘆號',
            gb.state === 'SEEK_BERRY' && gb.bubbleName === 'exclaim');
        check('對方解脫回去散步，不對著空氣講話', ga.state === 'WALKING'
            && ga.greetPartner === null && ga.bubble.style.display === 'none');

        // 讓位的保險絲：站位永遠走不到（如視窗中途縮放）就整組放棄
        T.getBerries().slice().forEach(x => T.removeBerry(x));
        gb.targetBerry = null; gb.state = 'WALKING';
        ga.greetCooldown = 0; gb.greetCooldown = 0;
        ga.x = 500; ga.direction = 1; ga.avoidCooldown = 0;
        gb.x = 540; gb.direction = -1; gb.avoidCooldown = 0;
        ga.update(16, T.pokemons);
        check('（前置）寒暄成立', ga.state === 'GREETING' && gb.state === 'GREETING');
        ga.greetTargetX = -99999; // 模擬站位中途變得走不到（邊界檢查會一直把牠釘回來）
        for (let i = 0; i < 300 && ga.state === 'GREETING'; i++) {
            ga.update(16, T.pokemons);
            gb.update(16, T.pokemons);
        }
        check('讓位卡住 → 4 秒保險絲放棄寒暄、兩隻都解脫',
            ga.state === 'WALKING' && gb.state === 'WALKING');

        // 收拾場面
        CONFIG.greetChance = savedGreet;
        CONFIG.idleChance = savedIdle;
    }

    // =====================================================
    group('24. 信使鳥空投');
    {
        const savedIdle = CONFIG.idleChance;
        const savedShinyD = CONFIG.shinyChance;
        const savedDelivery = CONFIG.flybyDeliveryChance;
        CONFIG.idleChance = 0;
        CONFIG.shinyChance = 0;

        check('config 預設 flybyDeliveryChance = 0.2', CONFIG.flybyDeliveryChance === 0.2);
        check('flybyDeliveryChance 已登記（float 0 ~ 1）',
            T.QUERY_PARAMS?.flybyDeliveryChance?.type === 'float'
            && T.QUERY_PARAMS.flybyDeliveryChance.min === 0
            && T.QUERY_PARAMS.flybyDeliveryChance.max === 1);

        // 場面：一隻有空的皮卡丘等著接收
        T.pokemons.length = 0;
        const eater = newPokemon(25, { scale: 0.6 });
        eater.x = 900;
        T.pokemons.push(eater);

        const c = new T.Cameo(225, 0.8, { delivery: true });
        check('信使鳥叼著果實出發（果實掛在腳下）', c.delivery === true
            && c.carried?.className === 'berry' && c.el.children.includes(c.carried));
        check('投放點在活動範圍內', c.dropX >= 1920 * CONFIG.bounds.min
            && c.dropX <= 1920 * CONFIG.bounds.max, `dropX=${c.dropX}`);

        // 飛越投放點 → 鬆爪，果實從飛行高度掉落、走一般的餵食流程
        c.x = c.direction === 1 ? c.dropX + 1 : c.dropX - 1;
        check('（前置）空投後行程照飛不停', c.update(16) === true);
        check('飛越投放點 → 鬆爪空投', c.carried === null && T.getBerries().length === 1);
        check('果實從飛行高度掉落（還在半空）', T.getBerries()[0].state === 'FALLING'
            && T.getBerries()[0].bottom > 0, `bottom=${T.getBerries()[0]?.bottom}`);
        check('有空的成員接收：SEEK_BERRY + 驚嘆號', eater.state === 'SEEK_BERRY'
            && eater.bubbleName === 'exclaim');
        c.update(16);
        check('只投這一次，不會再掉第二顆', T.getBerries().length === 1);

        // 大家都在忙 → 不空投，整顆叼走（只試一次，飛過了不回頭）
        T.getBerries().slice().forEach(x => T.removeBerry(x));
        eater.targetBerry = null;
        eater.state = 'EATING'; eater.eatTimer = 99999; // 在忙
        const c2 = new T.Cameo(225, 0.8, { delivery: true });
        c2.x = c2.direction === 1 ? c2.dropX + 1 : c2.dropX - 1;
        c2.update(16);
        check('大家都在忙 → 不空投、整顆叼走', c2.carried !== null && T.getBerries().length === 0);
        c2.update(16);
        check('之後也不再嘗試（投放點已清空）', c2.dropX === null && T.getBerries().length === 0);
        eater.state = 'WALKING';

        // 排程器整合：flybyDeliveryChance=1 → spawnFlyby 這趟就是空投
        CONFIG.flybyDeliveryChance = 1;
        const cameosN1 = T.cameos.length;
        T.spawnFlyby();
        await new Promise(r => setImmediate(r));
        check('flybyDeliveryChance=1 → 客串改派信使鳥空投', T.cameos.length === cameosN1 + 1
            && T.cameos[T.cameos.length - 1].delivery === true
            && T.cameos[T.cameos.length - 1].img.src.includes('/225.gif'));

        // berry='off' → 不派空投任務（主 sandbox 沒載名單檔，池也抽不了 → 什麼都不生）
        CONFIG.berry = 'off';
        const cameosN2 = T.cameos.length;
        T.spawnFlyby();
        await new Promise(r => setImmediate(r));
        check("berry='off' → 不派空投任務", T.cameos.length === cameosN2);
        CONFIG.berry = 'on';

        // 遙控 spawn delivery
        T.remoteStamps.length = 0;
        const cameosN3 = T.cameos.length;
        send({ ns: 'poke-stroll', cmd: 'spawn', delivery: true });
        check('spawn delivery → 回執 ok 且 id = 225',
            lastReply()?.ok === true && lastReply()?.id === 225);
        await new Promise(r => setImmediate(r));
        check('spawn delivery → 客串 +1 且是空投任務', T.cameos.length === cameosN3 + 1
            && T.cameos[T.cameos.length - 1].delivery === true);
        CONFIG.berry = 'off';
        send({ ns: 'poke-stroll', cmd: 'spawn', delivery: true });
        check("spawn delivery 於 berry='off' → berry is off",
            lastReply()?.ok === false && lastReply()?.reason === 'berry is off');
        CONFIG.berry = 'on';

        CONFIG.shinyChance = savedShinyD;
        CONFIG.flybyDeliveryChance = savedDelivery;
        CONFIG.idleChance = savedIdle;
    }

    // =====================================================
    group('25. roster 查詢');
    {
        T.remoteStamps.length = 0;
        T.pokemons.length = 0;
        const r1 = newPokemon(25, { scale: 0.6 });
        const r2 = newPokemon(143, { shiny: true });
        T.pokemons.push(r1, r2);

        send({ ns: 'poke-stroll', cmd: 'roster' });
        const rep = lastReply();
        check('roster → ok 且 count = 2', rep?.ok === true && rep?.re === 'roster' && rep?.count === 2);
        check('回報每隻的 id / 色違 / 體型', JSON.stringify(rep?.roster) === JSON.stringify([
            { id: 25, shiny: false, size: 0.6 },
            { id: 143, shiny: true, size: 1 },
        ]), JSON.stringify(rep?.roster));
        check('查詢不動畫面（沒人起跳、狀態不變）', r1.jumpV === 0 && r2.jumpV === 0
            && r1.state === 'WALKING' && r2.state === 'WALKING');

        // join 之後再查，陣容跟著變（roster 反映的是「當下」）
        send({ ns: 'poke-stroll', cmd: 'join', id: 7 });
        await new Promise(r => setImmediate(r));
        send({ ns: 'poke-stroll', cmd: 'roster' });
        check('join 後 roster 跟著更新', lastReply()?.count === 3
            && lastReply()?.roster[2]?.id === 7, JSON.stringify(lastReply()?.roster));
    }

    // =====================================================
    group('26. 滑鼠拖曳');
    {
        const savedIdle = CONFIG.idleChance;
        const savedGreetD = CONFIG.greetChance;
        const savedRate = CONFIG.dragStruggleRate;
        CONFIG.idleChance = 0;  // 發呆是每幀擲骰，會把「拖曳中狀態不變」的斷言弄翻
        CONFIG.greetChance = 0;

        // 參數登記 + config 預設
        check('drag 已登記（enum on/off）',
            T.QUERY_PARAMS?.drag?.type === 'enum'
            && JSON.stringify(T.QUERY_PARAMS.drag.values) === '["on","off"]');
        check('dragStruggleRate 已登記（float 0 ~ 10）',
            T.QUERY_PARAMS?.dragStruggleRate?.type === 'float'
            && T.QUERY_PARAMS.dragStruggleRate.min === 0 && T.QUERY_PARAMS.dragStruggleRate.max === 10);
        check("config.js 預設 drag = 'on' / 掙扎 2 倍速",
            CONFIG.drag === 'on' && CONFIG.dragStruggleRate === 2);
        check('沒有長按門檻參數（按下即抓，門檻是 0.30.0 的教訓）',
            T.QUERY_PARAMS?.dragHoldTime === undefined && CONFIG.dragHoldTime === undefined);

        // 拖曳的事件全掛在 document 上（游標移動快過重繪時會滑出本體）
        const doc = sandbox.document.listeners;
        check('document 上掛了 pointermove / pointerup / pointercancel 監聽器',
            doc.pointermove?.length === 1 && doc.pointerup?.length === 1
            && doc.pointercancel?.length === 1);

        // 假的滑鼠：clientY 是「由上往下」，widget 內部換算成 bottom 基準；
        // button 0 = 左鍵、2 = 右鍵
        const press = (p, x, y, button = 0) => {
            const ev = { clientX: x, clientY: y, pointerId: 1, button };
            p.el.listeners.pointerdown.forEach(fn => fn(ev));
            (doc.pointerdown || []).forEach(fn => fn(ev));
        };
        const move = (x, y) => (doc.pointermove || []).forEach(fn => fn({ clientX: x, clientY: y }));
        const up = () => (doc.pointerup || []).forEach(fn => fn());
        const rightClickOn = p => {
            let prevented = false;
            p.el.listeners.contextmenu.forEach(fn => fn({ preventDefault() { prevented = true; } }));
            return prevented;
        };

        T.pokemons.length = 0;
        const d = newPokemon(25, { scale: 1 });
        d.x = 500; d.bobY = 0; d.jumpY = 0; d.jumpV = 0;
        T.pokemons.push(d);
        check('本體掛了 pointerdown / contextmenu、sprite 擋掉原生拖放',
            d.el.listeners.pointerdown?.length === 1 && d.img.listeners.dragstart?.length === 1
            && d.el.listeners.contextmenu?.length === 1);

        // 右鍵 = 戳戳互動（順便擋掉系統選單），不會抓起來
        d.jumpV = 0;
        const prevented = rightClickOn(d);
        check('右鍵輕點 → 跳一下 + 冒愛心，且擋掉系統選單',
            prevented && d.jumpV > 0 && d.bubbleName === 'heart' && d.state === 'WALKING');
        press(d, 560, 150, 2);
        check('右鍵按住也不會抓起來', d.state === 'WALKING');
        up();

        // 左鍵按下去的「那一幀」就抓起來——沒有長按門檻
        d.x = 500; d.jumpV = 0; d.jumpY = 0; d.bobY = 0;
        press(d, 560, 150); // 按在身體右側 60px 處，離地 50px
        check('左鍵按下 → 立刻抓起來（不必等、不必先移動）',
            d.state === 'HELD' && d.el.className === 'pokemon-container held');
        check('抓起來的那一刻不跳位', d.x === 500 && d.holdY === 0);
        check('抓起來會收掉進行中的對話框', d.bubble.style.display === 'none');
        check('抓起來時掙扎相位歸零（輕點一下不會閃一格歪頭）',
            d.walkPhase === 0 && d.struggleAngle === 0);

        // 跟著游標走：面向被拉的方向，垂直也跟著抬起來
        move(660, 150);
        check('游標往右移 → 跟著走、面向右', d.x === 600 && d.direction === 1);
        move(560, 150);
        check('游標往左移 → 跟著走、面向左', d.x === 500 && d.direction === -1);
        move(560, 100);
        check('游標抬高 → 跟著離地', d.holdY === 50, `holdY=${d.holdY}`);
        move(560, 0);
        check('抬到畫面外 → 高度夾在「整隻還看得見」（200 - 128 = 72）',
            d.holdY === 72, `holdY=${d.holdY}`);

        // 掙扎：高頻擺盪，rate 就是倍速
        d.walkPhase = 0;
        d.update(16, T.pokemons);
        const phase1 = d.walkPhase;
        check('掙扎中：相位前進、身體傾斜（0 < |角度| ≤ 10 度）',
            phase1 > 0 && d.struggleAngle !== 0 && Math.abs(d.struggleAngle) <= 10,
            `phase=${phase1} angle=${d.struggleAngle}`);
        check('離地高度與傾角都畫進 transform',
            d.img.style.transform.includes('translateY(-') && d.img.style.transform.includes('rotate('),
            d.img.style.transform);
        check('抓在手上的疊到最前面（z-index 15000）', d.el.style.zIndex === 15000);
        CONFIG.dragStruggleRate = 1;
        d.walkPhase = 0;
        d.update(16, T.pokemons);
        check('dragStruggleRate = 2 剛好是 1 的兩倍速',
            Math.abs(phase1 - d.walkPhase * 2) < 1e-9, `2x=${phase1} 1x=${d.walkPhase}`);
        CONFIG.dragStruggleRate = 0;
        d.walkPhase = 0;
        d.update(16, T.pokemons);
        check('dragStruggleRate = 0 → 抓著但不掙扎',
            d.walkPhase === 0 && d.struggleAngle === 0 && d.bobY === 0);
        CONFIG.dragStruggleRate = 2;

        // 邊界：游標拉出活動範圍，貼著界線繼續掙扎（不掉落、也不翻面）
        move(1900, 150);
        d.direction = 1;
        d.update(16, T.pokemons);
        check('游標拉出右邊界 → 貼著界線（1920 × 0.9 - 120 = 1608）',
            d.x === 1608, `x=${d.x}`);
        check('貼邊界時不掉落、也不翻面', d.state === 'HELD' && d.direction === 1);
        move(0, 150);
        d.update(16, T.pokemons);
        check('游標拉出左邊界 → 貼著界線（1920 × 0.1 = 192）', d.x === 192, `x=${d.x}`);

        // 抓在手上的等於暫時離場：不散步、戳不動、不寒暄
        move(560, 100);
        const heldX = d.x;
        for (let i = 0; i < 30; i++) d.update(16, T.pokemons);
        check('抓著時不會自己散步（X 只由游標決定）', d.x === heldX && d.state === 'HELD');
        d.jumpV = 0;
        d.bubbleName = null;
        rightClickOn(d); // 行動裝置長按也會送 contextmenu，這裡一併驗
        check('抓著時右鍵也戳不動（不跳、不冒對話框）',
            d.jumpV === 0 && d.bubble.style.display === 'none');
        check('抓著時沒空寒暄', d.canGreet() === false);

        // 同伴不會把「抓在半空的那隻」當路障
        const walker = newPokemon(143, { scale: 1 });
        walker.x = d.x - 20; walker.direction = 1; walker.avoidCooldown = 0;
        T.pokemons.push(walker);
        walker.update(16, T.pokemons);
        check('同伴不會被半空中的那隻逼掉頭', walker.direction === 1);
        T.pokemons.splice(T.pokemons.indexOf(walker), 1);

        // 果實：抓著的那隻不算「有空」——三個入口一致（點擊 / 遙控 feed / 空投）
        check('抓著的那隻不接果實（canTakeBerry = false）', d.canTakeBerry() === false);
        check('場上只剩牠 → 點空白處丟不出果實',
            T.throwBerry(500, 100) === false && T.getBerries().length === 0);
        T.remoteStamps.length = 0;
        send({ ns: 'poke-stroll', cmd: 'feed', count: 1 });
        check("遙控 feed → 'everyone is busy'",
            lastReply()?.ok === false && lastReply()?.reason === 'everyone is busy');
        send({ ns: 'poke-stroll', cmd: 'poke' });
        check('遙控 poke 跳過抓在手上的（count = 0）', lastReply()?.count === 0);
        const cd = new T.Cameo(225, 0.8, { delivery: true });
        cd.x = cd.direction === 1 ? cd.dropX + 1 : cd.dropX - 1;
        cd.update(16);
        check('信使鳥飛過投放點 → 沒人有空，整顆叼走',
            cd.carried !== null && T.getBerries().length === 0);
        cd.el.remove();

        // 放手：從當下高度自由落體回地面，落地後恢復散步
        const dropFrom = d.holdY;
        up();
        check('放手 → 回到散步、把高度交還給重力',
            d.state === 'WALKING' && d.jumpY === dropFrom && d.holdY === 0
            && d.el.className === 'pokemon-container');
        for (let i = 0; i < 200 && d.jumpY > 0; i++) d.update(16, T.pokemons);
        check('落地（jumpY 歸零、傾角收乾淨）', d.jumpY === 0 && d.struggleAngle === 0);
        // 放手處若在空白區，那一發 click 會直接冒到 document 的「丟果實」——
        // 拖曳的結尾不該掉果實，下一次真的點擊才算
        const docClick = (x, y) =>
            (doc.click || []).forEach(fn => fn({ clientX: x, clientY: y }));
        docClick(500, 100);
        const swallowed = T.getBerries().length === 0;
        docClick(500, 100);
        check('放手那一發 click 不掉果實，下一次點擊才算',
            swallowed && T.getBerries().length === 1);
        T.getBerries().slice().forEach(x => T.removeBerry(x));
        d.targetBerry = null;
        check('點本體的左鍵 click 不會冒泡去丟果實', (() => {
            let bubbled = true;
            d.el.listeners.click.forEach(fn => fn({ stopPropagation() { bubbled = false; } }));
            return bubbled === false;
        })());

        // 追果實追到一半被抓走：果實留在原地、主權保留，放手落地就回去續追
        // （snatchChance 先歸零：這裡只驗續追，賊鳥趁虛而入的戲在 27 組）
        const savedSnatchDrag = CONFIG.snatchChance;
        CONFIG.snatchChance = 0;
        d.state = 'WALKING'; d.x = 500; d.bobY = 0; d.jumpY = 0; d.jumpV = 0;
        check('（前置）果實丟得出去', T.throwBerry(500, 100) === true
            && d.state === 'SEEK_BERRY' && T.getBerries().length === 1);
        const kept = T.getBerries()[0];
        press(d, 560, 150);
        check('追果實中被抓走 → 果實留在原地、主權不放',
            d.state === 'HELD' && d.targetBerry === kept
            && T.getBerries().length === 1 && kept.feeder === d);
        move(660, 150);
        check('拖著走的期間果實也還在', T.getBerries().length === 1);
        up();
        check('放手 → 直接回去續追（不再冒驚嘆號，牠可沒忘記）',
            d.state === 'SEEK_BERRY' && d.targetBerry === kept
            && d.bubble.style.display === 'none');
        let seekGuard = 0;
        while (d.state === 'SEEK_BERRY' && seekGuard++ < 600) {
            T.updateBerries(16);
            d.update(16, T.pokemons);
        }
        check('續追到口邊照常開吃', d.state === 'EATING', `guard=${seekGuard}`);
        T.getBerries().slice().forEach(x => T.removeBerry(x));
        d.targetBerry = null; d.state = 'WALKING';
        CONFIG.snatchChance = savedSnatchDrag;

        // 寒暄中被抓走：對方也放自由，不會對著空氣講完
        const ga2 = newPokemon(25, { scale: 0.6 });
        const gb2 = newPokemon(25, { scale: 0.6 });
        ga2.x = 500; gb2.x = 640;
        ga2.startGreet(gb2, 1, 2000, 500);
        gb2.startGreet(ga2, -1, 2000, 640);
        press(ga2, 500, 150);
        check('寒暄中被抓走 → 對方也解脫',
            ga2.state === 'HELD' && gb2.state === 'WALKING' && gb2.greetPartner === null);
        up();

        // 遙控 leave 把抓著的那隻送走：先鬆手，游標別再拖著除名的元素
        T.pokemons.length = 0;
        const victim = newPokemon(25, { scale: 0.6 });
        victim.x = 500;
        T.pokemons.push(victim, newPokemon(143, { scale: 1 }));
        press(victim, 500, 150);
        check('（前置）抓在手上', victim.state === 'HELD');
        T.remoteStamps.length = 0;
        send({ ns: 'poke-stroll', cmd: 'leave', id: 25 });
        check('遙控 leave 送走抓著的那隻 → 自動鬆手',
            lastReply()?.ok === true && victim.state === 'WALKING');
        const goneX = victim.x;
        move(900, 150);
        check('鬆手後游標不再拖著牠', victim.x === goneX);
        up();

        // 總開關：drag='off' 只保留點一下的戳戳互動
        CONFIG.drag = 'off';
        T.pokemons.length = 0;
        const off = newPokemon(25, { scale: 0.6 });
        off.x = 500; off.jumpV = 0;
        T.pokemons.push(off);
        press(off, 500, 150);
        check("drag='off' → 左鍵按住也抓不起來", off.state === 'WALKING');
        up();
        rightClickOn(off);
        check("drag='off' → 右鍵照樣戳得動", off.jumpV > 0 && off.bubbleName === 'heart');
        CONFIG.drag = 'on';

        CONFIG.dragStruggleRate = savedRate;
        CONFIG.greetChance = savedGreetD;
        CONFIG.idleChance = savedIdle;
    }

    // =====================================================
    group('27. 空中搶食');
    {
        const savedIdle = CONFIG.idleChance;
        const savedGreetS = CONFIG.greetChance;
        const savedSnatch = CONFIG.snatchChance;
        const savedSnatchD = CONFIG.snatchDistance;
        const savedShinyS = CONFIG.shinyChance;
        const savedRates = [CONFIG.snatchDiveRate, CONFIG.snatchFleeRate,
            CONFIG.snatchShrinkRate, CONFIG.snatchFadeRate];
        CONFIG.idleChance = 0;   // 隨機發呆/寒暄會把狀態斷言弄翻，整組關掉
        CONFIG.greetChance = 0;
        CONFIG.shinyChance = 0;

        // 參數登記 + config 預設
        check('snatchChance 已登記（float 0 ~ 1）',
            T.QUERY_PARAMS?.snatchChance?.type === 'float'
            && T.QUERY_PARAMS.snatchChance.min === 0 && T.QUERY_PARAMS.snatchChance.max === 1);
        check('snatchDistance 已登記（int 0 ~ 2000）',
            T.QUERY_PARAMS?.snatchDistance?.type === 'int'
            && T.QUERY_PARAMS.snatchDistance.min === 0
            && T.QUERY_PARAMS.snatchDistance.max === 2000);
        check('四段倍率已登記（速度 0.2~10、縮淡 0~10，皆 float）',
            T.QUERY_PARAMS?.snatchDiveRate?.type === 'float'
            && T.QUERY_PARAMS.snatchDiveRate.min === 0.2 && T.QUERY_PARAMS.snatchDiveRate.max === 10
            && T.QUERY_PARAMS?.snatchFleeRate?.min === 0.2 && T.QUERY_PARAMS.snatchFleeRate.max === 10
            && T.QUERY_PARAMS?.snatchShrinkRate?.min === 0 && T.QUERY_PARAMS.snatchShrinkRate.max === 10
            && T.QUERY_PARAMS?.snatchFadeRate?.min === 0 && T.QUERY_PARAMS.snatchFadeRate.max === 10);
        check('config.js 預設 snatchChance = 0.25 / snatchDistance = 150',
            CONFIG.snatchChance === 0.25 && CONFIG.snatchDistance === 150);
        check('config.js 預設四段倍率 = 俯衝 1.6 / 遠走 1.8 / 縮小 1 / 變淡 1',
            CONFIG.snatchDiveRate === 1.6 && CONFIG.snatchFleeRate === 1.8
            && CONFIG.snatchShrinkRate === 1 && CONFIG.snatchFadeRate === 1);

        // 場面：一近一遠；追果實速度釘死 1px/幀，觸發時序才可斷言
        T.getBerries().slice().forEach(b => T.removeBerry(b));
        T.pokemons.length = 0;
        const witness = newPokemon(25, { scale: 0.6 });
        const other = newPokemon(143, { scale: 1 });
        witness.x = 900; witness.speed = 0.4; // 小跑步 = 0.4 × 2.5 = 1px/幀
        other.x = 200;
        T.pokemons.push(witness, other);
        const resetField = () => {
            T.getBerries().slice().forEach(b => T.removeBerry(b));
            witness.targetBerry = null; witness.state = 'WALKING'; witness.x = 900;
            other.targetBerry = null; other.state = 'WALKING'; other.x = 200;
        };

        // 門檻內 = 絕對安全：距離 40px，必中的骰也不埋伏筆
        sandbox.window.POKE_FLYING = [18]; // 比雕：單一元素池，抽誰是確定的
        CONFIG.snatchChance = 1;
        clickAt(1000, 60); // witness 中心 960 → 距離 40 ≤ 150
        check('門檻內 → 不埋伏筆、正常餵食', T.getPending() === null && T.getSnatch() === null
            && T.getBerries()[0]?.feeder === witness && witness.state === 'SEEK_BERRY');
        resetField();

        // 門檻可調：拉高到 500 後，440px 的丟法也安全
        CONFIG.snatchDistance = 500;
        clickAt(1400, 60); // 距離 440
        check('門檻拉高到 500 → 440px 的丟法也安全', T.getPending() === null);
        resetField();
        CONFIG.snatchDistance = 150;

        // 機率 0 → 超過門檻也不埋
        CONFIG.snatchChance = 0;
        clickAt(1400, 60);
        check('snatchChance=0 → 不埋伏筆', T.getPending() === null);
        resetField();
        CONFIG.snatchChance = 1;

        // 飛行池沒載到 → 不埋（名單檔是獨立檔案，可能被拿掉）
        delete sandbox.window.POKE_FLYING;
        clickAt(1400, 60);
        check('飛行池沒載到 → 不埋伏筆', T.getPending() === null);
        resetField();
        sandbox.window.POKE_FLYING = [18];

        // 遙控 feed / 信使鳥空投走的 throwBerry 不帶旗 → 永不被盯上
        check('（前置）直接呼叫 throwBerry（同遙控/空投路徑）成功',
            T.throwBerry(1400, 100) === true);
        check('不帶旗的果實不會被盯上（點擊限定）', T.getPending() === null);
        resetField();

        // 正式開演：超過門檻 + 必中 → 埋伏筆，但畫面看不出任何異狀
        clickAt(1400, 60); // 距離 440 > 150 → 觸發點 = 剩 220
        const sb = T.getBerries()[0];
        check('伏筆已埋（賊鳥還沒出來）', T.getPending() !== null && T.getSnatch() === null);
        check('被盯上的那隻照常起跑（看不出異狀）',
            witness.state === 'SEEK_BERRY' && sb.feeder === witness
            && witness.bubbleName === 'exclaim');

        // 追到一半：賊鳥進場、再冒一次驚嘆號、原地停步、果實變無主
        witness.hideEmote(); // 先收掉發現時的驚嘆號，才驗得出「再冒一次」
        let guard = 0;
        while (!T.getSnatch() && guard++ < 2000) {
            T.updateBerries(16);
            witness.update(16, T.pokemons);
            T.updateSnatch(16);
        }
        const s = T.getSnatch();
        check('走完一半路程 → 賊鳥進場', !!s && s.phase === 'DIVE', `guard=${guard}`);
        const remaining = Math.abs(witness.centerX() - sb.x);
        check('觸發點 = 剩一半距離（220px ±2）', Math.abs(remaining - 220) <= 2,
            `remaining=${remaining}`);
        check('再冒一次驚嘆號、原地停步', witness.state === 'SNATCH_WATCH'
            && witness.bubbleName === 'exclaim' && witness.bubble.style.display === 'block');
        check('果實變無主（不會被任何隻接手）', sb.feeder === null
            && witness.targetBerry === null);
        check('其他成員照常散步（世界不為一顆果實停下來）', other.state === 'WALKING');

        // 賊鳥的進場幾何與速度（預設倍率：俯衝 1.6、遠走 1.8）
        check('從果實那一側的畫面外進場（右半邊 → 右側、面向左）',
            s.x > 1920 && s.direction === -1, `x=${s.x}`);
        check('進場高度在客串的飛行高度帶（視窗高 45%~75%）',
            s.bottom >= 90 && s.bottom <= 150, `bottom=${s.bottom}`);
        check('俯衝 = 巡航 × snatchDiveRate 1.6（±10%）',
            s.speed >= 5 * 1.6 * 0.9 - 1e-9 && s.speed <= 5 * 1.6 * 1.1 + 1e-9,
            `speed=${s.speed}`);
        check('遠走 = 巡航 × snatchFleeRate 1.8（與俯衝共用同一次變異抽選）',
            Math.abs(s.fleeSpeed / s.speed - 1.8 / 1.6) < 1e-9, `flee=${s.fleeSpeed}`);
        check('等待保險絲跟著航程重算（8 秒基底 + 俯衝預估）',
            witness.watchTimer > 9000 && witness.watchTimer < 10500,
            `watchTimer=${witness.watchTimer}`);
        check('主角時刻蓋過全場（z-index 20001、沿用 cameo 樣式不可點）',
            s.el.style.zIndex === 20001 && s.el.className === 'cameo');

        // 倍率真的吃 CONFIG（直接建構驗速度，不用跑整場）
        CONFIG.snatchDiveRate = 4; CONFIG.snatchFleeRate = 8;
        const fast = new T.Snatcher(18, 0.8, { x: 1400, bottom: 0 }, null);
        check('速度倍率可調：dive×4 / flee×8 立即生效',
            fast.speed >= 5 * 4 * 0.9 - 1e-9 && fast.speed <= 5 * 4 * 1.1 + 1e-9
            && Math.abs(fast.fleeSpeed / fast.speed - 2) < 1e-9, `speed=${fast.speed}`);
        fast.el.remove();
        CONFIG.snatchDiveRate = 1.6; CONFIG.snatchFleeRate = 1.8;

        // 目擊中：站著看戲、不接新果實；一次只演一場
        const wx = witness.x;
        for (let i = 0; i < 20; i++) witness.update(16, T.pokemons);
        check('目擊中站在原地看戲', witness.x === wx && witness.state === 'SNATCH_WATCH');
        check('目擊中不接新果實（canTakeBerry = false）', witness.canTakeBerry() === false);
        clickAt(700, 60); // 離 other(中心 260) 440px > 門檻，但場次進行中
        check('場次進行中再丟 → 正常餵食、不疊第二場',
            T.getPending() === null && T.getSnatch() === s
            && T.getBerries().length === 2 && T.getBerries()[1].feeder === other);
        T.removeBerry(T.getBerries()[1]);
        other.targetBerry = null; other.state = 'WALKING';

        // 俯衝到 V 字底部叼走（homing 每一幀朝果實「當下」位置修正）
        guard = 0;
        while (s.phase === 'DIVE' && guard++ < 3000) { T.updateBerries(16); T.updateSnatch(16); }
        check('俯衝到位 → 叼走果實', s.phase === 'FLEE' && s.carrying === true, `guard=${guard}`);
        check('叼取點 = 果實正上方、腳下叼取高度',
            s.x === sb.x - s.width() / 2 && s.bottom === sb.bottom + 24,
            `x=${s.x} bottom=${s.bottom}`);
        check('果實從場上除名、影子收掉、掛到賊鳥腳下一起飛',
            T.getBerries().length === 0 && s.el.children.includes(sb.el)
            && sb.el.style.bottom === '-24px' && sb.shadow.removed === true);
        check('叼走那一刻目擊者換成一團黑線', witness.bubbleName === 'scribble'
            && witness.bubble.style.display === 'block');

        // 遠走高飛：恆速直線 + 鏡像 V 字 + 透視縮小淡出
        const x0 = s.x, b0 = s.bottom;
        T.updateSnatch(16);
        const dx1 = x0 - s.x, dy1 = s.bottom - b0;
        check('遠走方向 = 進場的橫向（往左）且爬升', dx1 > 0 && dy1 > 0,
            `dx=${dx1} dy=${dy1}`);
        const x1 = s.x, b1 = s.bottom;
        T.updateSnatch(16);
        check('恆定速度（連續兩幀位移一致）',
            Math.abs((x1 - s.x) - dx1) < 1e-9 && Math.abs((s.bottom - b1) - dy1) < 1e-9);
        check('速率 = 遠走段速度', Math.abs(Math.hypot(dx1, dy1) - s.fleeSpeed * 0.96) < 1e-6,
            `實際 ${Math.hypot(dx1, dy1)}`);
        // 鏡像：爬升斜率 = 俯衝段（進場點 → 叼取點）跌下來的斜率
        const run = Math.abs(x0 - s.startX);
        const rise = Math.max(Math.abs(b0 - s.startBottom), run * 0.25);
        check('V 字鏡像：爬升角 = 俯衝角', Math.abs(dy1 / dx1 - rise / run) < 1e-9,
            `爬升 ${dy1 / dx1}，俯衝 ${rise / run}`);
        const scaleOf = () => Number((s.el.style.transform.match(/scale\(([\d.]+)\)/) || [])[1]);
        check('透視縮小走 1/(1+3t)', Math.abs(scaleOf() - 1 / (1 + 3 * s.shrinkT)) < 0.001,
            `scale=${scaleOf()} t=${s.shrinkT}`);
        for (let i = 0; i < 30; i++) T.updateSnatch(16);
        check('持續變小、也開始變淡',
            scaleOf() < 1 && scaleOf() > 0.55 && Number(s.el.style.opacity) < 1,
            `scale=${scaleOf()} opacity=${s.el.style.opacity}`);
        check('變淡走 1 - t²，且預設倍速下與縮小同步計時',
            Math.abs(Number(s.el.style.opacity) - (1 - s.fadeT * s.fadeT)) < 0.001
            && Math.abs(s.fadeT - s.shrinkT) < 1e-9,
            `opacity=${s.el.style.opacity} fadeT=${s.fadeT} shrinkT=${s.shrinkT}`);
        // 縮淡分軌：縮小凍結時，變淡照走
        CONFIG.snatchShrinkRate = 0;
        const frozenScale = scaleOf();
        const opBefore = Number(s.el.style.opacity);
        T.updateSnatch(16);
        check('縮小倍速 0 → 縮小凍結、變淡照走（兩軌各自計時）',
            scaleOf() === frozenScale && Number(s.el.style.opacity) < opBefore,
            `scale=${scaleOf()} opacity=${s.el.style.opacity}`);
        CONFIG.snatchShrinkRate = 1;
        guard = 0;
        while (T.getSnatch() && guard++ < 300) T.updateSnatch(16);
        check('淡完或飛出畫面 → 自動清場', T.getSnatch() === null, `guard=${guard}`);

        // 目擊者沮喪 2.6 秒才回去散步；黑線對話框到時自動收起
        guard = 0;
        while (witness.state === 'SNATCH_WATCH' && guard++ < 300) witness.update(16, T.pokemons);
        check('沮喪計時走完 → 回去散步', witness.state === 'WALKING', `guard=${guard}`);
        advance(2601);
        check('黑線對話框自動收起', witness.bubble.style.display === 'none');
        resetField();

        // 伏筆期被抓走：果實沒人護著，賊鳥立刻趁虛而入——
        // 苦主正忙著掙扎，不演目擊戲（無驚嘆、victim 空缺、果實變無主）
        clickAt(1400, 60);
        check('（前置）伏筆已埋', T.getPending() !== null);
        const heldBerry = T.getBerries()[0];
        witness.bobY = 0; witness.jumpY = 0; witness.jumpV = 0;
        witness.grab({ x: witness.x + 10, bottom: 0 });
        T.updateSnatch(16);
        const s5 = T.getSnatch();
        check('追到一半被抓走 → 賊鳥立刻出手（不等走完半程）',
            T.getPending() === null && !!s5 && s5.phase === 'DIVE');
        check('被抓著的苦主不演目擊戲（無驚嘆、victim 空缺、主權留在手上）',
            witness.state === 'HELD' && witness.bubble.style.display === 'none'
            && s5.victim === null && witness.targetBerry === heldBerry
            && heldBerry.feeder === null);

        // 俯衝途中放手：落回地面撞見賊鳥 → 照舊補開目擊戲
        witness.release();
        check('俯衝途中放手 → 撞見賊鳥、照舊開演目擊戲（保險絲依剩餘航程重算）',
            witness.state === 'SNATCH_WATCH' && witness.targetBerry === null
            && witness.bubbleName === 'exclaim' && s5.victim === witness
            && witness.watchTimer > 8000);
        guard = 0;
        while (s5.phase === 'DIVE' && guard++ < 3000) { T.updateBerries(16); T.updateSnatch(16); }
        check('叼走那一刻照舊換黑線', s5.carrying === true
            && witness.bubbleName === 'scribble', `guard=${guard}`);
        guard = 0;
        while (T.getSnatch() && guard++ < 600) T.updateSnatch(16);
        witness.state = 'WALKING'; witness.hideEmote();
        resetField();

        // 被抓著直到賊鳥得手：全程無感（不驚嘆不黑線），放手後空手回去散步
        clickAt(1400, 60);
        check('（前置）第二場伏筆已埋', T.getPending() !== null);
        witness.bobY = 0; witness.jumpY = 0; witness.jumpV = 0;
        witness.grab({ x: witness.x + 10, bottom: 0 });
        T.updateSnatch(16);
        const s6 = T.getSnatch();
        guard = 0;
        while (s6.phase === 'DIVE' && guard++ < 3000) { T.updateBerries(16); T.updateSnatch(16); }
        check('抓著的期間被叼走 → 苦主全程無感（不驚嘆也不黑線）',
            s6.carrying === true && witness.state === 'HELD'
            && witness.bubble.style.display === 'none', `guard=${guard}`);
        witness.release();
        check('放手時果實已經沒了 → 空手回去散步',
            witness.state === 'WALKING' && witness.targetBerry === null);
        guard = 0;
        while (T.getSnatch() && guard++ < 600) T.updateSnatch(16);
        resetField();

        // 規則二：門檻內起跑（絕對安全），被抓去遠方放開——
        // 半空中先不擲骰，落地那一刻依「新的距離」重擲（機率 1 必中）
        clickAt(1000, 60); // witness 中心 960 → 距離 40 ≤ 150，丟的當下安全
        check('（前置）門檻內起跑、沒有伏筆',
            witness.state === 'SEEK_BERRY' && T.getPending() === null);
        witness.bobY = 0; witness.jumpY = 0; witness.jumpV = 0;
        witness.grab({ x: witness.centerX(), bottom: 0 });
        witness.dragTo({ x: 200, bottom: 60 }); // 抓去左遠方、離地 60
        witness.release();
        check('放手在半空 → 續追但先不擲骰（距離以落地位置為準）',
            witness.state === 'SEEK_BERRY' && witness.resnatchOnLand === true
            && witness.jumpY > 0 && T.getPending() === null);
        guard = 0;
        while (witness.jumpY > 0 && guard++ < 600) witness.update(16, T.pokemons);
        check('落地重算：距離拉遠了 → 重新埋下伏筆',
            T.getPending() !== null && T.getPending().seeker === witness
            && witness.resnatchOnLand === false, `guard=${guard}`);
        resetField();
        T.updateSnatch(16); // 果實被 resetField 收走 → 這一幀把伏筆沖掉
        check('（清場）伏筆已沖掉', T.getPending() === null);

        // 伏筆期的取消：已經站到嘴邊開吃（門檻 0 + 丟在腳邊的極端組合，
        // 6px 的路程永遠走不到「剩 3px」——seekBerry 在 6px 內就站定了）
        CONFIG.snatchDistance = 0;
        clickAt(966, 199); // 距離 6 > 0 有埋；bottom = 1，一落地就開吃
        check('（前置）貼臉的伏筆也埋得下', T.getPending() !== null);
        guard = 0;
        while (witness.state !== 'EATING' && guard++ < 50) {
            T.updateBerries(16);
            witness.update(16, T.pokemons);
            T.updateSnatch(16);
        }
        T.updateSnatch(16);
        check('站到嘴邊開吃 → 伏筆作廢（太晚了，搶不到）',
            witness.state === 'EATING' && T.getPending() === null && T.getSnatch() === null);
        resetField();
        CONFIG.snatchDistance = 150;

        // 防禦：俯衝到一半果實意外沒了 → 空爪轉遠走、目擊者直接解脫
        clickAt(1400, 60);
        guard = 0;
        while (!T.getSnatch() && guard++ < 2000) {
            T.updateBerries(16);
            witness.update(16, T.pokemons);
            T.updateSnatch(16);
        }
        const s2 = T.getSnatch();
        check('（前置）第二場開演', !!s2 && witness.state === 'SNATCH_WATCH');
        T.removeBerry(T.getBerries()[0]); // 硬把果實抽走（現行規則到不了，防禦路徑）
        CONFIG.snatchFadeRate = 0; // 這場順便驗「永不變淡」：只能飛到出畫面收場
        T.updateSnatch(16);
        check('果實沒了 → 空爪轉遠走、目擊者不演沮喪',
            s2.phase === 'FLEE' && s2.carrying === false
            && witness.state === 'WALKING' && witness.bubbleName !== 'scribble');
        for (let i = 0; i < 30; i++) T.updateSnatch(16);
        check('變淡倍速 0 → 透明度紋風不動', s2.el.style.opacity === '1.000',
            `opacity=${s2.el.style.opacity}`);
        guard = 0;
        while (T.getSnatch() && guard++ < 600) T.updateSnatch(16);
        check('永不淡出就飛到出畫面為止（照樣清場）', T.getSnatch() === null, `guard=${guard}`);
        CONFIG.snatchFadeRate = 1;
        resetField();

        // 載圖全滅 → 這場取消：無主果實收掉、目擊者立刻解脫
        clickAt(1400, 60);
        guard = 0;
        while (!T.getSnatch() && guard++ < 2000) {
            T.updateBerries(16);
            witness.update(16, T.pokemons);
            T.updateSnatch(16);
        }
        const s3 = T.getSnatch();
        check('（前置）第三場開演', !!s3 && witness.state === 'SNATCH_WATCH');
        s3.img.onerror();
        check('動圖失敗 → 退靜態圖（同一隻賊鳥）', s3.img.src.endsWith('/18.png'));
        s3.img.onerror();
        T.updateSnatch(16);
        check('靜圖也失敗 → 這場取消：清場 + 無主果實收掉',
            T.getSnatch() === null && T.getBerries().length === 0);
        check('目擊者立刻解脫，不對著空氣沮喪',
            witness.state === 'WALKING' && witness.bubble.style.display === 'none');
        resetField();

        // 果實在左半邊 → 從左側進場（進場側跟著果實走）
        other.x = 1500; // witness(中心 960) 是離左邊點擊最近的
        clickAt(400, 60); // 距離 560 > 300
        guard = 0;
        while (!T.getSnatch() && guard++ < 2000) {
            T.updateBerries(16);
            witness.update(16, T.pokemons);
            T.updateSnatch(16);
        }
        const s4 = T.getSnatch();
        check('果實在左半邊 → 從左側畫面外進場、鏡像面向右',
            !!s4 && s4.direction === 1 && s4.x < 0
            && s4.img.style.transform === 'scaleX(-1)', `x=${s4?.x}`);
        s4.img.onerror(); s4.img.onerror(); // 快速收掉這場
        T.updateSnatch(16);
        check('取消收場也放目擊者自由', witness.state === 'WALKING');
        resetField();

        // berry='off' → 整套關閉（丟不出果實，自然也沒有搶食）
        CONFIG.berry = 'off';
        clickAt(1400, 60);
        check("berry='off' → 沒果實也沒伏筆", T.getPending() === null
            && T.getSnatch() === null && T.getBerries().length === 0);
        CONFIG.berry = 'on';

        delete sandbox.window.POKE_FLYING;
        CONFIG.snatchChance = savedSnatch;
        CONFIG.snatchDistance = savedSnatchD;
        [CONFIG.snatchDiveRate, CONFIG.snatchFleeRate,
            CONFIG.snatchShrinkRate, CONFIG.snatchFadeRate] = savedRates;
        CONFIG.shinyChance = savedShinyS;
        CONFIG.greetChance = savedGreetS;
        CONFIG.idleChance = savedIdle;
    }

    // =====================================================
    group('28. 果實影子');
    {
        const savedIdleB = CONFIG.idleChance;
        CONFIG.idleChance = 0;
        T.getBerries().slice().forEach(b => T.removeBerry(b));
        T.pokemons.length = 0;
        const eater = newPokemon(25, { scale: 0.6 });
        eater.x = 900; // 中心 960
        T.pokemons.push(eater);

        // 高空丟在腳邊（飛行池已卸載，不會觸發搶食）：影子生在正下方的地面
        clickAt(960, 20); // bottom = 180
        const b = T.getBerries()[0];
        check('果實帶影子（貼在地面、置中於果實正下方）',
            b.shadow?.className === 'berry-shadow'
            && b.shadow.style.left === `${Math.round(b.x)}px`
            && b.shadow.style.bottom === '0px'
            && appEl.children.includes(b.shadow));
        check('高空時影子又小又淡（120px 以上 → 0.5 倍、0.4 透明度）',
            b.shadow.style.transform === 'translateX(-50%) scale(0.500)'
            && b.shadow.style.opacity === '0.400',
            `transform=${b.shadow.style.transform} opacity=${b.shadow.style.opacity}`);

        // 越接近地面越大越深（符合物理：跟寶可夢跳躍的影子同一套）
        while (b.bottom > 60) T.updateBerries(16);
        const midScale = Number((b.shadow.style.transform.match(/scale\(([\d.]+)\)/) || [])[1]);
        const midOp = Number(b.shadow.style.opacity);
        check('下墜途中影子逐漸放大加深', midScale > 0.5 && midScale < 1
            && midOp > 0.4 && midOp < 1, `scale=${midScale} opacity=${midOp}`);
        let bg = 0;
        while (b.state !== 'LANDED' && bg++ < 500) T.updateBerries(16);
        check('落地（含彈跳收尾）→ 影子全尺寸全深度',
            b.state === 'LANDED'
            && b.shadow.style.transform === 'translateX(-50%) scale(1.000)'
            && b.shadow.style.opacity === '1.000');

        // 開吃：影子跟著咬痕一口一口縮小；吃完連影子一起收
        for (let i = 0; i < 50 && eater.state !== 'EATING'; i++) eater.update(16, T.pokemons);
        check('（前置）站在果實旁開吃', eater.state === 'EATING');
        let bitten = false;
        for (let i = 0; i < 100 && eater.state === 'EATING'; i++) {
            eater.update(16, T.pokemons);
            if (b.shadow.style.transform === 'translateX(-50%) scale(0.72)') bitten = true;
        }
        check('影子跟著咬痕縮小（0.72 的那一口）', bitten);
        check('吃完 → 果實與影子一起移除', !T.getBerries().includes(b)
            && b.el.removed === true && b.shadow.removed === true);

        // 意外收場（removeBerry 的所有入口）也一起收影子
        eater.state = 'WALKING'; eater.targetBerry = null;
        check('（前置）再丟一顆', T.throwBerry(900, 100) === true);
        const b2 = T.getBerries()[0];
        T.removeBerry(b2);
        check('removeBerry → 影子一起移除', b2.shadow.removed === true);
        eater.state = 'WALKING'; eater.targetBerry = null;
        CONFIG.idleChance = savedIdleB;
    }

    // =====================================================
    group('29. 天氣（主題地面的雨/雪/風沙/火星）');
    {
        const savedWC = CONFIG.weatherChance;
        const savedWD = CONFIG.weatherDensity;

        // 參數登記 + config 預設
        check('weatherChance 已登記（float 0 ~ 1）',
            T.QUERY_PARAMS?.weatherChance?.type === 'float'
            && T.QUERY_PARAMS.weatherChance.min === 0 && T.QUERY_PARAMS.weatherChance.max === 1);
        check('weatherDensity 已登記（float 0.2 ~ 5）',
            T.QUERY_PARAMS?.weatherDensity?.type === 'float'
            && T.QUERY_PARAMS.weatherDensity.min === 0.2 && T.QUERY_PARAMS.weatherDensity.max === 5);
        check('config.js 預設 weatherChance = 0.5 / weatherDensity = 1',
            CONFIG.weatherChance === 0.5 && CONFIG.weatherDensity === 1);

        // 主題 → 天氣對照：每一種地形都配了天氣
        check('對照表：雨（草地/水域/岩地/土徑）、雪、風沙、火星',
            T.THEME_WEATHER.grass === 'rain' && T.THEME_WEATHER.water === 'rain'
            && T.THEME_WEATHER.rock === 'rain' && T.THEME_WEATHER.dirt === 'rain'
            && T.THEME_WEATHER.snow === 'snow' && T.THEME_WEATHER.sand === 'sand'
            && T.THEME_WEATHER.lava === 'ember');
        check('每一種地形都配了天氣', Object.keys(T.GROUND_THEMES).every(k => T.THEME_WEATHER[k]));

        // 機率與場景的閘門
        CONFIG.weatherChance = 0;
        check('weatherChance=0 → 永遠晴天', T.initWeather('water') === null);
        CONFIG.weatherChance = 1;
        check("theme='none' 沒有場景就沒有天氣", T.initWeather('none') === null);

        // 下雨：斜斜細細長長的藍色雨絲
        check('水域 → 下雨', T.initWeather('water') === 'rain');
        const rain = appEl.children[appEl.children.length - 1];
        check('#weather 容器（粒子交給 CSS 動畫，不吃主迴圈）', rain.id === 'weather');
        check('雨滴數量 = 視窗寬 ÷ 16（1920 → 120 滴）', rain.children.length === 120,
            `實際 ${rain.children.length}`);
        const d0 = rain.children[0];
        check('雨滴細細長長（高 10~18px，寬 2px 由 CSS 給）',
            d0.className === 'rain-drop' && /^1[0-8]px$/.test(d0.style.height),
            `height=${d0.style.height}`);
        check('雨滴是半透明的藍色', ['#6faae8', '#4a7fd4'].includes(d0.style.background)
            && Number(d0.style.opacity) > 0 && Number(d0.style.opacity) < 1);
        check('每一滴都有自己的時長/相位/斜角/橫移（CSS 變數）',
            rain.children.every(d => d.style.getPropertyValue('--dur')
                && d.style.getPropertyValue('--delay')
                && d.style.getPropertyValue('--tilt')
                && d.style.getPropertyValue('--drift')));
        check('全場共用同一個風向（斜角同號）', new Set(rain.children.map(d =>
            Math.sign(parseFloat(d.style.getPropertyValue('--tilt'))))).size === 1);
        // 迴歸：傾角要躺在速度向量上——CSS rotate 正角是順時針（直立桿轉成「/」），
        // 往右下落（drift 為正）該躺成「\」，所以 tilt 與 drift 必須反號、
        // 角度 = atan(橫移 ÷ 125vh 落高)。同號 = 傾斜與降落方向鏡像相反（0.35.0 的 bug）
        check('雨絲傾角與降落方向一致（tilt 與 drift 反號、角度吻合幾何）',
            rain.children.every(d => {
                const tilt = parseFloat(d.style.getPropertyValue('--tilt'));
                const drift = parseFloat(d.style.getPropertyValue('--drift'));
                return Math.sign(tilt) === -Math.sign(drift)
                    && Math.abs(Math.abs(tilt)
                        - Math.atan(Math.abs(drift) / 125) * (180 / Math.PI)) < 0.1;
            }));

        // 密度可調
        CONFIG.weatherDensity = 0.5;
        T.initWeather('water');
        const half = appEl.children[appEl.children.length - 1];
        check('weatherDensity=0.5 → 雨滴減半（60 滴）', half.children.length === 60,
            `實際 ${half.children.length}`);
        CONFIG.weatherDensity = 1;

        // 下雪：白點慢慢飄——外層直落、內層左右搖曳，兩層才有「飄」的感覺
        check('雪地 → 下雪', T.initWeather('snow') === 'snow');
        const snow = appEl.children[appEl.children.length - 1];
        const f0 = snow.children[0];
        check('雪花數量 = 視窗寬 ÷ 26（1920 → 74 片）', snow.children.length === 74,
            `實際 ${snow.children.length}`);
        check('雪花兩層：外層落下、內層搖曳',
            f0.className === 'snow-flake' && f0.children.length === 1
            && !!f0.style.getPropertyValue('--dur')
            && !!f0.children[0].style.getPropertyValue('--amp')
            && !!f0.children[0].style.getPropertyValue('--sway'));
        check('雪花是白色小方點（2~4px）', f0.children[0].style.background === '#ffffff'
            && /^[2-4]px$/.test(f0.children[0].style.width));

        // 風沙與火星
        check('沙灘 → 風沙', T.initWeather('sand') === 'sand');
        const sand = appEl.children[appEl.children.length - 1];
        check('沙痕帶橫掃全場的向量（±125vw）',
            sand.children[0].className === 'sand-grain'
            && Math.abs(parseFloat(sand.children[0].style.getPropertyValue('--travel'))) === 125);
        check('熔岩 → 火星', T.initWeather('lava') === 'ember');
        const lava = appEl.children[appEl.children.length - 1];
        check('火星從低處上飄（--rise 為負）、會左右輕晃',
            lava.children[0].className === 'lava-ember'
            && parseFloat(lava.children[0].style.getPropertyValue('--rise')) < 0
            && lava.children[0].style.getPropertyValue('--sway') !== '');

        // 減速模式（prefers-reduced-motion）整組收起：動不了的雨雪只是一牆斑點
        check('reduced-motion 時 #weather 整組隱藏（CSS 保障）',
            /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?#weather\s*\{\s*display:\s*none/.test(html));

        // random 主題與天氣吃同一個抽選結果：init() 先 resolveTheme 再分頭餵
        check('resolveTheme：具體主題原樣通過', T.resolveTheme('water') === 'water'
            && T.resolveTheme('none') === 'none');
        const origRandom2 = Math.random;
        Math.random = () => 0;
        check("resolveTheme('random') → 池子第一種（草地）", T.resolveTheme('random') === 'grass');
        Math.random = () => 0.999;
        check("resolveTheme('random') → 也抽得到 'none'", T.resolveTheme('random') === 'none');
        Math.random = origRandom2;

        CONFIG.weatherChance = savedWC;
        CONFIG.weatherDensity = savedWD;
    }

    // =====================================================
    group('30. 嵌入透明性守則（color-scheme）');
    // iframe 要維持透明，內外文件的 color-scheme 必須一致。
    // 這裡守住兩條血淚教訓：
    //   0.20.0 widget 沒宣告 → 被宣告 dark 的頁面（params.html）嵌 → 墊白底
    //   0.20.1 widget 宣告 light dark → OS 深色 + 嵌入方沒宣告 → 墊黑底
    // 正解：widget 釘死 light；宣告過 dark 的嵌入方在 iframe「元素」上對齊
    check('widget 釘死 color-scheme: light', /color-scheme:\s*light\s*;/.test(html));
    check('widget 不得宣告 light dark（OS 深色時會自己變 dark、被墊黑底）',
        !/color-scheme:\s*light\s+dark/.test(html));
    const paramsHtml = fs.readFileSync(path.join(ROOT, 'params.html'), 'utf8');
    check('params.html 預覽軌 iframe 元素有 color-scheme: light 對齊',
        /#frame\s*\{[^}]*color-scheme:\s*light/.test(paramsHtml));
    check('params.html 的嵌入範例都帶 color-scheme:light 保險',
        (paramsHtml.match(/pointer-events:none; color-scheme:light/g) || []).length >= 3,
        'hero-snippet / remote-snippet / embedSnippet() 都該有');

    console.log(`\n${'='.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項\n${'='.repeat(46)}`);
    process.exit(fail ? 1 : 0);
})();
