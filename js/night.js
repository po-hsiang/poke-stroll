// ---------------------------------------------------------
// 夜晚演出 (Night)
// 天黑之後才出現的三件事：
//   星空     — 上半部散開的像素小點，各自明暗閃爍（不同步，才不像跑馬燈）
//   螢火蟲   — 貼近地面緩緩游移的光點，兩層動畫：外層飄、內層一明一滅
//   地面光暈 — 貼著地面那條帶子往上暈開的漸層，像夜色下的微光積在地表
// 刻意「沒有」月亮，也刻意「沒有」整頁的色溫底色。後者是關鍵：
// 這個 widget 的前提是背景透明（OBS 場景與嵌入方的網頁不能被蓋掉），
// 只要鋪一層整頁的夜色就整個破功。所以夜色全部做成「元素」——
// 粒子與貼著地面的漸層，天空本身維持全透明。
//
// 這個取捨有一個代價，值得寫在這裡：星星是亮點，亮點疊在白底上本來就不會顯色，
// 而我們不能鋪一層夜色底去製造對比——那就破了透明背景。所以星空在深色的 OBS
// 場景與中間調的背景上很清楚，在白底網頁上會看不見（螢火蟲與地面光暈不受影響，
// 那兩個本身就是有顏色的亮塊）。這是選擇透明背景的必然結果，不是還沒調好。
//
// 幾點算晚上、有多黑，都問 js/sun.js 的 nightLevel()：日落後漸暗、
// 日出前漸亮，整個容器的 opacity 就是那個值，所以黃昏是「慢慢浮出來」，
// 掛在 OBS 裡整晚不動也會自己入夜、自己天亮。
// 粒子生成一次就交給 CSS 動畫循環（跟天氣同一套做法），主迴圈零負擔；
// 白天整層 hidden（display: none），不畫也不合成。
//
// 「亮幾顆」也跟著夜色走：天剛暗只看得到最亮的那幾顆，越暗越多顆冒出來，
// 天亮之前反向一顆一顆熄掉（見 litCount / revealNight）。這是真的天空——
// 亮星先出現，暗的要等天更黑，所以顆數是「加速」冒出來的而不是等速。
// 順帶省事：黃昏時只有幾顆在跑動畫，其餘 display: none 連合成都不做。
// ---------------------------------------------------------

// 夜色濃度的重算間隔。跟太陽同一個節奏就好——夜色是分鐘級的變化
const NIGHT_TICK_MS = 2000;
// 地面光暈往上暈開的高度（畫面 px）。整條帶子 = 地面高度 + 這一段，
// 上緣完全透明，所以「新蓋住」的只有地面上方這一小段的淡光
const NIGHT_GLOW_RISE = 26;
// 光暈的顏色（夜色下的冷調微光）與最濃處的 alpha 上限（nightGlow = 1 時）
const NIGHT_GLOW_RGB = '164, 198, 255';
const NIGHT_GLOW_ALPHA = 0.7;
// 星星的顏色池：偏白、偏藍、偏暖各一種，撒起來才有層次
const NIGHT_STAR_COLORS = ['#ffffff', '#dfe9ff', '#ffe9b8'];
// 螢火蟲的顏色池：核心亮黃綠，外圈的光暈用同色系（inline box-shadow）
const NIGHT_FLY_COLORS = [
    { core: '#e8ff9a', glow: '#9bdc3c' },
    { core: '#c8ff6a', glow: '#7cc22a' },
];

let nightEl = null;
let nightClock = NIGHT_TICK_MS; // 第一次 updateNight 就先算一次（半夜開頁立刻是夜景）
let nightEmpty = false;         // 星星、螢火蟲、光暈全關 → 建不出東西，別每兩秒再試一次
// 星星與螢火蟲的元素，都照「有多顯眼」由大到小排好（見 buildNight）。
// revealNight 只亮出前面幾個，天越黑亮越多；已經亮著幾個記在後面兩個變數，
// 每次只動「跨過門檻」的那幾個——絕大多數的 tick 一個都不必碰
let nightStarEls = [];
let nightFlyEls = [];
let starsLit = 0;
let fliesLit = 0;

// 生成夜景的粒子與光暈。三樣東西各自可以是 0（就不生成那一種），
// 全部都 0 就連容器都不建——回傳有沒有東西可看
function buildNight() {
    const stars = Math.min(Math.max(CONFIG.nightStars ?? 0, 0), 400);
    const flies = Math.min(Math.max(CONFIG.nightFireflies ?? 0, 0), 120);
    const glow = Math.min(Math.max(CONFIG.nightGlow ?? 0, 0), 1);
    // 光暈是「積在地面上的光」，沒鋪地面（theme=none）就沒有地面可以積
    const glowBand = glow > 0 && groundSurface.band > 0 ? groundSurface.band : 0;
    if (!stars && !flies && !glowBand) return false;

    nightEl?.remove(); // 防重複（正常流程一頁只會建一次）
    nightEl = document.createElement('div');
    nightEl.id = 'night';
    nightStarEls = [];
    nightFlyEls = [];
    starsLit = 0;
    fliesLit = 0;

    // 先全部生成，再依「有多顯眼」由大到小排好——revealNight 只亮出前面幾顆，
    // 所以天剛暗時先出現的是大顆又亮的那幾顆（真的天空就是這個順序）
    const starList = [];
    for (let i = 0; i < stars; i++) {
        const s = document.createElement('div');
        s.className = 'night-star';
        s.style.left = `${(Math.random() * 100).toFixed(2)}%`;
        // 只撒在上半部：下面那截是地面與散步的舞台，星星壓上去會變成雜點
        s.style.top = `${(Math.random() * 72).toFixed(2)}%`;
        // 多數是 1px 的小點，偶爾一顆大一點的亮星
        const size = Math.random() < 0.82 ? 1 : randomInt(2, 3);
        s.style.width = `${size}px`;
        s.style.height = `${size}px`;
        s.style.background = NIGHT_STAR_COLORS[randomInt(0, NIGHT_STAR_COLORS.length - 1)];
        // 閃爍 = 在自己的兩個亮度之間來回。每顆的週期與相位都不同，
        // 負的 delay 讓開頁那一刻大家就已經散在各自的位置上
        const lit = 0.55 + Math.random() * 0.45;
        s.style.setProperty('--lit', lit.toFixed(2));
        s.style.setProperty('--dim', (lit * (0.25 + Math.random() * 0.35)).toFixed(2));
        s.style.opacity = lit.toFixed(2); // 動畫被 reduced-motion 關掉時的靜態亮度
        const dur = 2 + Math.random() * 3.5;
        s.style.setProperty('--dur', `${dur.toFixed(2)}s`);
        s.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
        // 顯眼程度 = 大小 × 亮度，決定它排在第幾顆亮起來
        starList.push({ el: s, weight: size * lit });
    }
    starList.sort((a, b) => b.weight - a.weight);
    for (const { el } of starList) {
        el.style.display = 'none'; // 亮幾顆由 revealNight 依夜色濃度決定
        nightEl.appendChild(el);
        nightStarEls.push(el);
    }

    const flyList = [];
    for (let i = 0; i < flies; i++) {
        const f = document.createElement('div');
        f.className = 'night-firefly';
        f.style.left = `${(Math.random() * 100).toFixed(2)}%`;
        // 貼近地面游移：太高就不像螢火蟲，像星星掉下來了
        f.style.bottom = `${randomInt(6, 46)}%`;
        const dur = 6 + Math.random() * 7;
        f.style.setProperty('--dur', `${dur.toFixed(2)}s`);
        f.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
        f.style.setProperty('--dx', `${randomInt(-70, 70)}px`);
        f.style.setProperty('--dy', `${randomInt(-26, 26)}px`);
        const dot = document.createElement('div');
        const c = NIGHT_FLY_COLORS[randomInt(0, NIGHT_FLY_COLORS.length - 1)];
        dot.style.background = c.core;
        const blur = randomInt(4, 8);
        const spread = randomInt(1, 3);
        dot.style.boxShadow = `0 0 ${blur}px ${spread}px ${c.glow}`;
        // 明滅的週期跟飄移刻意錯開（不是整數倍），才不會每次都在同一點亮起來
        dot.style.setProperty('--blink', `${(1.1 + Math.random() * 1.9).toFixed(2)}s`);
        f.appendChild(dot);
        // 螢火蟲的顯眼程度看光暈多大（星星看大小 × 亮度，同一個道理）
        flyList.push({ el: f, weight: blur + spread });
    }
    flyList.sort((a, b) => b.weight - a.weight);
    for (const { el } of flyList) {
        el.style.display = 'none';
        nightEl.appendChild(el);
        nightFlyEls.push(el);
    }

    if (glowBand) {
        const g = document.createElement('div');
        g.id = 'night-glow';
        const height = glowBand + NIGHT_GLOW_RISE;
        // 最濃的地方在地面表面，往上收乾成全透明。
        // 轉折點就設在地面的上緣：地面以下是「照亮的地表」，以上是溢出的微光
        const edge = Math.round(glowBand / height * 100);
        const a = (NIGHT_GLOW_ALPHA * glow).toFixed(3);
        const mid = (NIGHT_GLOW_ALPHA * glow * 0.55).toFixed(3);
        g.style.height = `${height}px`;
        g.style.background = `linear-gradient(to top,`
            + ` rgba(${NIGHT_GLOW_RGB}, ${a}) 0%,`
            + ` rgba(${NIGHT_GLOW_RGB}, ${mid}) ${edge}%,`
            + ` rgba(${NIGHT_GLOW_RGB}, 0) 100%)`;
        nightEl.appendChild(g);
    }

    app.appendChild(nightEl);
    return true;
}

// 這個夜色濃度該亮幾顆。0 → 0、1 → 全部，中間走「平方」而不是等速：
// 真的天空是亮星先出現、暗的要等天更黑，所以顆數是加速冒出來的。
// 濃度只要大於 0 就至少亮一顆——日落後的第一顆星本來就該立刻在那裡
function litCount(total, level) {
    if (level <= 0) return 0;
    if (level >= 1) return total;
    return Math.ceil(total * level * level);
}

// 把陣列的前 want 個打開、其餘關掉。只動跨過門檻的那幾個，回傳新的已亮數
function litUpTo(els, want, lit) {
    for (let i = lit; i < want; i++) els[i].style.display = '';
    for (let i = lit - 1; i >= want; i--) els[i].style.display = 'none';
    return want;
}

// 依夜色濃度亮出前面幾顆（陣列已照顯眼程度排好，所以最亮的先出現）。
// 光暈不在這裡：它是一整條漸層，濃淡由整層的 opacity 負責，沒有「幾顆」
function revealNight(level) {
    starsLit = litUpTo(nightStarEls, litCount(nightStarEls.length, level), starsLit);
    fliesLit = litUpTo(nightFlyEls, litCount(nightFlyEls.length, level), fliesLit);
}

// 每一幀由 gameLoop 呼叫，節流成 NIGHT_TICK_MS 一次。
// 第一次真的入夜才建 DOM：白天開的頁面（絕大多數）連元素都不會產生
function updateNight(deltaTime) {
    if (nightEmpty || (CONFIG.night ?? 'on') === 'off') return;
    nightClock += deltaTime;
    if (nightClock < NIGHT_TICK_MS) return;
    nightClock = 0;
    const level = nightLevel();
    if (level <= 0) {
        // 天亮了（或本來就是白天）：整層收起來，不畫也不合成
        if (nightEl) nightEl.hidden = true;
        return;
    }
    if (!nightEl && !buildNight()) {
        nightEmpty = true;
        return;
    }
    nightEl.hidden = false;
    nightEl.style.opacity = level.toFixed(3);
    revealNight(level);
}
