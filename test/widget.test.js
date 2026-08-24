// =========================================================
// PokéStroll 單元測試
//
//   執行：node test/widget.test.js   （不需要 npm install，零依賴）
//   覆蓋率：node --test --experimental-test-coverage --test-coverage-exclude='test/**' test/widget.test.js
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
//
// 分工（別在這裡重蓋一次）：
//   設定值本身（每個參數的預設值、允許範圍、白名單登記）交給
//   test/params-doc.test.js —— 它把 config.js、js/params.js 的白名單、
//   PARAMS.md、params.html 四方逐一比對，一次涵蓋全部參數。
//   這裡只驗「設定值怎麼變成行為」：改了旋鈕，畫面/狀態要跟著變。
//   在這裡抄一行 `CONFIG.x === 3` 沒有任何額外保障，只會讓改預設值的人
//   多一個地方要改。
// =========================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// vm 的 filename 一律給 file:// 絕對網址，這樣 V8 才認得它是磁碟上的檔案：
//   node --test --experimental-test-coverage test/widget.test.js
// 才量得到 js/ 底下主程式的覆蓋率（給相對路徑的話整份會被報表略過）。
const srcUrl = rel => require('url').pathToFileURL(path.join(ROOT, rel)).href;
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
        // 名牌用的對照表同樣給假的：真表在第 39 組另外驗（含與身高/屬性表的交叉比對）
        POKE_NAMES: { 25: '皮卡丘', 143: '卡比獸' },
        // postMessage 遙控會掛 message 監聽器；測試從 listeners 取出直接餵假事件
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    },
};
sandbox.globalThis = sandbox;

// 載入真正的 config.js（同時驗證它語法正確；預設值本身由文件同步檢查守）
vm.createContext(sandbox);
const configSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
vm.runInContext(configSrc, sandbox, { filename: srcUrl('config.js') });
const CONFIG = sandbox.window.POKE_CONFIG;

// 地面主題釘回 'none'：主程式一載入就會跑 init() → initGround(CONFIG.theme)，
// 預設的 'random' 會讓 groundLevel 隨機，果實落點、抓取高度……一票斷言全會翻車
CONFIG.theme = 'none';

// 同理，日照預設是「跟著本機時鐘」——影子的長短方向會隨著跑測試的時間變，
// 所有斷言影子字串的地方都會看時間臉色。整份測試釘死在正午（投射影為 0，
// 就是原本那圈腳下影子），第 31 組要驗日照時再自己改 sunTime
CONFIG.sunTime = 12;

// 季節同理，預設是「跟著本機時鐘的月份」——八月跑測試會飄綠葉、十二月飄雪，
// 落下物的張數與圖案都會隨著跑測試的月份變。整份測試釘死成 'off'，
// 第 44 組要驗季節時再自己開
CONFIG.season = 'off';

// 照 HTML 的載入順序逐檔執行主程式——跟瀏覽器一樣一個檔案一個 script，
// 跨檔的載入順序問題（load 時就呼叫後面檔案的東西）在這裡會直接炸
for (const f of jsFiles) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: srcUrl(f) });
}
// 把要測的東西掛到 globalThis：頂層 let/const/class 活在同一個
// global lexical scope（與瀏覽器的傳統 <script> 一致），跨檔拿得到
vm.runInContext(
    'globalThis.__T = { Pokemon, buildBubbleFrame, getEmoteURI, EMOTE_ICONS, EMOTE_PALETTE, CONFIG, fallbackSizeScale, QUERY_PARAMS, initGround, buildGroundTexture, GROUND_THEMES, Cameo, scheduleFlyby, spawnFlyby, cameos, pokemons, remoteStamps, throwBerry, updateBerries, feedingBusy, removeBerry, BERRY_ART, BERRY_PALETTE, getBerries: () => berries, Snatcher, updateSnatch, getSnatch: () => activeSnatch, getPending: () => pendingSnatch, resolveTheme, initWeather, THEME_WEATHER, updateBerryShadow, sun, refreshSun, updateSun, setSunOvercast, sunShadowTransform, sunHours, parseTimeParam, BERRY_SHADOW_W, SUN_TICK_MS, applyQueryOverrides, groundSurface, attachReflection, reflectTransform, reflectStrength, SPRITE_FOOT_GAP, nightLevel, deepNightLevel, updateNight, buildNight, getNightEl: () => nightEl, NIGHT_TICK_MS, NIGHT_GLOW_RISE, POKE_TYPE_NAMES, NOCTURNAL_TYPES, typePool, rangePool, sampleUnique, nightBias, pickRoster, pickOne, pokeName, attachNametag, sleepiness, circadianScale, idleChanceNow, idleTimeScale, moveScale, hopScale, idleJumpChanceNow, greetChanceNow, moodChanceNow, sleepEmoteChance, gameLoop, seasonForMonth, seasonNow, initSeason, buildSeason, updateSeason, getSeasonURI, SEASONS, SEASON_TICK_MS, getSeasonEl: () => seasonEl };',
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
// 唯一還在這裡驗的設定值：sizeTiers 是巢狀陣列、沒有對應的 URL 參數，
// 所以文件同步檢查（只掃白名單裡的參數）碰不到它，而下面一整串體型、
// 對話框倍率、保底值的斷言全部建立在這張表的形狀上
group('1. sizeTiers 體型分級表（文件同步檢查唯一碰不到的設定）');
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

group("5. top 擺位：置中於頭頂（尾巴用預設朝向）");
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

group('7. 非色違：登場不冒泡，被戳才有反應');
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
group('9. 體型分級（baseSize × sizeTiers → sprite 高度與對話框倍率）');
{
    const p = newPokemon(143, { scale: 1 });
    check('大體型 sprite 高度 = 128px', p.img.style.height === '128px');
    const s = newPokemon(25, { scale: 0.6 });
    check('小體型 sprite 高度 = 77px', s.img.style.height === '77px', s.img.style.height);
    check('小體型的對話框倍率仍是整數 2x', s.bubbleScale === 2);
    check('大體型的對話框倍率 3x', p.bubbleScale === 3);
}

// =========================================================
group('10. 色違星星特效（10 顆、飛散半徑、不會被底邊裁掉）');
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
group('11. 保底值都跟著設定走（查不到身高 / config 缺 key）');
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
}

// =========================================================
group('14. bubbleSideGap：side 對話框的左右空隙');
CONFIG.bubblePosition = 'side';
{
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
}

// =========================================================

// =========================================================
// 這一組接手原本「bubbleSideGap 的 URL 參數白名單」那個編號。
// 一參數一項的寫法只顧得到十幾個「當時剛加的」參數，剩下五十幾個漏著也沒人知道；
// 改成掃過整張表，之後新增參數自動納管、不必再補測試。
// 至於「文件寫的範圍與預設值對不對得上」，由 test/params-doc.test.js 全面比對
group('16. URL 參數白名單的完整性（整張表一起掃）');
{
    const entries = Object.entries(T.QUERY_PARAMS);
    const TYPES = ['int', 'float', 'enum', 'time'];
    const names = arr => arr.map(([n]) => n).join(', ');
    check(`白名單解析出 ${entries.length} 個參數（表沒有被截斷）`, entries.length > 60,
        String(entries.length));

    const badType = entries.filter(([, sp]) => !TYPES.includes(sp.type));
    check(`型別都是 ${TYPES.join(' / ')} 之一`, badType.length === 0, names(badType));

    const badPath = entries.filter(([, sp]) => !Array.isArray(sp.path) || !sp.path.length);
    check('每個都有取值路徑 path', badPath.length === 0, names(badPath));

    // path 打錯字最陰險：參數收得下、範圍也驗得過，寫進去的卻是 config 裡
    // 沒人讀的新 key——功能安靜地不生效，而且完全不會報錯。
    // 所以每條 path 都必須落在 config.js 已經存在的欄位上（巢狀的也要走得到）
    const badTarget = entries.filter(([, sp]) => {
        let node = CONFIG;
        for (const k of sp.path.slice(0, -1)) node = node?.[k];
        return !node || !(sp.path[sp.path.length - 1] in node);
    });
    check('path 都指向 config.js 真的有的欄位（打錯字會靜靜失效）',
        badTarget.length === 0, names(badTarget));

    const badRange = entries.filter(([, sp]) => sp.type !== 'enum'
        && (typeof sp.min !== 'number' || typeof sp.max !== 'number' || sp.min >= sp.max));
    check('數值型都有 min < max（夾範圍與調校台的拉桿都靠它）',
        badRange.length === 0, names(badRange));

    // 收值時會先 toLowerCase 再比對，允許值裡混進大寫就永遠對不上
    const badValues = entries.filter(([, sp]) => sp.type === 'enum'
        && (!Array.isArray(sp.values) || !sp.values.length
            || sp.values.some(v => typeof v !== 'string' || v !== v.toLowerCase())));
    check('enum 的允許值都是非空的小寫字串清單', badValues.length === 0, names(badValues));
}

// =========================================================
group('17. theme 主題地面');
{
    const spec = T.QUERY_PARAMS?.theme;
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
    // 抬高量不當判準：預設 6px 下草地的踩入深度吃滿高度，抬高本來就是 0
    const beforeRand = appEl.children.length;
    T.initGround('random');
    check("theme='random' 抽到地形 → 正常鋪（#ground 進場）",
        appEl.children.length === beforeRand + 1
        && appEl.children[appEl.children.length - 1].id === 'ground');
    Math.random = () => 0.999; // → 7 → 池子最後一格 'none'
    const beforeNone = appEl.children.length;
    check("theme='random' 也抽得到無地板（抬高 0、不鋪元素）",
        T.initGround('random') === 0 && appEl.children.length === beforeNone);
    Math.random = origRandom;
    check("'random' 不是地形定義（靠 initGround 解析，不靠查表）",
        T.GROUND_THEMES.random === undefined);

    // 鋪草地：元素進場、抬高量 = 地面高度 - 踩入深度 × 倍率
    // 預設 6px = 3 列的最小畫布；草的踩入深度（inset 3 × 2px）吃滿高度 → 抬高 0
    const thinLift = T.initGround('grass');
    const thin = appEl.children[appEl.children.length - 1];
    check('預設 6px → 地面高 6px、貼地站在草叢裡（抬高 0）',
        thin.style.height === '6px' && thinLift === 0,
        `height=${thin.style.height} lift=${thinLift}`);
    // 機制驗證固定用 12px：列數夠多，中段的斑點分佈與抬高量才驗得出來
    CONFIG.themeHeight = 12;
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
    CONFIG.themeHeight = 6; // 還原預設，別讓機制驗證用的 12 洩漏到其他組
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

    // 白名單的下限不是預設值，是「使用者最低只能設到這裡」的地板。
    // 文件同步檢查只比對文件與白名單一不一致，比不出這塊地板被拆掉
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
    // 另外兩層機率也一併釘死：這一組只想驗「分頁看不見時不生東西」。
    // 放任它們的話，5% 的機率會抽到「傳說池」——而主 sandbox 刻意沒有
    // POKE_LEGENDARY（見上一組的斷言），抽到就直接 return 不生客串，
    // 於是每幾百輪就冒一次莫名的紅燈
    const savedLegend = CONFIG.flybyLegendaryChance;
    const savedDelivery = CONFIG.flybyDeliveryChance;
    CONFIG.flybyLegendaryChance = 0;
    CONFIG.flybyDeliveryChance = 0;
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
    CONFIG.flybyLegendaryChance = savedLegend;
    CONFIG.flybyDeliveryChance = savedDelivery;
    delete sandbox.window.POKE_FLYING;

    // =====================================================
    group('21. postMessage 遙控');

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

    // 果實點陣圖
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
    check('發現的當下停下手邊的事、原地跳一下（驚訝定格開始）',
        near.jumpV > 0 && near.seekStartle > 0);

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

    // 驚訝定格：跳一下的期間站在原地，定格走完才起跑
    const seekX0 = near.x;
    near.update(16, T.pokemons);
    check('驚訝定格中原地不動（先跳完這一下）', near.x === seekX0);
    for (let i = 0; i < 60 && near.seekStartle > 0; i++) near.update(16, T.pokemons);
    near.update(16, T.pokemons);
    check('定格走完 → 朝果實方向小跑（面向右、往右移）',
        near.direction === 1 && near.x > seekX0);
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
        // 名字一併給：串接方要做陣容面板不必自己再備一張對照表
        check('回報每隻的 id / 名字 / 色違 / 體型', JSON.stringify(rep?.roster) === JSON.stringify([
            { id: 25, name: '皮卡丘', shiny: false, size: 0.6 },
            { id: 143, name: '卡比獸', shiny: true, size: 1 },
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
        check('追果實中被抓走 → 果實留在原地、主權不放、驚訝定格作廢',
            d.state === 'HELD' && d.targetBerry === kept
            && T.getBerries().length === 1 && kept.feeder === d
            && d.seekStartle === 0);
        move(660, 150);
        check('拖著走的期間果實也還在', T.getBerries().length === 1);
        up();
        check('放手 → 直接回去續追（不再冒驚嘆號、也不再定格，牠可沒忘記）',
            d.state === 'SEEK_BERRY' && d.targetBerry === kept
            && d.bubble.style.display === 'none' && d.seekStartle === 0);
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
        check('嚇得原地跳一下（換黑線前的肢體語言）',
            witness.jumpV > 0 || witness.jumpY > 0);
        check('果實變無主（不會被任何隻接手）', sb.feeder === null
            && witness.targetBerry === null);
        check('其他成員照常散步（世界不為一顆果實停下來）', other.state === 'WALKING');

        // 賊鳥的進場幾何與速度（預設倍率：俯衝 1.6、遠走 1.8）
        check('從果實那一側的畫面外進場（右半邊 → 右側、面向左）',
            s.x > 1920 && s.direction === -1, `x=${s.x}`);
        // 進場高度改用 startBottom：bottom 是「現在的」高度，而 updateSnatch
        // 建好賊鳥之後會在同一個 tick 就推牠一幀（見 js/snatch.js 結尾），
        // 起始高度剛好抽在帶子下緣時，讀 bottom 就會掉出帶子外——
        // 每一兩百輪偶發一次紅燈的真正原因。startBottom 是進場那一刻的存檔
        check('進場高度在客串的飛行高度帶（視窗高 45%~75%）',
            s.startBottom >= 90 && s.startBottom <= 150, `startBottom=${s.startBottom}`);
        check('進場後就開始往下俯衝了（bottom 已經比進場點低）',
            s.bottom <= s.startBottom, `${s.bottom} vs ${s.startBottom}`);
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
        while (witness.state !== 'EATING' && guard++ < 100) {
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
        for (let i = 0; i < 100 && eater.state !== 'EATING'; i++) eater.update(16, T.pokemons);
        check('（前置）站在果實旁開吃', eater.state === 'EATING');
        let bitten = false;
        for (let i = 0; i < 100 && eater.state === 'EATING'; i++) {
            eater.update(16, T.pokemons);
            if (b.shadow.style.transform === 'translateX(-50%) scale(0.720)') bitten = true;
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
            // 選擇器現在是「#weather, #season」（落下物一起收），所以只認前半段
            /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?#weather[^{]*\{\s*display:\s*none/.test(html));

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

    // =====================================================
    group('31. 日照與影子（跟著真實時間走的投射影）');
    {
        const near = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;
        const savedSunShadow = CONFIG.sunShadow;
        const savedRise = CONFIG.sunrise;
        const savedSet = CONFIG.sunset;
        const savedStretch = CONFIG.shadowStretch;
        const savedAmbient = CONFIG.ambientShadow;
        const savedOvercast = CONFIG.overcastShadow;
        const at = h => { CONFIG.sunTime = h; T.refreshSun(); };

        // ---- 載入順序與 auto 這個特例 ----
        check('sun.js 在載入清單裡，且排在用到它的 pokemon.js 之前',
            jsFiles.includes('js/sun.js')
            && jsFiles.indexOf('js/sun.js') < jsFiles.indexOf('js/pokemon.js'));
        check('只有 sunTime 收 auto（日出日落沒有「跟著時鐘」這種值）',
            T.QUERY_PARAMS.sunTime.auto === true
            && !T.QUERY_PARAMS.sunrise.auto && !T.QUERY_PARAMS.sunset.auto);

        // ---- 時間字串的解析 ----
        check("parseTimeParam：'17:30' → 17.5", T.parseTimeParam('17:30') === 17.5);
        check("parseTimeParam：'6' → 6、'17.5' → 17.5",
            T.parseTimeParam('6') === 6 && T.parseTimeParam('17.5') === 17.5);
        check("parseTimeParam：分鐘超過 59 不收（'12:60'）", Number.isNaN(T.parseTimeParam('12:60')));
        check("parseTimeParam：看不懂就 NaN（'黃昏'）", Number.isNaN(T.parseTimeParam('黃昏')));

        // ---- 讀本機時鐘 ----
        CONFIG.sunTime = null;
        const wall = T.sunHours();
        check('sunTime = null → 讀觀看端的本機時鐘（0 ~ 24 的小數）',
            wall >= 0 && wall < 24, `sunHours()=${wall}`);
        check('釘死 sunTime 就不看時鐘', (CONFIG.sunTime = 17.5, T.sunHours() === 17.5));

        // ---- 幾何：一天的走勢 ----
        at(12);
        check('正午：沒有投射影，就是原本那圈腳下影子（最深）',
            T.sun.stretch === 1 && T.sun.alpha === 1);
        at(9);
        check('上午 09:00（45 度）：影子倒向左邊、長度 2 倍',
            T.sun.dir === -1 && T.sun.stretch === 2, `dir=${T.sun.dir} stretch=${T.sun.stretch}`);
        check('上午的影子比正午淡（直射光還沒到最強）', near(T.sun.alpha, 0.868));
        at(15);
        check('下午 15:00（135 度）：改倒向右邊，長度與上午對稱',
            T.sun.dir === 1 && T.sun.stretch === 2);
        at(7);
        check('越接近地平線影子越長（07:00 已頂到 shadowStretch 的 3 倍）',
            T.sun.stretch === 3);
        check('也越淡（07:00 的濃度低於 09:00）', near(T.sun.alpha, 0.666));

        // ---- 兩端：日出日落與夜晚 ----
        at(6);
        check('日出 06:00（0 度）：沒有投射影，只剩接地影',
            T.sun.dir === 0 && T.sun.stretch === 1 && T.sun.alpha === 0.55);
        at(18);
        check('日落 18:00（180 度）：同樣沒有投射影', T.sun.stretch === 1 && T.sun.alpha === 0.55);
        at(3);
        check('夜晚：接地影留著（立體感不掉），投射影歸零',
            T.sun.stretch === 1 && T.sun.alpha === 0.55);
        at(6.05); // 06:03，日出後三分鐘
        check('日出前後是連續的（不會憑空跳出一道長影）',
            T.sun.stretch > 1 && T.sun.stretch < 1.3, `stretch=${T.sun.stretch}`);
        at(23.9);
        check('跨到隔天之前都還是夜晚', T.sun.stretch === 1 && T.sun.alpha === 0.55);

        // ---- ambientShadow：夜晚要留多少 ----
        CONFIG.ambientShadow = 0;
        at(3);
        check('ambientShadow = 0 → 夜晚完全沒有影子（原始規格）', T.sun.alpha === 0);
        at(12);
        check('ambientShadow = 0 也不影響正午（直射光那份是滿的）', T.sun.alpha === 1);
        CONFIG.ambientShadow = savedAmbient;

        // ---- shadowStretch：最長拉多長 ----
        CONFIG.shadowStretch = 1;
        at(7);
        check('shadowStretch = 1 → 只有濃淡變化，完全不拉長',
            T.sun.stretch === 1 && T.sun.alpha < 1);
        CONFIG.shadowStretch = 5;
        at(7);
        check('shadowStretch = 5 → 同一時刻拉得更長', near(T.sun.stretch, 4.732));
        CONFIG.shadowStretch = savedStretch;

        // ---- sunrise / sunset：自訂日照區間 ----
        CONFIG.sunrise = 8; CONFIG.sunset = 16;
        at(12);
        check('日照區間改成 08:00 ~ 16:00 → 正午仍是最短最深',
            T.sun.stretch === 1 && T.sun.alpha === 1);
        at(7);
        check('區間外就是夜晚（07:00 已在 sunrise 之前）', T.sun.alpha === 0.55);
        CONFIG.sunrise = savedRise; CONFIG.sunset = savedSet;

        // ---- 陰天：打散不是關掉 ----
        check('會遮光的天氣 = 雨/雪/風沙，熔岩的火星不算',
            ['rain', 'snow', 'sand'].every(k => Object.values(T.THEME_WEATHER).includes(k))
            && Object.values(T.THEME_WEATHER).includes('ember'));
        T.setSunOvercast('rain');
        at(9);
        check('雨天：影子還在，但變短（2 倍 → 1.35 倍）', near(T.sun.stretch, 1.35));
        check('雨天：也變淡，但不是消失', T.sun.alpha > 0.55 && T.sun.alpha < 0.868);
        T.setSunOvercast('snow');
        check('雪天同樣打折', near(T.sun.stretch, 1.35));
        T.setSunOvercast('ember');
        check('熔岩的火星不打折（沒有東西擋住光）', T.sun.stretch === 2);
        T.setSunOvercast(null);
        check('沒有天氣 → 不打折', T.sun.stretch === 2);

        // ---- 總開關 ----
        CONFIG.sunShadow = 'off';
        at(7);
        check("sunShadow = 'off' → 白天回到單純的腳下影子",
            T.sun.stretch === 1 && T.sun.alpha === 1);
        at(3);
        check("sunShadow = 'off' → 夜晚也不壓暗（完全等於沒有這套機制）",
            T.sun.stretch === 1 && T.sun.alpha === 1);
        CONFIG.sunShadow = savedSunShadow;

        // ---- transform 字串 ----
        at(12);
        check('沒有投射影時，字串跟原本一模一樣（不留 scaleX 尾巴）',
            T.sunShadowTransform(40, 0.5) === 'translateX(-50%) scale(0.500)');
        at(9);
        const t9 = T.sunShadowTransform(40, 1);
        check('有投射影時：往反側推 + 拉長',
            t9 === 'translateX(-50%) translateX(-20.0px) scale(1.000) scaleX(2)', t9);
        const off9 = Number(t9.match(/translateX\((-?[\d.]+)px\)/)[1]);
        check('貼著腳的那一端不動，只有另一端往外長',
            near(off9 + 40 * T.sun.stretch / 2, 40 / 2), `off=${off9}`);
        at(15);
        const t15 = T.sunShadowTransform(40, 1);
        check('下午往另一邊推', /translateX\(20\.0px\)/.test(t15), t15);

        // ---- 真的接到寶可夢與果實身上 ----
        at(9);
        const sp = newPokemon(25, { scale: 1 });
        sp.updateDOM();
        check('寶可夢的影子吃到太陽（拉長 + 濃度）',
            sp.shadow.style.transform.includes(`scaleX(${T.sun.stretch})`)
            && near(Number(sp.shadow.style.opacity), T.sun.alpha),
            sp.shadow.style.transform);
        check('推的量依自己的影子寬度算（大隻的推得多）',
            sp.shadowW === Math.round(48 + 8)
            && sp.shadow.style.transform.includes(`translateX(${(-sp.shadowW / 2).toFixed(1)}px)`),
            `shadowW=${sp.shadowW}`);

        check('BERRY_SHADOW_W 與 .berry-shadow 的 CSS 寬度一致',
            new RegExp(`\\.berry-shadow\\s*\\{[^}]*width:\\s*${T.BERRY_SHADOW_W}px`).test(html));
        T.getBerries().slice().forEach(b => T.removeBerry(b));
        T.pokemons.length = 0;
        const holder = newPokemon(25, { scale: 0.6 });
        holder.x = 900;
        T.pokemons.push(holder);
        check('（前置）丟一顆果實在地上', T.throwBerry(960, 0) === true);
        const bs = T.getBerries()[0];
        T.updateBerries(16);
        check('果實的影子也跟著同一顆太陽',
            bs.shadow.style.transform.includes(`scaleX(${T.sun.stretch})`),
            bs.shadow.style.transform);
        at(15);
        T.updateBerries(16);
        check('落地不代表定格：太陽走了影子就換邊（逐幀重算）',
            /translateX\(\d/.test(bs.shadow.style.transform), bs.shadow.style.transform);
        bs.bite = 0.72;
        T.updateBerries(16);
        check('咬痕與太陽疊在一起（縮小的同時仍然拉長）',
            bs.shadow.style.transform.includes('scale(0.720)')
            && bs.shadow.style.transform.includes('scaleX('), bs.shadow.style.transform);
        T.removeBerry(bs);
        T.pokemons.length = 0;

        // ---- 節流 ----
        at(12);
        T.updateSun(T.SUN_TICK_MS); // 開場第一幀本來就會算一次，先把節流歸零
        CONFIG.sunTime = 9; // 直接改時間但不 refresh：等 gameLoop 自己追上
        T.updateSun(16);
        check('每一幀不重算（0.25 度/分，2 秒一次綽綽有餘）', T.sun.stretch === 1);
        T.updateSun(T.SUN_TICK_MS);
        check('累積到間隔就重算', T.sun.stretch === 2);

        CONFIG.overcastShadow = savedOvercast;
        CONFIG.sunTime = 12;
        T.setSunOvercast(null);
    }

    // =====================================================
    group('32. 陣容（team 主題隊伍 / nightRoster 夜行偏好）');
    {
        const savedSearch = sandbox.location.search;
        const savedTypes = sandbox.window.POKE_TYPES;
        const savedSubtypes = sandbox.window.POKE_SUBTYPES;
        const savedTeam = CONFIG.team;
        const savedRoster = CONFIG.nightRoster;
        // applyQueryOverrides 會就地改寫傳進去的設定，所以每次都給它一份影本，
        // 別把整份測試共用的 CONFIG 弄髒（sizeTiers 的 Infinity 在這裡用不到）
        const run = search => {
            sandbox.location.search = search;
            const cfg = JSON.parse(JSON.stringify(CONFIG));
            T.applyQueryOverrides(cfg);
            return cfg;
        };

        // 全域的假對照表只有兩筆（給影子染色用），這一組要真的抽名單，
        // 換一張夠用的：火 3 隻、水 2 隻、幽靈 3 隻、惡 2 隻
        sandbox.window.POKE_TYPES = {
            4: 'fire', 5: 'fire', 6: 'fire',
            7: 'water', 8: 'water',
            25: 'electric', 143: 'normal',
            92: 'ghost', 93: 'ghost', 94: 'ghost',
            197: 'dark', 198: 'dark',
        };
        // 副屬性是稀疏表，只有雙屬性的才在裡面。這裡刻意鋪出三種關鍵情形：
        //   6  火/飛行  → team=flying 要抓得到（主屬性表裡牠是火）
        //   94 幽靈/毒  → 主屬性已經是幽靈，副屬性不該讓牠被算兩次
        //   248 岩/惡   → 主屬性表沒有這個編號，只有副屬性是惡：
        //                 team=dark 要抓得到，夜行池「不」該抓到（只認主屬性）
        sandbox.window.POKE_SUBTYPES = {
            6: 'flying', 94: 'poison', 12: 'flying', 248: 'dark', 479: 'ghost',
        };

        check('十八種屬性一個不少', T.POKE_TYPE_NAMES.length === 18);
        check('屬性名就是對照表的值域（抽樣比對）',
            ['normal', 'fire', 'ghost', 'dark', 'fairy', 'steel']
                .every(t => T.POKE_TYPE_NAMES.includes(t)));
        check('夜行系 = 幽靈 + 惡（原作沒有「夜行」這個屬性）',
            JSON.stringify(T.NOCTURNAL_TYPES) === '["ghost","dark"]');

        // ---- typePool：名單本身 ----
        check('typePool 只挑出該屬性的編號',
            JSON.stringify(T.typePool(['fire'], 1, 649)) === '[4,5,6]');
        // 248（岩/惡）與 479（電/幽靈）是靠副屬性進來的
        check('typePool 吃得下多個屬性，並且照編號排序',
            JSON.stringify(T.typePool(['ghost', 'dark'], 1, 649)) === '[92,93,94,197,198,248,479]');
        check('同一組屬性只認主屬性時就少了那兩隻',
            JSON.stringify(T.typePool(['ghost', 'dark'], 1, 649, 'primary')) === '[92,93,94,197,198]');
        check('typePool 尊重 minId / maxId',
            JSON.stringify(T.typePool(['ghost', 'dark'], 1, 151)) === '[92,93,94]');
        check('該範圍沒有那個屬性就是空名單（惡屬性要到第二世代才有）',
            T.typePool(['dark'], 1, 151).length === 0);

        // ---- typePool：主屬性 vs 主副都算 ----
        check('預設兩槽都算：副屬性是飛行的也抓得到（噴火龍是火/飛行）',
            JSON.stringify(T.typePool(['flying'], 1, 649)) === '[6,12]');
        check('slots=primary 只認主屬性：飛行系一個都抓不到',
            T.typePool(['flying'], 1, 649, 'primary').length === 0);
        check('主屬性就命中的不會被算兩次（94 幽靈/毒 只出現一次）',
            T.typePool(['ghost', 'poison'], 1, 649).filter(id => id === 94).length === 1);
        check('主屬性表沒收、只有副屬性命中的也抓得到（248 岩/惡）',
            T.typePool(['dark'], 1, 649).includes(248));
        check('slots=primary 抓不到只有副屬性命中的（248 主屬性是岩）',
            !T.typePool(['dark'], 1, 649, 'primary').includes(248));
        // 副屬性表沒載到也不能炸（獨立檔案，可能被拿掉）
        sandbox.window.POKE_SUBTYPES = undefined;
        check('副屬性表沒載到 → 自動退回只看主屬性，不報錯',
            JSON.stringify(T.typePool(['fire'], 1, 649)) === '[4,5,6]'
            && T.typePool(['flying'], 1, 649).length === 0);
        sandbox.window.POKE_SUBTYPES = { 6: 'flying', 94: 'poison', 12: 'flying', 248: 'dark', 479: 'ghost' };

        // ---- sampleUnique：抽選不重複、不卡死 ----
        const ten = T.sampleUnique([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
        check('sampleUnique 抽出要求的數量', ten.length === 4);
        check('sampleUnique 抽出來的不重複', new Set(ten).size === 4);
        check('sampleUnique 抽出來的都在名單內', ten.every(id => id >= 1 && id <= 10));
        check('名單比要的少 → 給得出多少就多少（不會卡在湊不滿的迴圈）',
            T.sampleUnique([1, 2], 5).length === 2);
        check('sampleUnique 排除 taken 裡的',
            T.sampleUnique([1, 2, 3], 3, new Set([2])).every(id => id !== 2));

        // ---- team 參數解析 ----
        check('team=fire → 只抽火屬性', JSON.stringify(run('?team=fire').team) === '["fire"]');
        check('team 大小寫、前後空白都容忍',
            JSON.stringify(run('?team=%20FIRE%20').team) === '["fire"]');
        check('team=ghost,dark → 逗號並列多個屬性',
            JSON.stringify(run('?team=ghost,dark').team) === '["ghost","dark"]');
        check('team 重複的屬性只留一份',
            JSON.stringify(run('?team=fire,fire').team) === '["fire"]');
        check('team 裡打錯的屬性名逐一剔除，剩下的照用',
            JSON.stringify(run('?team=fire,notatype').team) === '["fire"]');
        check('team 全部打錯 → 當作沒帶（回到不限屬性）',
            run('?team=notatype').team === null);
        check('沒帶 team → 維持設定檔的預設', run('?count=2').team === CONFIG.team);

        // ---- team 與 count 的合理性修正 ----
        check('count 超過該屬性的名單長度 → 夾到名單長度（火只有 3 隻）',
            run('?team=fire&count=10').count === 3);
        check('count 沒超過就不動', run('?team=fire&count=2').count === 2);
        check('名單是空的就不動 count（抽選那端會退回全範圍）',
            run('?team=dark&maxId=151&count=6').count === 6);
        check('ids 指定時 team 不參與夾 count（固定清單優先）',
            run('?team=fire&ids=25,133,143').count === 3);
        // 夾 count 用的名單也要算副屬性，否則會夾得比實際抽得到的還少
        check('夾 count 的名單也算副屬性（飛行有 6、12 兩隻）',
            run('?team=flying&count=6').count === 2);
        check('惡有 197、198、248 三隻（248 只有副屬性是惡）',
            run('?team=dark&count=9').count === 3);

        // ---- pickRoster：team ----
        CONFIG.nightRoster = 0;
        CONFIG.team = ['fire'];
        const fireTeam = T.pickRoster(3, 1, 649);
        check('pickRoster 照 team 抽（全員都是火屬性）',
            fireTeam.length === 3 && fireTeam.every(id => [4, 5, 6].includes(id)),
            JSON.stringify(fireTeam));
        CONFIG.team = 'fire'; // config.js 手寫成字串也算一種屬性
        check('team 寫成單一字串也認得（不會被拆成四個字母）',
            T.pickRoster(2, 1, 649).every(id => [4, 5, 6].includes(id)));
        CONFIG.team = ['dark'];
        const impossible = T.pickRoster(3, 1, 151);
        check('team 在該範圍抽不到東西 → 退回全範圍隨機（而不是生不出來）',
            impossible.length === 3 && impossible.every(id => id >= 1 && id <= 151),
            JSON.stringify(impossible));
        // team 抽選要吃副屬性：飛行系的兩隻都是「主屬性不是飛行」的
        CONFIG.team = ['flying'];
        const flyTeam = T.pickRoster(2, 1, 649);
        check('team=flying 抽得到副屬性才是飛行的（噴火龍 6、巴大蝶 12）',
            flyTeam.length === 2 && flyTeam.every(id => [6, 12].includes(id)),
            JSON.stringify(flyTeam));
        CONFIG.team = null;

        // ---- pickRoster：夜行偏好 ----
        const savedSunTime = CONFIG.sunTime;
        CONFIG.nightRoster = 1; // 全中，才能斷言「整批都是夜行系」
        CONFIG.sunTime = 12;
        check('白天不偏抽（深夜濃度 0 → nightBias 0）', T.nightBias() === 0);
        const noon = T.pickRoster(4, 1, 649);
        check('白天抽出來的還是全範圍', noon.length === 4);

        // 23:00 天早就黑了（星空亮著），但陣容看的是「深夜窗口」而不是天色，
        // 預設要到 00:00 才開始偏抽。這一條就是 0.47 那次調整的分界線——
        // 傍晚天剛黑就整批換成幽靈太急，那時候的活動力還照白天
        CONFIG.sunTime = 23;
        check('天黑了但還沒夜深 → 不偏抽（陣容看深夜窗口，不看天色）',
            T.nightLevel() === 1 && T.nightBias() === 0,
            `夜色 ${T.nightLevel()} / bias ${T.nightBias()}`);
        CONFIG.sunTime = 3;
        check('深夜的 nightBias 就是 nightRoster', T.nightBias() === 1);
        const midnight = T.pickRoster(4, 1, 649);
        check('nightRoster=1 的深夜 → 整批都是夜行系',
            midnight.length === 4 && midnight.every(id => [92, 93, 94, 197, 198].includes(id)),
            JSON.stringify(midnight));
        // 這一條是刻意的不對稱：team 吃副屬性，夜行「只」認主屬性槽。
        // 248（岩/惡）與 479（電/幽靈）的副屬性都在夜行名單上，但主屬性不是，
        // 所以夜行池不該收牠們——把這條改壞了，晚上就會混進班基拉斯與洛托姆
        // count 刻意不超過夜行名單長度（5 隻），這樣就完全不會走「補齊」那條路
        // ——補齊是正常的全範圍隨機，248 出現在那裡並不算破功
        const many = [];
        for (let i = 0; i < 30; i++) many.push(...T.pickRoster(4, 1, 649));
        check('夜行只認主屬性：248（岩/惡）不會被當成夜行系抽進來',
            !many.includes(248), `出現 ${many.filter(id => id === 248).length} 次`);
        check('夜行只認主屬性：479（電/幽靈）也不會',
            !many.includes(479), `出現 ${many.filter(id => id === 479).length} 次`);

        CONFIG.nightRoster = 0;
        check('nightRoster=0 → 就算是深夜也不偏抽', T.nightBias() === 0);

        // 夜行名單比要的數量少：不夠的照全範圍補齊，總數還是對的
        CONFIG.nightRoster = 1;
        const short = T.pickRoster(8, 1, 649);
        check('夜行名單不夠（只有 5 隻）→ 其餘照全範圍補到 8 隻',
            short.length === 8 && new Set(short).size === 8,
            JSON.stringify(short));
        check('補齊的部分不會跟夜行系那幾隻重複', new Set(short).size === short.length);

        // 夜行名單在這個範圍是空的：整個機制安靜地讓路
        const noNocturnal = T.pickRoster(3, 1, 91);
        check('該範圍沒有夜行系 → 照全範圍抽，不報錯也不少人',
            noNocturnal.length === 3 && noNocturnal.every(id => id >= 1 && id <= 91));

        // team 與 nightRoster 同時開：明講的 team 贏
        CONFIG.team = ['fire'];
        const both = T.pickRoster(3, 1, 649);
        check('team 與夜行偏好同時開 → team 為準（明講的意圖優先）',
            both.every(id => [4, 5, 6].includes(id)), JSON.stringify(both));
        CONFIG.team = null;

        // pickOne：遙控 join 補人走同一條路
        check('pickOne 也吃夜行偏好', [92, 93, 94, 197, 198].includes(T.pickOne(1, 649)));
        CONFIG.nightRoster = 0;
        const one = T.pickOne(1, 649);
        check('pickOne 回傳單一個合法編號', Number.isInteger(one) && one >= 1 && one <= 649);

        // 出生跑道 = index，所以順序必須是洗過的（照批次排會讓夜行系擠在同一側）
        CONFIG.nightRoster = 0.5;
        CONFIG.sunTime = 23;
        let sorted = 0;
        for (let i = 0; i < 40; i++) {
            const batch = T.pickRoster(6, 1, 649);
            const asc = batch.every((id, idx) => idx === 0 || batch[idx - 1] <= id);
            if (asc) sorted++;
        }
        check('回傳的順序是洗過的（40 批裡不會每批都照編號排）', sorted < 40, `${sorted}/40 批是升冪`);

        CONFIG.sunTime = savedSunTime;
        CONFIG.team = savedTeam;
        CONFIG.nightRoster = savedRoster;
        sandbox.window.POKE_TYPES = savedTypes;
        sandbox.window.POKE_SUBTYPES = savedSubtypes;
        sandbox.location.search = savedSearch;
    }

    // =====================================================
    group('33. 夜晚演出（星空 / 螢火蟲 / 地面光暈）');
    {
        const savedSunTime = CONFIG.sunTime;
        const savedNight = CONFIG.night;
        const savedStars = CONFIG.nightStars;
        const savedFlies = CONFIG.nightFireflies;
        const savedGlow = CONFIG.nightGlow;
        const savedFade = CONFIG.nightFade;
        const savedThemeHeight = CONFIG.themeHeight;

        // ---- nightLevel：幾點算晚上、有多黑 ----
        const at = h => { CONFIG.sunTime = h; return T.nightLevel(); };
        CONFIG.sunrise = 6;
        CONFIG.sunset = 18;
        CONFIG.nightFade = 60; // 一小時漸暗，換算好對
        check('正午是白天（夜色 0）', at(12) === 0);
        check('日出那一刻剛好歸零', at(6) === 0);
        check('日落那一刻還是白天（暮光是日落「之後」才開始）', at(18) === 0);
        check('日落後半小時 = 半暗', Math.abs(at(18.5) - 0.5) < 1e-9);
        check('日落後一小時 = 全黑', at(19) === 1);
        check('深夜維持全黑', at(23) === 1 && at(2) === 1);
        check('日出前半小時 = 半暗（反向漸亮）', Math.abs(at(5.5) - 0.5) < 1e-9);
        check('跨過午夜不必特判（00:30 仍是全黑）', at(0.5) === 1);
        CONFIG.nightFade = 0;
        check('nightFade=0 → 日落後直接入夜，沒有漸變',
            at(18.01) === 1 && at(18) === 0);
        CONFIG.nightFade = 45;
        check('預設 45 分鐘：日落後 45 分整全黑', at(18.75) === 1);
        check('預設 45 分鐘：日落後 15 分是三分之一', Math.abs(at(18.25) - 1 / 3) < 1e-9);
        // 日出晚於日落（參數顛倒）時不猜——applyQueryOverrides 已經修過一次了
        CONFIG.sunrise = 18;
        CONFIG.sunset = 6;
        check('sunrise / sunset 顛倒 → 不猜，一律當白天', at(23) === 0);
        CONFIG.sunrise = 6;
        CONFIG.sunset = 18;

        // ---- 建元素 ----
        // 前面的組別可能留下地面，先確定這裡是「沒有地面」的狀態
        T.initGround('none');
        // 白天不該建任何東西：絕大多數的頁面都是白天開的，那就是零成本
        CONFIG.sunTime = 12;
        T.updateNight(T.NIGHT_TICK_MS);
        check('白天不建夜景元素', T.getNightEl() === null);

        CONFIG.sunTime = 23;
        CONFIG.nightStars = 12;
        CONFIG.nightFireflies = 3;
        CONFIG.nightGlow = 0.5;
        T.updateNight(T.NIGHT_TICK_MS);
        const el = T.getNightEl();
        check('入夜才建元素', el !== null && el.id === 'night');
        const stars = el.children.filter(c => c.className === 'night-star');
        const flies = el.children.filter(c => c.className === 'night-firefly');
        const glows = el.children.filter(c => c.id === 'night-glow');
        check('星星照 nightStars 生成', stars.length === 12, `${stars.length} 顆`);
        check('螢火蟲照 nightFireflies 生成', flies.length === 3, `${flies.length} 隻`);
        check('螢火蟲是兩層（外層飄、內層明滅）',
            flies.every(f => f.children.length === 1));
        check('沒鋪地面就沒有地面光暈（theme=none）', glows.length === 0);
        check('整層的 opacity 就是夜色濃度', el.style.opacity === '1.000', el.style.opacity);
        check('星星撒在上半部（不壓到地面與舞台）',
            stars.every(s => parseFloat(s.style.top) < 72));
        check('每顆星星都有自己的閃爍週期與相位',
            new Set(stars.map(s => s.style.getPropertyValue('--dur')
                + s.style.getPropertyValue('--delay'))).size > 1);
        check('星星帶著靜態亮度（reduced-motion 關掉動畫時才不會全亮）',
            stars.every(s => parseFloat(s.style.opacity) > 0));
        check('螢火蟲貼近地面（bottom 46% 以內）',
            flies.every(f => parseFloat(f.style.bottom) <= 46));

        // 天亮就收起來，不是留在畫面上
        CONFIG.sunTime = 12;
        T.updateNight(T.NIGHT_TICK_MS);
        check('天亮 → 整層收起來（display: none）', T.getNightEl().hidden === true);
        CONFIG.sunTime = 23;
        T.updateNight(T.NIGHT_TICK_MS);
        check('再入夜 → 同一層拿回來用，不重建', T.getNightEl() === el);

        // 節流：不到間隔不重算
        el.style.opacity = 'x';
        T.updateNight(1);
        check('沒到 NIGHT_TICK_MS 不重算', el.style.opacity === 'x');
        T.updateNight(T.NIGHT_TICK_MS);
        check('到了間隔才重算', el.style.opacity === '1.000');

        // 黃昏：濃度介於 0 與 1 之間
        CONFIG.sunTime = 18.25; // 日落後 15 分，nightFade 45 → 1/3
        T.updateNight(T.NIGHT_TICK_MS);
        check('黃昏是慢慢浮出來的（opacity 介於 0 與 1）',
            T.getNightEl().style.opacity === '0.333', T.getNightEl().style.opacity);

        // ---- 地面光暈綁在地面上 ----
        CONFIG.themeHeight = 40;
        const lift = T.initGround('water');
        CONFIG.sunTime = 23;
        const glowEl = (() => {
            // 前一層是 theme=none 時建的（沒有光暈），重建一次才量得到
            T.getNightEl().remove();
            return T.buildNight() && T.getNightEl().children.find(c => c.id === 'night-glow');
        })();
        check('有地面時才有地面光暈', !!glowEl);
        check('光暈高度 = 地面高度 + 往上暈開的那一段',
            glowEl.style.height === `${T.groundSurface.band + T.NIGHT_GLOW_RISE}px`,
            glowEl.style.height);
        check('光暈是漸層而且上緣完全透明（不是一塊蓋住背景的色板）',
            glowEl.style.background.includes('linear-gradient')
            && glowEl.style.background.includes('0) 100%'),
            glowEl.style.background);
        void lift;
        T.initGround('none'); // 收乾淨，後面的組別不該看到地面

        // ---- 各自可以關掉 ----
        CONFIG.nightStars = 0;
        CONFIG.nightFireflies = 0;
        CONFIG.nightGlow = 0;
        T.getNightEl().remove();
        check('三樣全關 → 連容器都不建', T.buildNight() === false);

        CONFIG.sunTime = savedSunTime;
        CONFIG.night = savedNight;
        CONFIG.nightStars = savedStars;
        CONFIG.nightFireflies = savedFlies;
        CONFIG.nightGlow = savedGlow;
        CONFIG.nightFade = savedFade;
        CONFIG.themeHeight = savedThemeHeight;
    }

    // =====================================================
    group('34. 水面倒影（水域地形的鏡射）');
    {
        const savedTheme = CONFIG.theme;
        const savedHeight = CONFIG.themeHeight;
        const savedReflect = CONFIG.reflect;
        const savedOpacity = CONFIG.reflectOpacity;
        const savedWave = CONFIG.reflectWave;
        const findReflection = p => p.el.children.find(c => c.className === 'reflection');

        // ---- 載入順序與鏡射軸的前提 ----
        check('reflect.js 在載入清單裡，且排在用到它的 pokemon.js 之前',
            jsFiles.includes('js/reflect.js')
            && jsFiles.indexOf('js/reflect.js') < jsFiles.indexOf('js/pokemon.js'));
        check('腳底離容器底邊的 1px 與 CSS 對得上（鏡射軸算得準的前提）',
            T.SPRITE_FOOT_GAP === 1 && /\.sprite\s*\{[^}]*margin-bottom:\s*1px/.test(html));

        // ---- 只有會反光的地形才有倒影 ----
        CONFIG.themeHeight = 40; // 水深 40px：水面到頁面底邊都能畫
        T.initGround('water');
        check('水域：量測值 = 帶高 40、抬高 30（40 - 踩入 5×2）、會反光',
            T.groundSurface.band === 40 && T.groundSurface.lift === 30
            && T.groundSurface.reflect === 1,
            JSON.stringify(T.groundSurface));
        check('水域的反光強度 = 地形 × reflectOpacity', T.reflectStrength() === 0.35);
        T.initGround('grass');
        check('草地不反光', T.groundSurface.reflect === 0 && T.reflectStrength() === 0);
        T.initGround('none');
        check('沒有地面 → 量測值歸零',
            T.groundSurface.band === 0 && T.groundSurface.reflect === 0);

        // ---- 掛上去的三層與幾何 ----
        T.initGround('water');
        const wet = newPokemon(25);
        const wrap = findReflection(wet);
        check('水域的成員身上掛了倒影', !!wrap);
        check('外層下緣貼齊頁面底邊、上緣就是水面',
            wrap?.style.bottom === '-30px' && wrap?.style.height === '40px',
            `${wrap?.style.bottom} / ${wrap?.style.height}`);
        check('濃度吃 reflectOpacity', Number(wrap?.style.opacity) === 0.35);
        const wave = wrap?.children[0];
        check('中間層只管搖曳（水紋自己一層，不跟本體的 transform 打架）',
            wave?.className === 'reflect-wave' && wave.style.animationDuration === '2.40s');
        const mirror = wave?.children[0];
        check('最內層是鏡射的本體，圖跟本體同一張',
            mirror?.className === 'reflect-sprite' && mirror.src === wet.img.src);
        // 鏡面在水面（腳底上方 band - lift = 10px），倒影的腳落在水面上方同樣距離，
        // 再扣掉 sprite 腳底那 1px
        check('鏡射軸取水面而不是腳底（水面兩側接得起來）',
            mirror?.style.top === '-9px', mirror?.style.top);
        wet.direction = 1; // 建構時的面向是隨機的，先釘住再看
        wet.updateDOM();
        check('倒影 = 同一個面向 + Y 軸翻過來',
            mirror?.style.transform === 'scaleX(-1) scaleY(-1) translateY(0px)',
            mirror?.style.transform);

        // ---- 跟著本體走：轉向與跳躍 ----
        wet.direction = -1;
        wet.bobY = 4;
        wet.updateDOM();
        check('轉向時倒影跟著轉',
            wet.reflection.style.transform.startsWith('scaleX(1) scaleY(-1)'),
            wet.reflection.style.transform);
        check('本體升高多少，水裡的就往下沉多少',
            wet.reflection.style.transform.endsWith('translateY(-4px)'),
            wet.reflection.style.transform);
        check('倒影的位移與本體是同一個數字（只差在翻過來）',
            wet.img.style.transform.includes('translateY(-4px)'));

        // ---- 開關與水紋 ----
        CONFIG.reflectWave = 0;
        const still = newPokemon(25);
        check('reflectWave = 0 → 靜止無波的水面',
            findReflection(still)?.children[0].style.animation === 'none');
        CONFIG.reflectWave = 2;
        const fast = newPokemon(25);
        check('reflectWave = 2 → 搖得兩倍快',
            findReflection(fast)?.children[0].style.animationDuration === '1.20s');
        CONFIG.reflectWave = savedWave;

        CONFIG.reflect = 'off';
        const dry = newPokemon(25);
        check('reflect = off → 連元素都不產生', !findReflection(dry) && !dry.reflection);
        CONFIG.reflect = savedReflect;
        CONFIG.reflectOpacity = 0;
        check('reflectOpacity = 0 等同關掉', !findReflection(newPokemon(25)));
        CONFIG.reflectOpacity = savedOpacity;

        T.initGround('grass');
        check('非水域地形的成員身上沒有倒影（非水域場景成本是零）',
            !findReflection(newPokemon(25)));

        // ---- CSS 端的守則 ----
        check('倒影疊在地面之上、影子之下', /\.reflection\s*\{[^}]*z-index:\s*-2/.test(html));
        check('外層負責裁切（水面以下沒有更多空間了）',
            /\.reflection\s*\{[^}]*overflow:\s*hidden/.test(html));
        check('系統開了「減少動態效果」時水紋靜止',
            /prefers-reduced-motion[\s\S]*\.reflect-wave\s*\{\s*animation:\s*none/.test(html));

        T.initGround('none');
        CONFIG.theme = savedTheme;
        CONFIG.themeHeight = savedHeight;
        T.pokemons.length = 0;
    }

    // =====================================================
    group('35. 指令橋接（bridge.html：外部訊息來源 → 遙控指令）');
    {
        // js/bridge.js 不在 widget 的載入清單裡（它是 bridge.html 的東西），
        // 所以另外開一個乾淨的 context 跑——順便證明它不依賴 widget 的任何全域
        const bridgeBox = { console, URLSearchParams, Math, Number, JSON, Date, String, Array, Object };
        vm.createContext(bridgeBox);
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/bridge.js'), 'utf8'),
            bridgeBox, { filename: srcUrl('js/bridge.js') });
        vm.runInContext('globalThis.__B = { parseBridgeConfig, parseBridgeLine, bridgeCommand,'
            + ' bridgeMessageToCommand, makeBridgeGate, BRIDGE_CMDS };', bridgeBox);
        const B = bridgeBox.__B;
        const cfg = B.parseBridgeConfig('');
        const cmd = (text, c = cfg) => JSON.stringify(B.parseBridgeLine(text, c));

        // ---- 設定 ----
        check('預設：前綴 !、冷卻 3 秒、輪詢 3 秒、狀態列開著',
            cfg.prefix === '!' && cfg.cooldown === 3000
            && cfg.pollInterval === 3000 && cfg.status === 'on');
        check('沒帶 allow 就是全部指令都放行', cfg.allow.size === B.BRIDGE_CMDS.length);
        // Number(null) 是 0 不是 NaN——沒有這一條，每個沒帶的數字參數都會靜靜變成 0
        check('沒帶的數字參數不會被 Number(null) 吃成 0',
            B.parseBridgeConfig('?ws=x').cooldown === 3000);
        const custom = B.parseBridgeConfig('?ws=wss://x.example/s&prefix=%23&allow=feed,poke&cooldown=0&status=off&q=theme%3Dgrass%26count%3D6');
        check('來源、前綴、白名單、冷卻、狀態列都讀得到',
            custom.ws === 'wss://x.example/s' && custom.prefix === '#'
            && custom.cooldown === 0 && custom.status === 'off');
        check('白名單只留下認得的指令',
            custom.allow.size === 2 && custom.allow.has('feed') && !custom.allow.has('spawn'));
        check('q 原樣轉交給 widget（?theme=grass&count=6）', custom.query === 'theme=grass&count=6');
        check('allow 全部看不懂 → 當作沒帶（不要靜靜地全鎖）',
            B.parseBridgeConfig('?allow=nope,zzz').allow.size === B.BRIDGE_CMDS.length);
        check('輪詢間隔夾在 500 ~ 600000',
            B.parseBridgeConfig('?pollInterval=10').pollInterval === 500);
        check('hello 用 | 分隔成多行',
            JSON.stringify(B.parseBridgeConfig('?hello=A%7CB').hello) === '["A","B"]');

        // ---- 文字挑指令 ----
        check('!feed 2 → feed count 2', cmd('!feed 2') === '{"cmd":"feed","count":2}');
        check('整行包在別的協定裡也挑得出來',
            cmd(':svc-a PRIVMSG #room :今天天氣真好 !feed 2 謝謝') === '{"cmd":"feed","count":2}');
        check('沒帶數字就是不帶（widget 端自己隨機）', cmd('!feed') === '{"cmd":"feed"}');
        check('!drop = 信使鳥空投（spawn + delivery）',
            cmd('!drop') === '{"cmd":"spawn","delivery":true}');
        check('!poke 25 → 只戳皮卡丘', cmd('!poke 25') === '{"cmd":"poke","id":25}');
        check('圖鑑編號超出 1~1025 就當作沒帶', cmd('!join 9999') === '{"cmd":"join"}');
        check('不是指令的行安靜跳過', cmd('今天天氣真好') === 'null');
        check('前綴 + 不認識的字不算指令（隨便一個驚嘆號不會亂觸發）',
            cmd('!好期待') === 'null' && cmd('!!!') === 'null');
        check('沒有前綴的指令字不算數', cmd('feed 2') === 'null');
        check('自訂前綴生效',
            cmd('#feed', custom) === '{"cmd":"feed"}' && cmd('!feed', custom) === 'null');
        check('白名單外的指令不轉發', cmd('#spawn', custom) === 'null');

        // ---- 三種格式都收 ----
        const asMsg = (raw, c = cfg) => B.bridgeMessageToCommand(raw, c);
        check('JSON 指令直接照做',
            JSON.stringify(asMsg('{"cmd":"feed","count":2}').msg) === '{"cmd":"feed","count":2}');
        check('JSON 帶 text → 從 text 挑，sender 記下來算冷卻',
            asMsg('{"sender":"svc-a","text":"!burst"}').sender === 'svc-a'
            && asMsg('{"sender":"svc-a","text":"!burst"}').msg.cmd === 'burst');
        check('user 也認（跟 sender 等價）', asMsg({ user: 'u1', text: '!poke' }).sender === 'u1');
        check('壞掉的 JSON 退回當純文字處理',
            asMsg('{"cmd":"feed"').msg === null && asMsg('{壞掉 !burst').msg.cmd === 'burst');
        check('看不懂的物件回 null，不會炸',
            asMsg({ hello: 1 }).msg === null && asMsg(null).msg === null);
        check('JSON 指令一樣過白名單',
            asMsg('{"cmd":"spawn"}', custom).msg === null);

        // ---- 同來源冷卻 ----
        const gate = B.makeBridgeGate(1000);
        check('第一道放行', gate.allow('svc-a', 0) === true);
        check('冷卻期內的第二道擋下', gate.allow('svc-a', 500) === false);
        check('不同來源互不影響', gate.allow('svc-b', 500) === true);
        check('過了冷卻就再放行', gate.allow('svc-a', 1000) === true);
        check('沒有 sender 就不擋（來源沒給身分時照收）',
            gate.allow(null, 0) === true && gate.allow(null, 0) === true);
        check('cooldown = 0 → 整個關掉', B.makeBridgeGate(0).allow('svc-a', 0) === true
            && B.makeBridgeGate(0).allow('svc-a', 0) === true);

        // ---- 橋接頁本身 ----
        const bridgeHtml = fs.readFileSync(path.join(ROOT, 'bridge.html'), 'utf8');
        check('bridge.html 釘死 color-scheme: light（透明背景的老教訓）',
            /:root\s*\{[^}]*color-scheme:\s*light/.test(bridgeHtml));
        check('內嵌 widget 的 iframe 元素也對齊 color-scheme',
            /#frame\s*\{[^}]*color-scheme:\s*light/.test(bridgeHtml));
        check('底色透明（它可能自己就是最外層）',
            /background:\s*transparent/.test(bridgeHtml));
        check('載入 js/bridge.js 並啟動',
            /<script src="\.\/js\/bridge\.js"><\/script>/.test(bridgeHtml)
            && /startBridge\(\)/.test(bridgeHtml));
        check('沒設定來源時有用法說明，不是一片空白', /id="help"/.test(bridgeHtml));
        check('bridge.html 與 js/ 都會進 image',
            /COPY[^\n]*bridge\.html[^\n]*\/usr\/share\/nginx\/html\//
                .test(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')));
    }

    // =====================================================
    group('36. 調校台（params.html：一參數一根拉桿）');
    {
        const page = fs.readFileSync(path.join(ROOT, 'params.html'), 'utf8');
        check('調校台有自己的頁籤與面板',
            /id="tab-tuner"/.test(page) && /id="panel-tuner"/.test(page)
            && /TAB_KEYS = \['params', 'tuner'/.test(page));
        check('控件是從同一份參數表長出來的（不會跟文件漂移）',
            /for \(const p of PARAMS\.filter\(x => x\.group === g\)\)/.test(page));
        check('預覽區的網址一改，調校台就跟著同步（單一真相）',
            /function applyPreview[\s\S]{0,200}syncTuner\(\)/.test(page));
        // 拉桿與下拉是從 range 欄位（「a ~ b」與「a / b / c」）推出來的。
        // 那一欄的格式由 test/params-doc.test.js 逐列比對白名單的 min/max
        // 與 values，格式寫壞在那裡就會紅燈，這裡不再抄一份規則
    }

    // =====================================================
    // 這一組驗的是「真的那張表」而不是假的：上面所有陣容測試都用假對照表
    // （才控制得住斷言），但那也意味著真表如果重新產錯了，沒人會發現。
    // pokemon_types.js 是自動產生的檔案，產壞的方式很安靜——少一半、
    // 屬性名拼錯、副屬性跟主屬性重複，看起來都還是一份合法的 JS
    group('37. 屬性對照表的資料健全性（真的那張表）');
    {
        const box = { window: {} };
        vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pokemon_types.js'), 'utf8'), box);
        const primary = box.window.POKE_TYPES;
        const sub = box.window.POKE_SUBTYPES;
        const names = new Set(T.POKE_TYPE_NAMES);

        check('主屬性表 1~1025 一隻都不缺', Object.keys(primary || {}).length === 1025,
            String(Object.keys(primary || {}).length));
        const gaps = [];
        for (let id = 1; id <= 1025; id++) if (!primary[id]) gaps.push(id);
        check('編號連續無空洞', gaps.length === 0, gaps.slice(0, 10).join(', '));
        const badPrimary = Object.keys(primary).filter(id => !names.has(primary[id]));
        check('主屬性的值全都是那十八種屬性名', badPrimary.length === 0,
            badPrimary.slice(0, 5).map(id => `${id}=${primary[id]}`).join(', '));

        check('副屬性表存在且是稀疏的（只有雙屬性的才在裡面）',
            !!sub && Object.keys(sub).length > 0 && Object.keys(sub).length < 1025,
            String(Object.keys(sub || {}).length));
        const badSub = Object.keys(sub).filter(id => !names.has(sub[id]));
        check('副屬性的值也全都是那十八種屬性名', badSub.length === 0,
            badSub.slice(0, 5).map(id => `${id}=${sub[id]}`).join(', '));
        const subOutOfRange = Object.keys(sub).filter(id => Number(id) < 1 || Number(id) > 1025);
        check('副屬性的編號都落在 1~1025', subOutOfRange.length === 0,
            subOutOfRange.slice(0, 5).join(', '));
        const sameBoth = Object.keys(sub).filter(id => sub[id] === primary[id]);
        check('沒有「副屬性跟主屬性一樣」的資料（那是產表出錯）',
            sameBoth.length === 0, sameBoth.slice(0, 5).join(', '));

        // 抽幾隻手動確認的：產表管線換掉時，這幾條會先叫
        check('噴火龍 #6 是火/飛行', primary[6] === 'fire' && sub[6] === 'flying');
        check('皮卡丘 #25 是純電（副屬性查不到）',
            primary[25] === 'electric' && sub[25] === undefined);
        check('班基拉斯 #248 是岩/惡', primary[248] === 'rock' && sub[248] === 'dark');
        check('耿鬼 #94 是幽靈/毒', primary[94] === 'ghost' && sub[94] === 'poison');

        // team=flying 能不能成軍，全靠副屬性——這是這次改動的重點
        const flyBoth = [];
        const flyPrim = [];
        for (let id = 1; id <= 649; id++) {
            if (primary[id] === 'flying' || sub[id] === 'flying') flyBoth.push(id);
            if (primary[id] === 'flying') flyPrim.push(id);
        }
        check('預設範圍內主屬性是飛行的只有 1 隻（所以才需要副屬性）',
            flyPrim.length === 1, JSON.stringify(flyPrim));
        check('算進副屬性後飛行系有 82 隻，team=flying 湊得出隊伍',
            flyBoth.length === 82, String(flyBoth.length));

        // 客串名單（另一份靜態表）本來就是兩槽都算過的，兩邊應該完全對得上
        const cameo = { window: {} };
        vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pokemon_cameo.js'), 'utf8'), cameo);
        const cameoAll = [...cameo.window.POKE_FLYING, ...cameo.window.POKE_LEGENDARY];
        const notFlying = cameoAll.filter(id => primary[id] !== 'flying' && sub[id] !== 'flying');
        check('客串名單全員的任一屬性槽都含飛行（兩份靜態表對得上）',
            notFlying.length === 0, notFlying.slice(0, 10).join(', '));
        check('客串名單的隻數與「兩槽都算」的飛行系一致',
            cameoAll.length === flyBoth.length, `客串 ${cameoAll.length} / 飛行 ${flyBoth.length}`);
    }

    // =====================================================
    group('38. 名牌（頭頂的「No.25 皮卡丘」）');
    {
        const savedMode = CONFIG.nametag;
        const savedSize = CONFIG.nametagSize;
        const tagOf = p => p.el.children.find(c => String(c.className).startsWith('nametag'));

        // 查表與退路
        check('pokeName 查得到名字', T.pokeName(25) === '皮卡丘', T.pokeName(25));
        check('查不到的編號退回 No.編號，不開天窗', T.pokeName(999) === 'No.999', T.pokeName(999));

        // hover 模式（預設）：元素造出來但掛 on-hover，由 CSS 決定何時現身
        CONFIG.nametag = 'hover';
        const pHover = newPokemon(25);
        const tagHover = tagOf(pHover);
        check('預設會掛名牌元素', !!tagHover && pHover.nametag === tagHover);
        check("hover 模式掛 on-hover class（平常收著）",
            tagHover.className.includes('on-hover'), tagHover.className);
        check('名牌內容 = 編號 + 名字兩段',
            tagHover.children.length === 2
            && tagHover.children[0].className === 'dex'
            && tagHover.children[0].textContent === 'No.25'
            && tagHover.children[1].textContent === '皮卡丘',
            JSON.stringify(tagHover.children.map(c => c.textContent)));
        check('字級吃 nametagSize', tagHover.style.fontSize === '11px', tagHover.style.fontSize);

        // 常駐模式
        CONFIG.nametag = 'on';
        const pOn = newPokemon(143);
        check("nametag='on' 不掛 on-hover（一直看得到）",
            !tagOf(pOn).className.includes('on-hover'), tagOf(pOn).className);

        // 關掉：連元素都不產生（OBS 掛整天不必為關掉的功能付錢）
        CONFIG.nametag = 'off';
        const pOff = newPokemon(25);
        check("nametag='off' 連元素都不產生", !tagOf(pOff) && pOff.nametag === null);

        // 色違：名字用金色（class 決定顏色，這裡驗 class）
        CONFIG.nametag = 'on';
        const pShiny = newPokemon(25, { shiny: true });
        check('色違的名牌掛 shiny class（金色字）',
            tagOf(pShiny).className.includes('shiny'), tagOf(pShiny).className);
        const pNormal = newPokemon(25);
        check('非色違不掛 shiny class', !tagOf(pNormal).className.includes('shiny'));

        // 字級可調（OBS 疊 1080p 時要放大）
        CONFIG.nametagSize = 18;
        check('nametagSize 改大後跟著變', tagOf(newPokemon(25)).style.fontSize === '18px');
        CONFIG.nametagSize = 999; // 超出範圍：夾住，別讓手改 config.js 的人做出滿版的字
        check('nametagSize 夾在上限 40', tagOf(newPokemon(25)).style.fontSize === '40px');
        CONFIG.nametagSize = savedSize;

        // 頭頂讓位：bubblePosition='top' 時對話框與名牌搶同一個位置
        const savedPos = CONFIG.bubblePosition;
        CONFIG.bubblePosition = 'top';
        CONFIG.nametag = 'on';
        const pTop = newPokemon(25);
        pTop.nametag.offsetHeight = 17; // 真瀏覽器才量得到高度，這裡手動塞
        pTop.showEmote('heart');
        // 名牌高 17px、上下各留 2px → 對話框從 100% + 21px 起算
        check("nametag='on' 時 top 對話框往上讓開一層",
            pTop.bubble.style.bottom === 'calc(100% + 21px)', pTop.bubble.style.bottom);
        CONFIG.nametag = 'hover';
        const pTopHover = newPokemon(25);
        pTopHover.nametag.offsetHeight = 17;
        pTopHover.showEmote('heart');
        check("hover 模式不讓位（名牌平常不在，不為它永遠空一排）",
            pTopHover.bubble.style.bottom === 'calc(100% + 2px)', pTopHover.bubble.style.bottom);
        CONFIG.bubblePosition = savedPos;
        CONFIG.nametag = savedMode;
    }

    // =====================================================
    // 跟第 37 組同一個理由：上面用的是假名字表，真表產壞了不會有人發現。
    // 名字表的錯法特別安靜——抓錯語言欄位（簡體、日文）看起來還是一份
    // 合法的 JS，只有拿繁簡有差的字去對才驗得出來
    group('39. 名字對照表的資料健全性（真的那張表）');
    {
        const box = { window: {} };
        vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pokemon_names.js'), 'utf8'), box);
        vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pokemon_heights.js'), 'utf8'), box);
        vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pokemon_types.js'), 'utf8'), box);
        const names = box.window.POKE_NAMES;

        check('名字表 1~1025 一隻都不缺', Object.keys(names || {}).length === 1025,
            String(Object.keys(names || {}).length));
        const gaps = [];
        for (let id = 1; id <= 1025; id++) if (!names[id]) gaps.push(id);
        check('編號連續無空洞、沒有空字串', gaps.length === 0, gaps.slice(0, 10).join(', '));

        // 三張靜態表的編號集合必須一致：任何一張重產時漏掉一段都會在這裡現形
        const keysOf = t => Object.keys(t).map(Number).sort((a, b) => a - b).join(',');
        check('編號集合與身高表、屬性表完全一致',
            keysOf(names) === keysOf(box.window.POKE_HEIGHTS)
            && keysOf(names) === keysOf(box.window.POKE_TYPES));

        // 黃金樣本挑「繁簡有差」的字：抓到簡體（妙蛙种子）或日文會在這裡爆
        const GOLDEN = { 1: '妙蛙種子', 6: '噴火龍', 25: '皮卡丘', 94: '耿鬼',
                         133: '伊布', 143: '卡比獸', 448: '路卡利歐', 1025: '桃歹郎' };
        const wrong = Object.entries(GOLDEN).filter(([id, want]) => names[id] !== want);
        check('黃金樣本全中（繁體，不是簡體或日文）', wrong.length === 0,
            wrong.map(([id, want]) => `#${id} 期望 ${want} 實際 ${names[id]}`).join('; '));

        // 名牌是純文字排版，字串本身要安全：引號會把 JS 字串截斷，
        // 拉丁字母混進來代表某些編號悄悄退回了英文名
        const unsafe = Object.keys(names).filter(id => /["\\\r\n]/.test(names[id]));
        check('沒有引號或換行（不會把字串截斷）', unsafe.length === 0, unsafe.slice(0, 5).join(', '));
        const latin = Object.keys(names).filter(id => /[A-Za-z]/.test(names[id]));
        check('沒有半形拉丁字母（沒有悄悄退回英文名）', latin.length === 0,
            latin.slice(0, 5).map(id => `${id}=${names[id]}`).join(', '));
        const tooLong = Object.keys(names).filter(id => names[id].length > 8);
        check('名字都在 8 字以內（名牌是一行，太長會撐爆版面）', tooLong.length === 0,
            tooLong.slice(0, 5).map(id => `${id}=${names[id]}`).join(', '));
    }

    // =====================================================
    group('40. 展示著陸頁（home.html）');
    {
        const home = fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8');
        const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

        check('舞台上跑的是 widget 本體（不是影片或截圖）',
            /id="stage-frame"[\s\S]{0,120}src="\.\/pokemon_footer_widget\.html"/.test(home));
        check('舞台的 iframe 元素釘了 color-scheme: light（本頁是 dark，不對齊就被墊底色）',
            /\.stage iframe\s*\{[^}]*color-scheme:\s*light/.test(home));
        check('有連到參數文件（看完想串接的人要有下一步）', /href="\.\/params\.html"/.test(home));
        check('home.html 會進 image',
            /COPY[^\n]*home\.html[^\n]*\/usr\/share\/nginx\/html\//.test(dockerfile));

        // 根路徑是「已經發出去的網址」：現有嵌入方與 OBS 來源都指著它。
        // 著陸頁不能搶——搶了人家的頁尾就變成一整頁店面
        check('根路徑仍然出 widget 本體，不是著陸頁',
            /cp \/usr\/share\/nginx\/html\/pokemon_footer_widget\.html \/usr\/share\/nginx\/html\/index\.html/
                .test(dockerfile)
            && !/home\.html \/usr\/share\/nginx\/html\/index\.html/.test(dockerfile));

        // 場景是手寫的 query string，打錯字會安靜地沒效果（白名單外的參數直接無視）。
        // 這裡把每個場景的參數逐一比對白名單，錯字當場現形
        const known = new Set([...Object.keys(T.QUERY_PARAMS), 'ids', 'team']);
        const scenes = [...home.matchAll(/\{ label: '[^']*', q: '([^']*)' \}/g)].map(m => m[1]);
        check('場景清單解析得出來（至少 5 個）', scenes.length >= 5, String(scenes.length));
        const badKeys = [];
        for (const q of scenes) {
            for (const pair of q.split('&').filter(Boolean)) {
                const key = pair.split('=')[0];
                if (!known.has(key)) badKeys.push(`${key}（${q}）`);
            }
        }
        check('每個場景的參數都在白名單上（打錯字的場景會靜靜地沒效果）',
            badKeys.length === 0, badKeys.join(', '));
        check('名牌是疊在場景之上的另一個軸，不寫死在每個場景裡',
            /nametag=on/.test(home) && !scenes.some(q => q.includes('nametag')));
    }

    // =====================================================
    group('41. 作息（白天活潑 / 夜裡想睡）');
    {
        const savedSun = CONFIG.sunTime;
        const savedSleep = CONFIG.nightSleep;
        const savedRandom = Math.random;
        const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

        // 前面幾組為了逼出對話框，把 bubbleChance 之類的旋鈕改過了。
        // 這一組要拿「同一顆骰子」比白天與夜裡，所以先釘死一組已知值——
        // 靠上游組別留下的狀態來斷言，就是偶發紅燈的溫床
        const pinned = {
            idleChance: CONFIG.idleChance,
            idleJumpChance: CONFIG.idleJumpChance,
            greetChance: CONFIG.greetChance,
            bubbleChance: CONFIG.bubbleChance,
            lookTime: { ...CONFIG.lookTime },
        };
        CONFIG.idleChance = 0.01;
        CONFIG.idleJumpChance = 0.003;
        CONFIG.greetChance = 0.1;
        CONFIG.bubbleChance = 0.4; // 挑 0.4：0.5 這顆骰子白天不冒泡、夜裡剛好落在睡著那一段
        CONFIG.lookTime = { min: 2000, max: 5000 };

        // ---- 白天：完全照 config.js，一個倍率都不動 ----
        // （這是刻意的：參數表寫 idleChance 0.01，白天就真的是 0.01）
        CONFIG.sunTime = 12;
        check('白天睡意 = 0', T.sleepiness() === 0, String(T.sleepiness()));
        check('白天所有倍率都是 1（等於這個功能不存在）',
            T.moveScale() === 1 && T.hopScale() === 1 && T.idleTimeScale() === 1
            && near(T.idleChanceNow(), CONFIG.idleChance)
            && near(T.idleJumpChanceNow(), CONFIG.idleJumpChance)
            && near(T.greetChanceNow(), CONFIG.greetChance)
            && near(T.moodChanceNow(), CONFIG.bubbleChance));
        check('白天不會「直接睡著」（Zzz 仍在八選一的池子裡，偶爾打個哈欠）',
            T.sleepEmoteChance() === 0);

        // ---- 深夜：各項乘上倍率 ----
        CONFIG.sunTime = 3; // 日出前好幾個小時，斜坡早就走完
        check('深夜睡意 = 1', T.sleepiness() === 1, String(T.sleepiness()));
        check('原地不動的機率變 5 倍', near(T.idleChanceNow(), CONFIG.idleChance * 5),
            `${T.idleChanceNow()} vs ${CONFIG.idleChance * 5}`);
        check('每次發呆站得更久（2.5 倍）', near(T.idleTimeScale(), 2.5), String(T.idleTimeScale()));
        check('發呆時「直接睡著」的機率 0.7', near(T.sleepEmoteChance(), 0.7),
            String(T.sleepEmoteChance()));
        check('其他心情對話框壓到 0.25 倍',
            near(T.moodChanceNow(), CONFIG.bubbleChance * 0.25));
        check('左右移動慢下來（0.45 倍）', near(T.moveScale(), 0.45), String(T.moveScale()));
        check('走路跳步變低（0.4 倍）', near(T.hopScale(), 0.4), String(T.hopScale()));
        check('發呆亂跳幾乎不跳了（0.1 倍）',
            near(T.idleJumpChanceNow(), CONFIG.idleJumpChance * 0.1));
        check('也不太有心情寒暄了（0.2 倍）',
            near(T.greetChanceNow(), CONFIG.greetChance * 0.2));

        // ---- 睡前那幾個小時：天黑了，但活動力完全照白天 ----
        // 0.47 那次調整的重點：星空 18:00 就浮出來（那是天色），但作息看的是
        // 深夜窗口（預設 00:00 ~ 06:00）——現代人是夜貓子，睡前跟白天差不多活潑
        CONFIG.sunTime = 20;
        check('20:00 天已經全黑了，但完全沒有睡意',
            T.nightLevel() === 1 && T.sleepiness() === 0,
            `夜色 ${T.nightLevel()} / 睡意 ${T.sleepiness()}`);
        CONFIG.sunTime = 23.99;
        check('午夜前一刻還是白天那一套（移動、跳步、發呆全照 config.js）',
            T.sleepiness() === 0 && T.moveScale() === 1 && T.hopScale() === 1
            && near(T.idleChanceNow(), CONFIG.idleChance));

        // ---- 入睡是斜坡，不是開關 ----
        // 窗口 00:00 開始 + nightFade 45 分：00:00 整還完全清醒，00:22.5 剛好一半
        CONFIG.sunTime = 0;
        check('窗口開始那一刻還沒睡意（斜坡是從那之後才走）', T.sleepiness() === 0);
        CONFIG.sunTime = 22.5 / 60;
        check('進窗口半個斜坡 → 睡意 0.5', near(T.sleepiness(), 0.5, 1e-6),
            String(T.sleepiness()));
        check('倍率跟著走一半（移動 0.725 = 1 與 0.45 的中間）',
            near(T.moveScale(), 0.725, 1e-6), String(T.moveScale()));
        // 另一頭也是斜坡：天亮前慢慢醒過來，06:00 剛好歸零
        CONFIG.sunTime = 6 - 22.5 / 60;
        check('窗口結束前半個斜坡 → 睡意也是 0.5（反向漸醒）',
            near(T.sleepiness(), 0.5, 1e-6), String(T.sleepiness()));
        CONFIG.sunTime = 6;
        check('窗口結束那一刻睡意歸零', T.sleepiness() === 0);

        // ---- 總開關 ----
        CONFIG.sunTime = 3;
        CONFIG.nightSleep = 0;
        check('nightSleep=0 → 深夜也完全照白天跑',
            T.sleepiness() === 0 && T.moveScale() === 1
            && near(T.idleChanceNow(), CONFIG.idleChance) && T.sleepEmoteChance() === 0);
        CONFIG.nightSleep = 0.5;
        check('nightSleep=0.5 → 睡意只到一半', near(T.sleepiness(), 0.5));
        CONFIG.nightSleep = 1;

        // ---- 真的接進行為裡了嗎 ----
        // 同一組起始狀態，白天與深夜各走一幀，比位移與跳步高度
        const stepOf = hour => {
            CONFIG.sunTime = hour;
            Math.random = () => 1; // 不進入發呆，只看走路
            const p = newPokemon(25, { direction: 1 });
            p.speed = 1;
            p.hopHeight = 10;
            p.x = 500;
            p.walkPhase = Math.PI / 2; // sin = 1，跳步剛好在最高點
            p.walk(1000 / 60);
            return { dx: p.x - 500, bob: p.bobY };
        };
        const day = stepOf(12);
        const night = stepOf(3);
        check('夜裡走一幀的位移就是白天的 0.45 倍',
            near(night.dx / day.dx, 0.45, 1e-6), `${night.dx} / ${day.dx}`);
        check('夜裡的跳步高度是白天的 0.4 倍',
            near(night.bob / day.bob, 0.4, 1e-6), `${night.bob} / ${day.bob}`);

        // 發呆時長：夜裡抽到的秒數要落在「白天區間 × 2.5」上
        CONFIG.sunTime = 3;
        Math.random = () => 0; // idleChance 一定中、randomInt 取區間下限
        {
            const p = newPokemon(25, { direction: 1 });
            p.walk(1000 / 60);
            check('夜裡進入發呆，時長 = 下限 × 2.5',
                p.state === 'IDLE' && p.idleTimer === Math.round(CONFIG.lookTime.min * 2.5),
                `state=${p.state} timer=${p.idleTimer}`);
        }

        // Zzz：夜裡發呆先擲「睡著了嗎」，中了就掛 Zzz 到發呆結束
        {
            Math.random = () => 0.5; // < 0.7 → 睡著；同時也 < bubbleChance，能證明是走睡著那條路
            const p = newPokemon(25, { direction: 1 });
            p.maybeShowEmote();
            check('夜裡發呆冒的是 Zzz', p.bubbleName === 'zzz' && p.bubble.style.display === 'block',
                String(p.bubbleName));
            Math.random = () => 0.9; // > 0.7 沒睡著，也 > bubbleChance×0.25 → 這次什麼都不冒
            const q = newPokemon(25, { direction: 1 });
            q.maybeShowEmote();
            check('沒睡著時其他心情也被壓低（這一輪什麼都不冒）',
                q.bubble.style.display === 'none', String(q.bubbleName));
        }
        // 白天同樣的骰子：0.5 > bubbleChance(1/3) → 不冒；證明「睡著」那條路白天不存在
        {
            CONFIG.sunTime = 12;
            Math.random = () => 0.5;
            const p = newPokemon(25, { direction: 1 });
            p.maybeShowEmote();
            check('白天同一顆骰子不會變成 Zzz（白天沒有「直接睡著」這條路）',
                p.bubble.style.display === 'none', String(p.bubbleName));
        }

        // ---- 睡得再熟也照做的事 ----
        Math.random = savedRandom;
        {
            // 追果實的小跑速度不吃夜間折扣：牠會醒過來把果實吃掉
            const seekStep = hour => {
                CONFIG.sunTime = hour;
                T.pokemons.length = 0;
                const p = newPokemon(25, { direction: 1 });
                p.speed = 1;
                p.x = 100;
                const berry = { x: 900, bottom: 0, state: 'LANDED', el: { style: {} }, bite: 1 };
                p.targetBerry = berry;
                p.state = 'SEEK_BERRY';
                p.seekStartle = 0;
                p.seekBerry(1000 / 60);
                return p.x - 100;
            };
            check('追果實的速度白天夜裡一樣（吃飯不打折）',
                near(seekStep(12), seekStep(3), 1e-9), `${seekStep(12)} vs ${seekStep(3)}`);

            // 掙扎抖動：夜裡照樣扭
            CONFIG.sunTime = 3;
            const held = newPokemon(25, { direction: 1 });
            held.hopHeight = 10;
            held.grab({ x: 300, bottom: 60 });
            held.struggle(200);
            check('抓起來的掙扎抖動夜裡照舊（不吃睡意折扣）',
                held.bobY > 0 && held.struggleAngle !== 0,
                `bobY=${held.bobY} angle=${held.struggleAngle}`);

            // 被戳還是會跳（那是使用者找上牠，不是牠自己想動）
            const poked = newPokemon(25, { direction: 1 });
            poked.poke();
            check('夜裡被戳照樣開心跳一下', poked.jumpV > 0, String(poked.jumpV));

            // 睡到一半果實掉下來：驚嘆號會把 Zzz 換掉、照常起跑
            const sleeper = newPokemon(25, { direction: 1 });
            sleeper.state = 'IDLE';
            sleeper.idleTimer = 5000;
            sleeper.showEmote('zzz');
            const berry2 = { x: 700, bottom: 0, state: 'LANDED', el: { style: {} }, bite: 1 };
            sleeper.startSeekBerry(berry2);
            check('睡到一半發現果實 → 醒過來換驚嘆號、進入追果實',
                sleeper.state === 'SEEK_BERRY' && sleeper.bubbleName === 'exclaim',
                `state=${sleeper.state} bubble=${sleeper.bubbleName}`);
        }

        Math.random = savedRandom;
        CONFIG.sunTime = savedSun;
        CONFIG.nightSleep = savedSleep;
        Object.assign(CONFIG, pinned);
        T.pokemons.length = 0;
    }

    // =====================================================
    // 網址是使用者打的，什麼都可能出現：拼錯的 enum、負數、
    // 「sunrise 比 sunset 晚」這種逐個看都合法、組合起來卻矛盾的。
    // PARAMS.md 對外承諾「不合法就忽略、退回預設」，這一組就是那份承諾。
    // 這些防守分支跑不到的話，壞網址會靜靜地把 NaN 寫進設定裡
    group('42. 壞網址的防守（忽略不合法、修正互相矛盾）');
    {
        const savedSearch = sandbox.location.search;
        // 防守路徑都會 console.warn 提醒嵌入方，這裡收進陣列：
        // 一來測試輸出不被警告塞滿，二來「有沒有講」本身就是要驗的事
        const warns = [];
        const realWarn = console.warn;
        const run = search => {
            sandbox.location.search = search;
            warns.length = 0;
            console.warn = msg => warns.push(String(msg));
            const cfg = JSON.parse(JSON.stringify(CONFIG));
            try { T.applyQueryOverrides(cfg); } finally { console.warn = realWarn; }
            return cfg;
        };
        const warned = word => warns.some(w => w.includes(word));

        // ---- 逐個參數：型別對不上就整個忽略，不是硬轉 ----
        const badEnum = run('?theme=草地&bubblePosition=side');
        check('enum 拼錯 → 忽略並警告，其他參數照收',
            badEnum.theme === CONFIG.theme && badEnum.bubblePosition === 'side' && warned('theme=草地'),
            `theme=${badEnum.theme} warns=${warns.length}`);
        check('enum 大小寫不敏感', run('?theme=GRASS').theme === 'grass');

        const badNum = run('?count=abc');
        check('數值寫成文字 → 忽略（不會把 NaN 寫進設定）',
            badNum.count === CONFIG.count && warned('count=abc'), String(badNum.count));
        check('數值超出上限 → 忽略',
            (c => c.count === CONFIG.count && warned('count=999'))(run('?count=999')));
        check('數值低於下限 → 忽略',
            (c => c.baseSize === CONFIG.baseSize && warned('baseSize=1'))(run('?baseSize=1')));
        check('合法值照收（防守沒有把好參數一起擋掉）',
            (c => c.count === 6 && warns.length === 0)(run('?count=6')), warns.join(' | '));

        const badTime = run('?sunTime=25:00');
        check('時間超出 0 ~ 24 → 忽略', badTime.sunTime === CONFIG.sunTime && warned('sunTime=25:00'));
        check("時間看不懂（'黃昏'）→ 忽略",
            (c => c.sunrise === CONFIG.sunrise && warned('sunrise=黃昏'))(run('?sunrise=黃昏')));
        check("sunTime=auto → 收成 null（跟著本機時鐘，等同沒帶）",
            run('?sunTime=AUTO').sunTime === null);
        check('深夜窗口也收 HH:MM（deepStart=01:30 → 1.5）',
            run('?deepStart=01:30').deepStart === 1.5);
        check('深夜窗口超出 0 ~ 24 → 忽略',
            (c => c.deepEnd === CONFIG.deepEnd && warned('deepEnd=30'))(run('?deepEnd=30')));
        // 「顛倒」在這裡是合法的：deepStart > deepEnd 就是跨午夜的窗口。
        // sunrise/sunset 會被修（顛倒會讓白天這段區間不存在），這一組刻意不修
        check('deepStart 晚於 deepEnd = 合法的跨午夜窗口，不對調也不警告',
            (c => c.deepStart === 18 && c.deepEnd === 6 && warns.length === 0)
                (run('?deepStart=18&deepEnd=6')), warns.join(' | '));

        // ---- 清單型的兩個特例 ----
        const badIds = run('?ids=9999,abc,0');
        check('ids 全都不合法 → 當作沒帶並警告',
            badIds.fixedIds === undefined && badIds.count === CONFIG.count && warned('ids 參數'),
            `fixedIds=${JSON.stringify(badIds.fixedIds)}`);
        check('ids 夾在 1~1025、上限 50 隻',
            run(`?ids=${Array(60).fill(25).join(',')}`).fixedIds.length === 50);
        // team 的解析在第 32 組已經逐條驗過（大小寫、去重、剔除打錯的），
        // 這裡只補「有沒有跟嵌入方講」——那句警告是它唯一沒被蓋到的分支
        check('team 打錯的屬性名會警告（不是默默吞掉）',
            (c => JSON.stringify(c.team) === '["fire"]'
                && warned('team 忽略不認識的屬性'))(run('?team=fire,水屬性')));

        // ---- 組合起來才矛盾的：逐個都合法，得在載入時修 ----
        const flipped = run('?minId=800&maxId=100');
        check('編號範圍顛倒 → 自動對調', flipped.minId === 100 && flipped.maxId === 800);
        check('發呆時長顛倒 → 自動對調', (c => c.lookTime.min < c.lookTime.max)(
            run('?lookTimeMin=5000&lookTimeMax=1000')));
        const noDay = run('?sunrise=18&sunset=6');
        check('日出晚於日落（白天不存在）→ 退回 6 ~ 18 並警告',
            noDay.sunrise === 6 && noDay.sunset === 18 && warned('sunrise 必須早於 sunset'));
        const badBounds = run('?boundsMin=0.9&boundsMax=0.2');
        check('活動範圍顛倒 → 退回 0.1 ~ 0.9 並警告',
            badBounds.bounds.min === 0.1 && badBounds.bounds.max === 0.9
            && warned('boundsMin 必須小於 boundsMax'));
        const narrow = run('?boundsMin=0.5&boundsMax=0.52');
        check('活動範圍太窄（塞不下最大體型）→ 退回預設並警告',
            narrow.bounds.min === 0.1 && narrow.bounds.max === 0.9 && warned('活動範圍太窄'));
        check('count 夾到可抽的編號數量（3 個編號抽不出 8 隻）',
            run('?count=8&minId=1&maxId=3').count === 3);

        sandbox.location.search = savedSearch;
        console.warn = realWarn;
    }

    // =====================================================
    // 上面每一組都是直接呼叫子系統（updateBerries、updateSnatch……），
    // 繞過了 main.js 的 gameLoop —— 於是「新寫的子系統忘了掛進主迴圈」
    // 這種錯誤沒有人守：函式自己測得好好的，畫面上就是不動。
    // 這一組只驗接線：推一幀進去，看每個子系統有沒有被推到
    group('43. 主迴圈的接線（gameLoop 有把每個子系統推一把）');
    {
        const savedSun = CONFIG.sunTime;
        const savedIdle = CONFIG.idleChance;
        const frame = ms => T.gameLoop(T.frameNow += ms);
        T.frameNow = 1e6; // 從一個大的時間戳起跳，跟前面幾組的假時鐘無關
        CONFIG.sunTime = 12;   // 白天：moveScale() = 1，位移才算得準
        CONFIG.idleChance = 0; // 半路發呆會把位移的斷言弄翻

        // ---- 寶可夢：走路與發呆的狀態機每幀都要被推 ----
        T.pokemons.length = 0;
        T.getBerries().slice().forEach(b => T.removeBerry(b));
        const walker = newPokemon(25, { direction: 1 });
        walker.state = 'WALKING';
        walker.x = 400; // 離兩邊界都很遠，位移不會被邊界夾掉
        T.pokemons.push(walker);
        // 走一幀該前進多少：speed 是「每 1/60 秒」的量（見 walk 的時間校正）
        const step = ms => walker.speed * (ms / (1000 / 60));
        frame(16); // 熱身：lastTime 還是 0，這一幀的 deltaTime 會直接吃到上限
        const x1 = walker.x;
        frame(16);
        check('寶可夢被推進了（pokemons.forEach 有掛上）',
            Math.abs(walker.x - (x1 + step(16))) < 1e-9,
            `走了 ${(walker.x - x1).toFixed(3)}px，預期 ${step(16).toFixed(3)}px`);

        // ---- deltaTime 上限 100ms：切走三分鐘再切回來不該瞬移 ----
        const xBefore = walker.x;
        frame(180000); // 三分鐘
        const jump = walker.x - xBefore;
        check('切回分頁不瞬移（deltaTime 夾在 100ms 內）',
            Math.abs(jump - step(100)) < 1e-9,
            `一幀跳了 ${jump.toFixed(1)}px，夾住的話該是 ${step(100).toFixed(1)}px`);

        // ---- 果實：丟下來的要繼續掉 ----
        check('（前置）丟一顆果實在半空', T.throwBerry(walker.centerX(), 120) === true);
        const berry = T.getBerries()[0];
        const bottom0 = berry.bottom;
        frame(16);
        check('果實被推進了（updateBerries 有掛上）', berry.bottom < bottom0,
            `${bottom0} → ${berry.bottom}`);
        T.getBerries().slice().forEach(b => T.removeBerry(b));

        // ---- 客串：飛完行程的要被移除、元素要拆掉 ----
        const cameo = new T.Cameo(6, 1);
        cameo.x = cameo.direction === 1 ? sandbox.window.innerWidth + cameo.margin + 1
            : -cameo.margin - 1;
        T.cameos.push(cameo);
        frame(16);
        check('飛完的客串被收掉、元素也拆了（cameos 掃描有掛上）',
            !T.cameos.includes(cameo) && cameo.el.removed === true);

        // ---- 太陽：節流 2 秒，跑滿一輪就該重算全場影子 ----
        CONFIG.sunTime = 12;
        T.refreshSun();
        check('（前置）正午沒有投射影（只剩腳下那圈）', T.sun.stretch === 1,
            JSON.stringify(T.sun));
        CONFIG.sunTime = 8; // 早上八點：影子拉長並倒向一側
        for (let i = 0; i < 25; i++) frame(100); // 25 × 100ms > SUN_TICK_MS
        check('太陽被推進了（updateSun 有掛上）',
            T.sun.stretch > 1 && T.sun.dir !== 0,
            `dir=${T.sun.dir} stretch=${T.sun.stretch}`);

        // ---- 夜色：同樣是節流的，入夜要現身、天亮要收起來 ----
        // 夜色層在第 33 組就建好了（updateNight 只在第一次真的入夜才建 DOM），
        // 這裡用 ?. 取值：萬一上游沒建成，要看到紅燈而不是整份測試炸掉
        const savedNight = CONFIG.night;
        CONFIG.night = 'on';
        CONFIG.sunTime = 23;
        for (let i = 0; i < 25; i++) frame(100);
        const nightEl = T.getNightEl();
        check('入夜後夜色現身（updateNight 有掛上）',
            nightEl?.hidden === false && Number(nightEl?.style.opacity) > 0,
            `nightEl=${!!nightEl} hidden=${nightEl?.hidden} opacity=${nightEl?.style.opacity}`);
        CONFIG.sunTime = 12;
        for (let i = 0; i < 25; i++) frame(100);
        check('天亮後夜色收起來', nightEl?.hidden === true);
        CONFIG.night = savedNight;

        // ---- 換季：節流成一分鐘一次，同樣得掛在主迴圈上 ----
        // 整份測試把 season 釘死成 'off'（見開頭），這裡臨時打開一季，
        // 讓主迴圈自己跑到下一個節流時點——落下物出現就代表接線在
        CONFIG.season = 'spring';
        for (let i = 0; i <= Math.ceil(T.SEASON_TICK_MS / 100); i++) frame(100);
        check('換季被推進了（updateSeason 有掛上）',
            T.getSeasonEl()?.id === 'season', String(T.getSeasonEl()));
        CONFIG.season = 'off';
        T.buildSeason(); // 收掉，別讓它留到下一組

        CONFIG.sunTime = savedSun;
        CONFIG.idleChance = savedIdle;
        T.refreshSun();
        T.pokemons.length = 0;
        T.cameos.length = 0;
    }

    // =====================================================
    group('44. 季節落下物（春櫻 / 夏綠葉 / 秋楓 / 冬雪）');
    {
        const savedSeason = CONFIG.season;
        const savedDensity = CONFIG.seasonDensity;
        const layer = () => T.getSeasonEl();
        // 場景（地形 + 這次下了什麼天氣）與季節一起給，回傳那一層
        const build = (themeName, weatherKind, season) => {
            CONFIG.season = season;
            T.initSeason(themeName, weatherKind);
            return layer();
        };
        // 像素圖：canvas stub 把畫出來的格子存進 pixelGrids，所以圖案是
        // 直接比對「畫出來的像素」，不是靠眼睛看（同心情圖示那一套）
        const gridOf = name => pixelGrids.get(T.getSeasonURI(name)).map(r => r.split('|'));
        const maskOf = name => gridOf(name).map(r => r.map(c => (c === '.' ? '.' : '#')).join(''));

        // ---- 月份 → 季節：純函式，不看跑測試那天的臉色 ----
        check('3-5 月是春天', [3, 4, 5].every(m => T.seasonForMonth(m) === 'spring'));
        check('6-8 月是夏天', [6, 7, 8].every(m => T.seasonForMonth(m) === 'summer'));
        check('9-11 月是秋天', [9, 10, 11].every(m => T.seasonForMonth(m) === 'autumn'));
        check('12 / 1 / 2 月是冬天', [12, 1, 2].every(m => T.seasonForMonth(m) === 'winter'));
        const tally = {};
        for (let m = 1; m <= 12; m++) tally[T.seasonForMonth(m)] = (tally[T.seasonForMonth(m)] ?? 0) + 1;
        check('十二個月剛好分成四季、每季三個月（沒有月份掉在外面）',
            Object.keys(tally).length === 4 && Object.values(tally).every(v => v === 3),
            JSON.stringify(tally));

        // ---- 三條「不演」的規則 ----
        check("season=off → 整層不建", build('grass', null, 'off') === null);
        check('這次有天氣就讓天氣演（雨天不飄花瓣）',
            build('grass', 'rain', 'spring') === null);
        check('熔岩地不演（葉子飄進岩漿很怪，而且火星已經在上升）',
            build('lava', null, 'autumn') === null);
        check('沒鋪地面照演 ← 刻意與天氣不同（透明背景飄花瓣才是 OBS 的用法）',
            build('none', null, 'spring') !== null);
        check('打錯的季節名當作不演（不會炸）', build('grass', null, 'Spring') === null);
        // auto 是唯一會去問時鐘的路徑。跑測試的月份不能決定成敗，所以這裡
        // 只驗「一定挑得出四季之一」——不會因為讀時鐘而變成不演或 undefined
        check('season=auto 一定挑得出四季之一（真的去問了月份）',
            ['spring', 'summer', 'autumn', 'winter']
                .includes((build('grass', null, 'auto'), T.seasonNow())),
            String(T.seasonNow()));

        // ---- 演的時候長什麼樣 ----
        CONFIG.seasonDensity = 1;
        const spring = build('grass', null, 'spring');
        check('容器是 #season', spring.id === 'season');
        check('張數 = 視窗寬 ÷ 基準 × 密度',
            spring.children.length === Math.round(1920 / T.SEASONS.spring.base),
            `${spring.children.length} 片`);
        const one = spring.children[0];
        check('三層各司其職：落下 → 搖曳 → 自轉',
            one.className === 'season-fall'
            && one.children[0].className === 'season-sway'
            && one.children[0].children[0].className === 'season-art',
            `${one.className} > ${one.children[0]?.className} > ${one.children[0]?.children[0]?.className}`);
        check('每片都有自己的落程、相位、風向、搖幅、自轉週期',
            spring.children.every(f => /s$/.test(f.style._props['--dur'] ?? '')
                && (f.style._props['--delay'] ?? '').startsWith('-')
                && /vh$/.test(f.style._props['--drift'] ?? '')
                && /px$/.test(f.children[0].style._props['--amp'] ?? '')
                && /s$/.test(f.children[0].style._props['--sway'] ?? '')
                && /s$/.test(f.children[0].children[0].style._props['--spin'] ?? '')));
        check('相位是負的 delay（開頁那一刻就是飄到一半，不會齊步走）',
            new Set(spring.children.map(f => f.style._props['--delay'])).size > 1);
        check('全場同一個風向（不是各飄各的）',
            new Set(spring.children.map(f => f.style._props['--drift'].startsWith('-'))).size === 1);
        check('圖案用的是那一季的像素圖',
            one.children[0].children[0].style.backgroundImage === `url(${T.getSeasonURI('spring')})`);
        check('顯示尺寸 = 點陣尺寸 × 該季的放大倍率',
            one.children[0].children[0].style.width
                === `${T.SEASONS.spring.art[0].length * T.SEASONS.spring.scale}px`,
            one.children[0].children[0].style.width);
        // 密度是建那一層的時候算的，所以要先收掉再重建（同一季不會重撒）
        CONFIG.seasonDensity = 3;
        build('grass', null, 'off');
        check('密度倍率會放大張數',
            build('grass', null, 'spring').children.length
                === Math.round(1920 / T.SEASONS.spring.base * 3));
        CONFIG.seasonDensity = 1;

        // ---- 夏綠葉與秋楓是「同一片葉子換色」（這一季的重點）----
        check('夏與秋的葉子形狀、大小完全一樣',
            JSON.stringify(maskOf('summer')) === JSON.stringify(maskOf('autumn')),
            maskOf('summer').join(' / '));
        check('夏與秋共用同一張 art、同一個放大倍率（改一張兩季一起變）',
            T.SEASONS.summer.art === T.SEASONS.autumn.art
            && T.SEASONS.summer.scale === T.SEASONS.autumn.scale);
        check('只有配色不同：夏綠、秋橘',
            JSON.stringify(gridOf('summer')) !== JSON.stringify(gridOf('autumn'))
            && gridOf('summer').flat().includes('#5cb94a')
            && gridOf('autumn').flat().includes('#e8702a'));
        check('櫻花瓣與葉子是不同形狀（春天不是換色而已）',
            JSON.stringify(maskOf('spring')) !== JSON.stringify(maskOf('autumn')));
        check('四季都至少兩個色階（本體 + 深色描邊，淺色畫面上才不會消失）',
            ['spring', 'summer', 'autumn', 'winter'].every(s =>
                new Set(gridOf(s).flat().filter(c => c !== '.')).size >= 2));

        // ---- 換季 ----
        build('grass', null, 'spring');
        const before = layer();
        T.updateSeason(T.SEASON_TICK_MS);
        check('同一季不重建（不會每分鐘重新撒一次）', layer() === before);
        CONFIG.season = 'autumn';
        T.updateSeason(T.SEASON_TICK_MS - 1);
        check('沒到節流間隔就先不動', layer() === before);
        T.updateSeason(2);
        check('過了節流間隔才換季、圖案跟著換',
            layer() !== before
            && layer().children[0].children[0].children[0].style.backgroundImage
                === `url(${T.getSeasonURI('autumn')})`);
        check('舊的那一層有拆掉（不會兩季疊著）', before.removed === true);
        CONFIG.season = 'off';
        T.updateSeason(T.SEASON_TICK_MS);
        check('換到 off 就收掉整層', layer() === null);

        // ---- 載入與 CSS 契約 ----
        check('season.js 在載入清單裡，且排在用到它的 main.js 之前',
            jsFiles.includes('js/season.js')
            && jsFiles.indexOf('js/season.js') < jsFiles.indexOf('js/main.js'));
        check('#season 與天氣、夜色同層（地面之上、散步成員之下）',
            /#season\s*\{[^}]*z-index:\s*1;/.test(html));
        check('三段動畫都定義了（落下 / 搖曳 / 自轉）',
            /@keyframes season-fall/.test(html)
            && /@keyframes season-sway/.test(html)
            && /@keyframes season-spin/.test(html));
        check('reduced-motion 時整層收起來（跟天氣一起）',
            html.includes('#weather, #season { display: none; }'));

        CONFIG.season = savedSeason;
        CONFIG.seasonDensity = savedDensity;
        T.initSeason('none', null); // 場景與那一層都收回原狀
    }

    // =====================================================
    // 名牌與對話框都掛在 container 上，而 container 的 transform 只有水平位移——
    // 離地高度寫在 sprite 自己的 transform 裡。這兩塊浮層若不自己補上那段，
    // 抓起來拖到半空時字會留在原地（真瀏覽器實測差 100px，身體直接穿過
    // 自己的名字），被戳跳起來時愛心也會脫窗。這一組守住「它們有跟上」
    group('45. 浮層跟著離地高度走（名牌與對話框不脫窗）');
    {
        const savedMode = CONFIG.nametag;
        const savedPos = CONFIG.bubblePosition;
        const savedIdle = CONFIG.idleChance;
        CONFIG.idleChance = 0;
        CONFIG.nametag = 'on';
        CONFIG.bubblePosition = 'side';
        T.pokemons.length = 0;

        const p = newPokemon(143, { direction: 1 });
        const tag = p.nametag;
        check('（前置）名牌與本體都在', !!tag && !!p.img);

        // ---- 名牌 ----
        p.updateDOM();
        check('站在地上：名牌不寫 inline transform（讓 CSS 的置中接手）',
            tag.style.transform === '', `實際 ${tag.style.transform}`);

        // 貼近地面按下去（bottom 20），再往上拉 50px。抬升是「游標相對按下
        // 那一點的位移」，抓與拉同一個高度的話 holdY 會是 0，什麼都測不到。
        // 上限是視窗高減身高（stub 視窗 200、身高 128 → 天花板 72）
        p.grab({ x: p.x + 10, bottom: 20 });
        p.dragTo({ x: p.x + 10, bottom: 70 });
        p.updateDOM();
        const held = Math.round(p.holdY);
        check('抓在半空：名牌跟著升高（置中不能掉）',
            tag.style.transform === `translateX(-50%) translateY(${-p.holdY}px)`
            && held === 50,
            `holdY=${held} transform=${tag.style.transform}`);

        p.release();
        p.jumpY = 0; p.jumpV = 0; p.holdY = 0;
        p.updateDOM();
        check('放手落地：inline transform 清掉，字串跟沒抓過時一模一樣',
            tag.style.transform === '');

        // 走路跳步（bobY）刻意不跟：3px 的彈跳讓整條字跟著抖是雜訊不是活潑
        p.state = 'WALKING';
        p.bobY = 3;
        p.updateDOM();
        check('走路跳步不跟（名牌維持不動，只有本體在彈）',
            tag.style.transform === '' && /translateY\(-3px\)/.test(p.img.style.transform),
            `tag=${tag.style.transform} img=${p.img.style.transform}`);

        // 被戳跳起來：nametag=on 的人沒有滑鼠也天天遇到的那一種脫窗
        p.bobY = 0;
        p.jumpY = 18;
        p.updateDOM();
        check('跳起來也跟（被戳那一下同樣不脫窗）',
            tag.style.transform === 'translateX(-50%) translateY(-18px)',
            tag.style.transform);
        check('本體與名牌吃的是同一個高度（差值只剩走路跳步那一項）',
            /translateY\(-18px\)/.test(p.img.style.transform));
        p.jumpY = 0;
        p.updateDOM();

        // ---- 對話框：底稿（左右位移）+ 抬升，接在同一個 transform 上 ----
        p.showEmote('heart');
        const base = p.bubbleBase;
        check('底稿記下來了，就是 placeBubble 算的左右位移',
            base === `translateX(${p.bubbleMetrics().gap}px)` && base === p.bubble.style.transform,
            `base=${base}`);
        p.jumpY = 22;
        p.updateDOM();
        check('跳起來：底稿保留、抬升接在後面（不是覆蓋掉左右位移）',
            p.bubble.style.transform === `${base} translateY(-22px)`,
            p.bubble.style.transform);
        p.jumpY = 0;
        p.updateDOM();
        check('落地：寫回底稿（字串跟沒有這段功能時完全一樣）',
            p.bubble.style.transform === base);

        // 左側的 calc 字串最容易被接壞（雙負號、括號沒收），單獨驗一次
        p.direction = -1;
        p.updateDOM();
        const leftBase = p.bubbleBase;
        check('（前置）換到左側，底稿變成 calc 那一串',
            leftBase.startsWith('translateX(calc(-100%') && leftBase.endsWith('))'),
            leftBase);
        p.jumpY = 9;
        p.updateDOM();
        check('左側跳起來：calc 原封不動，抬升接在括號外面',
            p.bubble.style.transform === `${leftBase} translateY(-9px)`,
            p.bubble.style.transform);
        p.jumpY = 0;
        p.updateDOM();

        // top 擺位（置中於頭頂）同樣要跟
        CONFIG.bubblePosition = 'top';
        p.direction = 1;
        p.showEmote('note');
        p.jumpY = 12;
        p.updateDOM();
        check('top 擺位也跟（底稿是水平置中）',
            p.bubble.style.transform === 'translateX(-50%) translateY(-12px)',
            p.bubble.style.transform);
        p.jumpY = 0;
        p.updateDOM();

        // 收起來的對話框不必寫（省掉每幀一次無意義的 style 寫入）
        p.hideEmote();
        p.bubble.style.transform = '__SENTINEL__';
        p.jumpY = 15;
        p.updateDOM();
        check('收起來的對話框不動它', p.bubble.style.transform === '__SENTINEL__');
        p.jumpY = 0;

        // 貼在地上的那些幀（絕大多數）不重複寫同一個字串——hover 模式的名牌
        // 平常還是 display:none，每幀替 50 隻寫一次沒變的值是純浪費。
        // 這種「有沒有真的去寫」用哨兵值測不出來（守衛的目的就是收斂到正確值），
        // 所以直接在 style 上裝一個計數器攔 setter
        const countWrites = style => {
            let val = style.transform, writes = 0;
            Object.defineProperty(style, 'transform', {
                configurable: true,
                get: () => val,
                set: v => { writes++; val = v; },
            });
            return {
                get writes() { return writes; },
                restore() { delete style.transform; style.transform = val; },
            };
        };
        p.jumpY = 0; p.holdY = 0;
        p.updateDOM();
        const tagSpy = countWrites(tag.style);
        p.updateDOM(); p.updateDOM(); p.updateDOM();
        check('站在地上：連續三幀都沒再寫名牌的 transform', tagSpy.writes === 0,
            `寫了 ${tagSpy.writes} 次`);
        p.jumpY = 10;
        p.updateDOM();
        check('一離地就寫（值在動，該寫的時候不能省）', tagSpy.writes === 1,
            `寫了 ${tagSpy.writes} 次`);
        tagSpy.restore();
        p.jumpY = 0;
        p.updateDOM();

        p.showEmote('heart');
        p.updateDOM();
        const bubSpy = countWrites(p.bubble.style);
        p.updateDOM(); p.updateDOM();
        check('對話框同理：沒離地就不重寫底稿', bubSpy.writes === 0,
            `寫了 ${bubSpy.writes} 次`);
        bubSpy.restore();
        p.hideEmote();

        // nametag=off 時連元素都沒有，這段不能炸
        CONFIG.nametag = 'off';
        CONFIG.bubblePosition = 'side';
        const bare = newPokemon(25, { direction: 1 });
        check('（前置）nametag=off 真的沒有名牌元素', bare.nametag === null);
        bare.jumpY = 30;
        bare.updateDOM();
        check('沒有名牌時照樣跑得完 updateDOM（不會踩 null）',
            /translateY\(-30px\)/.test(bare.img.style.transform));

        CONFIG.nametag = savedMode;
        CONFIG.bubblePosition = savedPos;
        CONFIG.idleChance = savedIdle;
        T.pokemons.length = 0;
    }

    // =====================================================
    // 時間曲線有兩條，這一組驗的是「它們可以在同一時刻給出不同答案」：
    //   nightLevel()     天色 —— 星空、螢火蟲、地面光暈（日落之後）
    //   deepNightLevel() 作息 —— 想睡、偏抽夜行系（深夜窗口內）
    // 分成兩條是 0.47 的調整：天黑跟想睡不是同一件事，現代人是夜貓子，
    // 18:01 ~ 23:59 的活動力其實跟白天差不多。把這一組改壞了，
    // 傍晚就會集體倒下（或者深夜反而全都醒著）
    group('46. 深夜窗口（畫面歸天色、行為歸作息）');
    {
        const savedSun = CONFIG.sunTime;
        const savedFade = CONFIG.nightFade;
        const savedStart = CONFIG.deepStart;
        const savedEnd = CONFIG.deepEnd;
        const savedRoster = CONFIG.nightRoster;
        const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
        const at = h => { CONFIG.sunTime = h; return T.deepNightLevel(); };

        CONFIG.nightFade = 60; // 一小時的斜坡，換算好對
        CONFIG.deepStart = 0;
        CONFIG.deepEnd = 6;

        // ---- 預設窗口 00:00 ~ 06:00 ----
        check('正午在窗口外', at(12) === 0);
        check('傍晚剛入夜也在窗口外（那是天色，不是作息）', at(18.5) === 0);
        check('20:00 與 23:00 都還在窗口外', at(20) === 0 && at(23) === 0);
        check('窗口開始那一刻是 0（斜坡從那之後才走）', at(0) === 0);
        check('進窗口半小時 = 一半', near(at(0.5), 0.5), String(at(0.5)));
        check('進窗口一小時 = 到底', at(1) === 1);
        check('凌晨三點維持在底', at(3) === 1);
        check('窗口結束前半小時 = 一半（反向漸醒）', near(at(5.5), 0.5), String(at(5.5)));
        check('窗口結束那一刻歸零', at(6) === 0);
        check('天亮之後照白天', at(7) === 0 && at(9) === 0);

        // ---- 兩條曲線在同一時刻可以完全不同：這就是這次調整的全部重點 ----
        CONFIG.sunTime = 23;
        check('23:00：天色全黑（畫面照演）但深夜濃度 0（行為照白天）',
            T.nightLevel() === 1 && T.deepNightLevel() === 0,
            `夜色 ${T.nightLevel()} / 深夜 ${T.deepNightLevel()}`);
        CONFIG.sunTime = 3;
        check('03:00：兩條都到底', T.nightLevel() === 1 && T.deepNightLevel() === 1);
        CONFIG.sunTime = 12;
        check('正午：兩條都是 0', T.nightLevel() === 0 && T.deepNightLevel() === 0);

        // ---- 跨午夜的窗口：設成日落日出就完全回到 0.47 之前的行為 ----
        CONFIG.deepStart = 18;
        CONFIG.deepEnd = 6;
        check('窗口設成 18 ~ 6（跨午夜）→ 與天色那條完全重合（回到舊行為）',
            [18, 18.5, 19, 23, 0.5, 3, 5.5, 6, 12].every(h => {
                CONFIG.sunTime = h;
                return T.deepNightLevel() === T.nightLevel();
            }));

        // ---- 整段落在白天的窗口：午睡也照演，不會因為天亮就不算 ----
        CONFIG.deepStart = 13;
        CONFIG.deepEnd = 15;
        check('窗口 13 ~ 15：14:00 睡得很熟', at(14) === 1);
        check('窗口 13 ~ 15：午夜反而不睡', at(0) === 0 && at(3) === 0);

        // 作息與陣容真的都讀這一條，不是各自另定一套時段
        CONFIG.nightRoster = 1;
        CONFIG.sunTime = 14;
        check('把窗口搬到下午 → 作息與夜行陣容一起跟著搬',
            T.sleepiness() === 1 && T.nightBias() === 1,
            `睡意 ${T.sleepiness()} / bias ${T.nightBias()}`);
        CONFIG.sunTime = 3;
        check('搬走之後，凌晨三點兩件事都不作用',
            T.sleepiness() === 0 && T.nightBias() === 0);

        // ---- 窗口比兩段斜坡加起來還窄：峰值到不了 1，但兩頭仍然歸零 ----
        CONFIG.deepStart = 1;
        CONFIG.deepEnd = 2; // 1 小時的窗口，斜坡各 1 小時
        check('窗口比斜坡還窄 → 峰值只到一半，兩頭仍是 0',
            near(at(1.5), 0.5) && at(1) === 0 && at(2) === 0, String(at(1.5)));

        // ---- 兩個值相同 = 沒有深夜這一段 ----
        CONFIG.deepStart = 3;
        CONFIG.deepEnd = 3;
        check('deepStart === deepEnd → 整天都照白天',
            [0, 3, 3.5, 12, 23].every(h => at(h) === 0));

        // ---- config.js 被手改掉這兩個 key：退回預設窗口，不能炸 ----
        CONFIG.deepStart = undefined;
        CONFIG.deepEnd = undefined;
        check('config.js 少了這兩個 key → 退回預設窗口 00:00 ~ 06:00',
            at(3) === 1 && at(12) === 0 && at(23) === 0);

        // ---- nightFade = 0：沒有斜坡，進窗口就到底 ----
        CONFIG.deepStart = 0;
        CONFIG.deepEnd = 6;
        CONFIG.nightFade = 0;
        check('nightFade=0 → 窗口開始那一刻仍是 0，之後直接到底',
            at(0) === 0 && at(0.01) === 1 && at(5.99) === 1 && at(6) === 0);

        CONFIG.nightFade = savedFade;
        CONFIG.deepStart = savedStart;
        CONFIG.deepEnd = savedEnd;
        CONFIG.nightRoster = savedRoster;
        CONFIG.sunTime = savedSun;
    }

    console.log(`\n${'='.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項\n${'='.repeat(46)}`);
    process.exit(fail ? 1 : 0);
})();
