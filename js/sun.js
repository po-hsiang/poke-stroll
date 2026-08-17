// ---------------------------------------------------------
// 日照與影子 (Sun)
// 影子其實是兩層，這個模組只管第二層：
//   接地影 — 腳下那圈暗（環境光被身體擋住的地方）。它跟太陽無關，只跟
//            「有沒有踩在地上」有關，所以永遠都在——那是「站在平面上」
//            的唯一線索，跳躍與果實落地的語彙也全掛在它身上。
//   投射影 — 直射光被擋住、投在地上的那道長影。這一層才跟著時間走。
// 太陽從 sunrise 的正東（畫面右、0 度）繞到 sunset 的正西（畫面左、180 度），
// 每分鐘 0.25 度（四分鐘 1 度）。影子倒向太陽的反側：早上往左、下午往右；
// 正午最短（就剩腳下那圈接地影），越接近地平線越長。
// 夜晚、以及日出日落的那一瞬間（0 度／180 度）沒有直射光 → 投射影歸零。
// 陰天不是「沒有影子」，是光被懸浮粒子打散 → 影子變短變軟，所以雨雪風沙
// 是打折不是關掉（見 overcastShadow）。
//
// 時間讀「觀看端瀏覽器」的本機時鐘：這是純靜態站，JS 是在使用者的電腦或
// 手機上跑的，伺服器架在哪一區、容器時區怎麼設都與這裡無關——臺灣的使用者
// 看到的就是臺灣的日照。要釘死時刻（OBS 場景、預覽、測試）就用 sunTime。
// ---------------------------------------------------------

// 太陽狀態的重算間隔。0.25 度/分，連整分鐘更新都看不出來，2 秒綽綽有餘
const SUN_TICK_MS = 2000;
// 貼近地平線的收尾角度。影長 ÷ 身高 = cot(太陽高度角)，在 0 度會炸到無限大；
// 最後這 10 度（約 40 分鐘）把投射影收回 0，日出日落才不會憑空跳出一道長影
const SUN_HORIZON_DEG = 10;

// 全場共用的太陽狀態（每 SUN_TICK_MS 重算一次）
const sun = {
    dir: 0,      // 影子倒向：-1 往左 / +1 往右 / 0 沒有投射影
    stretch: 1,  // 長度倍率：1 = 就是腳下那圈接地影，不拉長也不偏移
    alpha: 1,    // 濃度倍率：1 = 正午，跟沒有這套機制時一模一樣
};
let sunOvercast = 1;        // 天氣的散射折扣（initWeather 之後由 main 設定）
let sunClock = SUN_TICK_MS; // 第一次 updateSun 就先算一次

const sunRound = v => Math.round(v * 1000) / 1000;

// 現在幾點（0 ~ 24 的小數）。sunTime 有帶就用它釘死，
// 否則讀觀看端的本機時鐘——連秒數一起算，太陽才是連續在走的
function sunHours() {
    const pinned = CONFIG.sunTime;
    if (typeof pinned === 'number' && pinned >= 0) return pinned % 24;
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

// 夜色濃度 0 ~ 1：0 = 白天、1 = 全黑的深夜。夜晚演出（星空、螢火蟲、地面
// 光暈）的濃淡與夜行陣容的判定都讀這一個值，「幾點算晚上」才只有一種答案。
// 日落「之後」才開始暗（天文上的暮光也是這樣），花 nightFade 分鐘漸暗到底；
// 日出「之前」反向漸亮，天亮的那一刻剛好歸零。
// 這是唯一與「晨昏色溫」有關的東西，而且刻意只輸出一個數字——沒有任何
// 整頁的底色：透明背景是這個 widget 的前提，見 js/night.js 開頭
function nightLevel() {
    const rise = CONFIG.sunrise ?? 6;
    const set = CONFIG.sunset ?? 18;
    if (!(set > rise)) return 0; // 參數顛倒（applyQueryOverrides 已修過）就不猜
    const fade = Math.min(Math.max(CONFIG.nightFade ?? 45, 0), 180) / 60; // 分 → 小時
    const h = sunHours();
    if (h >= rise && h < set) return 0; // 白天
    // 日落後往前算、日出前往後算，兩邊都取「離白天多遠」，跨過午夜也不必特判
    const since = h >= set ? h - set : rise - h;
    // nightFade = 0 就是這條斜坡的極限：日落「那一刻」還是 0，之後直接跳到全黑
    if (fade === 0) return since > 0 ? 1 : 0;
    return Math.min(since / fade, 1);
}

// 重算太陽狀態。時間、天氣、參數任一改變都可以直接呼叫
function refreshSun() {
    const ambient = Math.min(Math.max(CONFIG.ambientShadow ?? 0.55, 0), 1);
    if ((CONFIG.sunShadow ?? 'on') === 'off') {
        sun.dir = 0; sun.stretch = 1; sun.alpha = 1; // 關掉：回到單純的腳下影子
        return;
    }
    const rise = CONFIG.sunrise ?? 6;
    const set = CONFIG.sunset ?? 18;
    // 白天的進度 0 ~ 1，落在區間外（或參數顛倒）就是夜晚
    const progress = set > rise ? (sunHours() - rise) / (set - rise) : -1;
    if (progress <= 0 || progress >= 1) {
        sun.dir = 0; sun.stretch = 1; sun.alpha = ambient; // 夜晚：只剩接地影
        return;
    }
    const rad = progress * Math.PI; // 0 = 正東、π/2 = 正上、π = 正西
    const elev = Math.sin(rad);     // 太陽高度 0 ~ 1（正午 1）
    // 影長 ÷ 身高 = cot(高度角)：正午附近幾乎不長，接近地平線才急速拉長，
    // 比線性內插自然得多。夾在 shadowStretch 之內，再乘上地平線收尾與陰天折扣
    const cot = Math.abs(Math.cos(rad)) / elev;
    const maxExtra = Math.max((CONFIG.shadowStretch ?? 3) - 1, 0);
    const fade = Math.min(elev / Math.sin(SUN_HORIZON_DEG * Math.PI / 180), 1);
    sun.dir = -Math.sign(Math.cos(rad)); // 倒向太陽的反側（正午 cos = 0，長度也是 0）
    sun.stretch = sunRound(1 + Math.min(cot, maxExtra) * fade * sunOvercast);
    // 濃度：接地影是地板，直射光那一份疊在上面，太陽越高越深。
    // 上限剛好是 1（正午），所以這套機制永遠只會讓影子更淡，不會更深
    sun.alpha = sunRound(ambient + (1 - ambient) * elev * sunOvercast);
}

// 每一幀由 gameLoop 呼叫，節流成 SUN_TICK_MS 一次
function updateSun(deltaTime) {
    sunClock += deltaTime;
    if (sunClock < SUN_TICK_MS) return;
    sunClock = 0;
    refreshSun();
}

// 會把直射光打散的天氣：雨/雪/風沙都是懸浮粒子，擋在光源與地面之間。
// 熔岩的火星不算——地面自己還在發光，沒有東西擋住光
const OVERCAST_WEATHER = ['rain', 'snow', 'sand'];

function setSunOvercast(weatherKind) {
    sunOvercast = OVERCAST_WEATHER.includes(weatherKind)
        ? Math.min(Math.max(CONFIG.overcastShadow ?? 0.35, 0), 1)
        : 1;
    refreshSun(); // 立刻反映，不必等下一次 tick
}

// 影子的 transform 字串：先把橢圓往太陽的反側推——推的量剛好讓「貼著腳的
// 那一端」留在原地、另一端往外長，再套上呼叫端自己的縮放（跳躍、咬痕）。
// width = 影子的原始寬度 px。沒有投射影時輸出的字串跟原本一模一樣
function sunShadowTransform(width, scale) {
    const s = scale.toFixed(3);
    if (sun.stretch === 1) return `translateX(-50%) scale(${s})`;
    const off = (sun.dir * (sun.stretch - 1) * width / 2).toFixed(1);
    return `translateX(-50%) translateX(${off}px) scale(${s}) scaleX(${sun.stretch})`;
}
