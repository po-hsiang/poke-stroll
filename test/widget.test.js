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
                fillRect(x, y, w, h) { cells.push({ x, y, color: fillStyle }); },
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
    source + '\n;globalThis.__T = { Pokemon, buildBubbleFrame, getEmoteURI, EMOTE_ICONS, EMOTE_PALETTE, CONFIG, fallbackSizeScale, QUERY_PARAMS };',
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
check('朝右的尾巴整體偏中線左側、朝左的偏右側（各自指回本體那一邊）',
    mouthCenter(frameR) < mid && mouthCenter(frameL) > mid,
    `mouthR=${mouthCenter(frameR)}, mouthL=${mouthCenter(frameL)}, mid=${mid}`);
check('兩者與中線等距', Math.abs(mouthCenter(frameR) - mid) === Math.abs(mouthCenter(frameL) - mid));

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
group("4. side 擺位：整框推到本體之外 + 尾巴朝內");
CONFIG.bubblePosition = 'side';
{
    const p = newPokemon(143, { direction: 1 });
    p.showEmote('heart');
    const gap = 2 * p.bubbleScale;
    check('面向右 → 框貼在右緣外側', p.bubble.style.left === '100%');
    check('面向右 → 位移為 +gap（完全不與本體重疊）',
        p.bubble.style.transform === `translateX(${gap}px)`, p.bubble.style.transform);
    check('面向右 → 尾巴朝左（指回本體）',
        p.bubble.src === T.getEmoteURI('heart', -1));

    p.direction = -1;
    p.updateDOM();
    check('轉向左 → 自動換到左緣', p.bubble.style.left === '0');
    check('轉向左 → 位移為 -(100% + gap)',
        p.bubble.style.transform === `translateX(calc(-100% - ${gap}px))`, p.bubble.style.transform);
    check('轉向左 → 尾巴改朝右', p.bubble.src === T.getEmoteURI('heart', 1));
    check('垂直錨在身高六成處', p.bubble.style.bottom === '60%');

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
        p.bubble.style.transform === `translateX(calc(-100% - ${gap}px))`);

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

    // 走著走著逼近邊界（保護期中的色違會邊走邊冒泡）也要即時翻邊
    const r = newPokemon(143, { shiny: true, direction: 1 });
    check('色違登場先擺右側', r.bubbleSide === 1);
    for (let i = 0; i < 5; i++) { r.x = W - bodyW - width * (5 - i) * 0.5; r.updateDOM(); }
    check('邊走邊靠近右邊界 → 自動翻到左側', r.bubbleSide === -1);
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
    check('config.js 預設 = 2', CONFIG.bubbleSideGap === 2, `實際 ${CONFIG.bubbleSideGap}`);

    const saved = CONFIG.bubbleSideGap;
    // 設定值是點陣圖 px，乘上放大倍率：大體型 3x、小體型 2x
    const big = newPokemon(143, { scale: 1 });      // bubbleScale 3
    const small = newPokemon(25, { scale: 0.6 });   // bubbleScale 2
    big.showEmote('heart');
    small.showEmote('heart');
    check('大體型（3x）預設空隙 = 6px', big.bubbleMetrics().gap === 6, `實際 ${big.bubbleMetrics().gap}`);
    check('小體型（2x）預設空隙 = 4px', small.bubbleMetrics().gap === 4, `實際 ${small.bubbleMetrics().gap}`);
    check('預設值套進 transform', big.bubble.style.transform === 'translateX(6px)');

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
    check('缺 bubbleSideGap key → 退回預設 2（大體型 6px）',
        big.bubbleMetrics().gap === 6, `實際 ${big.bubbleMetrics().gap}`);
    CONFIG.bubbleSideGap = saved;
}

// =========================================================
group('15. bubbleSideGap 的 URL 參數白名單');
{
    const spec = T.QUERY_PARAMS?.bubbleSideGap;
    check('已登記在 QUERY_PARAMS', !!spec);
    if (spec) {
        check('型別 int（半像素會糊掉）', spec.type === 'int');
        check('允許負數（可疊回身體上）', spec.min < 0);
        check('路徑指向 bubbleSideGap', JSON.stringify(spec.path) === '["bubbleSideGap"]');
    }
}

console.log(`\n${'='.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
