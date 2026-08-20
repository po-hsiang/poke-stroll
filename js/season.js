// ---------------------------------------------------------
// 季節落下物 (Season)
// 一年四段，各飄一種東西：
//   春 — 櫻花瓣（淡粉、輕、飄得快）
//   夏 — 綠葉
//   秋 — 楓葉
//   冬 — 雪的結晶
//
// 夏與秋刻意共用同一張葉子（LEAF_ART）：大小、形狀、旋轉一模一樣，
// 只有配色換掉。這樣夏轉秋的那一天，畫面上是「同一片葉子變色了」，
// 而不是換了一種道具——季節感就出在那個對比上。
//
// 為什麼是像素圖而不是純 CSS 色塊：花瓣與葉子需要「形狀」，而且
// 這個 widget 的前提是背景透明，粉紅色塊飄在淺色畫面上會直接消失。
// 像素圖才帶得動 1px 的深色描邊——那是唯一的保險（做法與心情圖示、
// 樹果、地面貼片同一套：canvas 畫一次 → dataURL → 全部粒子共用）。
//
// 什麼時候不演（三條規則，全部在 seasonNow()）：
//   1. 這次載入有天氣（雨/雪/風沙/火星）→ 讓天氣演。兩層粒子疊起來是
//      視覺泥巴，也白吃 CPU。天氣是擲骰的（weatherChance 預設 0.5），
//      所以一半的載入會看到季節。
//   2. 熔岩地 → 不演。葉子飄進岩漿很怪，而且火星已經在上升了。
//   3. season=off → 不演。
// 刻意「沒有」把 theme=none 排除：天氣的邏輯是「沒場景就沒天氣」，
// 但落下物是穿過空氣往下掉的，不需要地板。透明背景上飄楓葉是 OBS
// 最好用的一種用法，不該被地板綁住。
//
// 粒子生成一次就交給 CSS 動畫循環（跟天氣、夜晚同一套），主迴圈零負擔。
// ---------------------------------------------------------

// 換季的重算間隔。一年只換四次，但 OBS 場景會一掛好幾個月——
// 三月開的頁到七月還在飄櫻花就尷尬了，所以每分鐘問一次時鐘，
// 真的換季才重建那一層（沒換就什麼都不做）
const SEASON_TICK_MS = 60000;

// 夏與秋共用的葉子：四個裂角 + 一截葉柄。改這張圖兩季一起變
const LEAF_ART = [
    '.d.d.',
    'dllld',
    'dllld',
    '.dld.',
    '..s..',
];

// scale = 顯示放大倍率（整數，維持點陣感）。花瓣與葉子放 3 倍：
// 2 倍時實測只是一顆有顏色的小點，形狀完全讀不出來——旁邊的寶可夢
// 有 128px，落下物太小就不成立。雪的結晶維持 2 倍，跟天氣的雪點同一個量級
const SEASONS = {
    spring: {
        // 櫻花瓣：一片薄薄的偏心花瓣，深色只在下緣（描邊 + 陰影兼用）
        art: ['.ll.', 'lmmd', '.dd.'],
        palette: { l: '#ffe3ee', m: '#ffa8c8', d: '#cf6d8d' },
        scale: 3,
        base: 45,        // 每 45px 畫面寬一片（× seasonDensity）
        dur: [6, 10],    // 落完全程的秒數
        spin: [2, 4],    // 自轉一圈的秒數
        sway: [1.3, 2.5],// 左右搖一趟的秒數
        amp: [10, 22],   // 搖擺幅度（px）
        drift: [10, 25], // 順風橫移量（vh，佔落程的比例）
    },
    summer: {
        art: LEAF_ART,
        palette: { l: '#5cb94a', d: '#27722a', s: '#4a6b28' },
        scale: 3,
        // 夏天最疏（綠葉本來就不該一直掉），但別疏到讓人以為壞了：
        // 實測 130 在 1280 寬只有 10 片，整條畫面像什麼都沒發生
        base: 100,
        dur: [9, 14],    // 也落得最慢
        spin: [3, 6],
        sway: [1.6, 3],
        amp: [12, 26],
        drift: [8, 20],
    },
    autumn: {
        art: LEAF_ART,   // ← 與夏天同一張圖，只有配色不同
        palette: { l: '#e8702a', d: '#a33c12', s: '#7a4a22' },
        scale: 3,        // ← 也必須跟夏天一樣，不然「同一片葉子」就破了
        base: 70,        // 秋天落得比夏天密
        dur: [8, 13],
        spin: [2.5, 5],
        sway: [1.5, 2.8],
        amp: [14, 30],
        drift: [10, 24],
    },
    winter: {
        // 雪的結晶：3×3 的十字，中心留白、四臂淡藍——
        // 純白在白底上看不見，淡藍的臂就是那 1px 描邊
        art: ['.e.', 'eWe', '.e.'],
        palette: { e: '#a8cbe8', W: '#ffffff' },
        scale: 2,
        base: 34,        // 雪最密
        dur: [8, 14],
        spin: [6, 12],   // 幾乎看不出在轉（這麼小的點本來也看不出來）
        sway: [1.6, 3.2],
        amp: [6, 16],
        drift: [4, 14],  // 雪最不受風影響
    },
};

const seasonCache = {};
// 季節落下物的像素圖：一季一張，canvas 畫一次就快取
function getSeasonURI(name) {
    if (seasonCache[name]) return seasonCache[name];
    const spec = SEASONS[name];
    const canvas = document.createElement('canvas');
    canvas.width = spec.art[0].length;
    canvas.height = spec.art.length;
    const ctx = canvas.getContext('2d');
    spec.art.forEach((row, y) => [...row].forEach((ch, x) => {
        if (spec.palette[ch]) {
            ctx.fillStyle = spec.palette[ch];
            ctx.fillRect(x, y, 1, 1);
        }
    }));
    return seasonCache[name] = canvas.toDataURL();
}

// 這一頁的場景：地形與「這次載入下了什麼天氣」。initSeason 存進來，
// 換季重建時還要用（規則會問這兩個）
const seasonScene = { theme: 'none', weather: null };
let seasonEl = null;
let seasonBuilt = null;         // 目前建的是哪一季（null = 沒建）
let seasonClock = SEASON_TICK_MS; // 第一次 updateSeason 就先算一次

// 月份 → 季節。用氣象季而不是節氣：寫得進文件、測得起來，
// 也不用為了四次換季塞天文計算。3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬
// （auto 是照觀看端的本機時鐘，也就是北半球的月份；南半球把
//   ?season=autumn 釘死就好，見 PARAMS.md）
function seasonForMonth(month) {
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
}

// 現在該演哪一季（null = 不演）。三條不演的規則都在這裡，見檔頭
function seasonNow() {
    const pinned = CONFIG.season ?? 'auto';
    if (pinned === 'off') return null;
    if (seasonScene.weather) return null;            // 天氣優先
    if (seasonScene.theme === 'lava') return null;   // 熔岩地不演
    if (pinned !== 'auto') return SEASONS[pinned] ? pinned : null;
    return seasonForMonth(new Date().getMonth() + 1);
}

// 建（或換掉、或收掉）季節那一層。回傳有沒有動過——
// 同一季就原封不動，不會每分鐘重新撒一次
function buildSeason() {
    const want = seasonNow();
    if (want === seasonBuilt) return false;
    seasonEl?.remove();
    seasonEl = null;
    seasonBuilt = want;
    if (!want) return true; // 換季換到「不演」：收掉就結束

    const spec = SEASONS[want];
    const between = (a, b) => a + Math.random() * (b - a);
    const density = Math.min(Math.max(CONFIG.seasonDensity ?? 1, 0.2), 5);
    const n = Math.max(1, Math.round(window.innerWidth / spec.base * density));
    const windDir = Math.random() < 0.5 ? 1 : -1; // 全場統一往同一邊飄
    const uri = getSeasonURI(want);
    const w = spec.art[0].length * spec.scale;
    const h = spec.art.length * spec.scale;

    seasonEl = document.createElement('div');
    seasonEl.id = 'season';
    for (let i = 0; i < n; i++) {
        // 三層各司其職：外層等速落下並順風橫移、中層左右搖曳、內層自轉。
        // 疊起來才像「飄」——只有直落的話那是雨，不是花瓣
        const fall = document.createElement('div');
        fall.className = 'season-fall';
        fall.style.left = `${(Math.random() * 110 - 5).toFixed(1)}%`;
        const dur = between(spec.dur[0], spec.dur[1]);
        fall.style.setProperty('--dur', `${dur.toFixed(2)}s`);
        // 負的 delay 把相位打散：開頁那一刻就是「飄到一半」的樣子
        fall.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
        fall.style.setProperty('--drift',
            `${(windDir * between(spec.drift[0], spec.drift[1])).toFixed(1)}vh`);

        const sway = document.createElement('div');
        sway.className = 'season-sway';
        sway.style.setProperty('--amp', `${Math.round(between(spec.amp[0], spec.amp[1]))}px`);
        sway.style.setProperty('--sway', `${between(spec.sway[0], spec.sway[1]).toFixed(2)}s`);

        const art = document.createElement('div');
        art.className = 'season-art';
        art.style.width = `${w}px`;
        art.style.height = `${h}px`;
        art.style.backgroundImage = `url(${uri})`;
        art.style.setProperty('--spin', `${between(spec.spin[0], spec.spin[1]).toFixed(2)}s`);

        sway.appendChild(art);
        fall.appendChild(sway);
        seasonEl.appendChild(fall);
    }
    app.appendChild(seasonEl);
    return true;
}

// 由 init() 在天氣擲完骰之後呼叫：規則要知道這次下了什麼
function initSeason(themeName, weatherKind) {
    seasonScene.theme = themeName;
    seasonScene.weather = weatherKind;
    buildSeason();
}

// 每一幀由 gameLoop 呼叫，節流成 SEASON_TICK_MS 一次
function updateSeason(deltaTime) {
    seasonClock += deltaTime;
    if (seasonClock < SEASON_TICK_MS) return;
    seasonClock = 0;
    buildSeason();
}
