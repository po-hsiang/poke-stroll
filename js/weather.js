// ---------------------------------------------------------
// 天氣 (Weather)
// 下不下由 weather 參數決定兩種來源：
//   live（預設）— 跟著新北市五股區（興珍里一帶）的真實雨量：附近測站
//     正在下雨才下，雨勢越大雨絲越密；每 10 分鐘重問一次，掛在 OBS 裡
//     整晚也會自己開始下、自己停
//   random — 每次載入擲一次骰（weatherChance），中了整頁就下著這場天氣
// 下的是什麼由主題地面決定：
//   雨（草地/水域/岩地/土徑）— 斜斜細細長長的藍色雨絲
//   雪（雪地）— 白色小點慢慢飄，左右搖曳
//   風沙（沙灘）— 淡黃色橫向沙痕，順著風向橫掃
//   火星（熔岩）— 橘黃小火星從低處緩緩上飄、漸滅
// live 只知道「有沒有在下雨」，所以只演降水：雪地照樣下雪，其他地形
// （沙灘、熔岩也是）一律下雨；風沙與火星只在 random 出現。
// 風向（雨的斜向、沙的走向）每次載入隨機一邊，全場統一（重撒也不翻邊）。
// 粒子生成一次就交給 CSS 動畫循環（見 <style>），主迴圈零負擔；
// theme = none 沒有場景，也就沒有天氣
// ---------------------------------------------------------
const THEME_WEATHER = {
    grass: 'rain', water: 'rain', rock: 'rain', dirt: 'rain',
    snow: 'snow', sand: 'sand', lava: 'ember',
};
// live 的資料源：同一台 nginx 代轉中央氣象署的雨量觀測（O-A0002-001，五股測站）。
// 授權碼在伺服器那一頭才補上（見 nginx.conf），瀏覽器永遠看不到 key
const LIVE_WEATHER_URL = './api/weather';
// 重問間隔：測站十分鐘才更新一次雨量，問得再勤也拿不到新答案
const WEATHER_POLL_MS = 600000;
// 「還在問天氣」的佔位：init() 拿到它就先當晴天、季節也先不撒
// （免得花瓣撒了又馬上收），答案回來再由 changeWeather() 通知太陽與季節
const WEATHER_PENDING = 'pending';

let weatherEl = null;
let weatherTheme = 'none';
let weatherNow = null;     // 正在下的天氣（null = 晴天）
let weatherTier = 0;       // 正在下的雨勢倍率（乘在 weatherDensity 上）
let weatherWind = 0;       // 風向：第一次下才擲，之後整頁沿用
let weatherLive = false;   // 這一頁是不是 live（只有 live 需要重問）
let weatherAsking = false; // 上一趟還沒回來就不再發
let weatherClock = 0;

// 雨量（mm）→ 雨勢倍率，0 = 沒在下。
// 雨量筒一格是 0.5 mm：小雨可能十分鐘都翻不滿一格，所以「正在下」看兩件事——
// 最近 10 分鐘有量，或最近 1 小時累積滿 1 mm（兩格，單獨一格可能只是剛停的尾巴）。
// 雨勢照 WMO 的時雨量分級：小雨 < 2.5、中雨 < 7.6、再上去是大雨
function rainTier(past10Min, past1hr) {
    if (!(past10Min > 0 || past1hr >= 1)) return 0;
    const rate = Math.max(past10Min * 6, past1hr); // 換算成 mm/h
    if (rate < 2.5) return 0.5;
    if (rate < 7.6) return 1;
    return 2;
}

// 氣象署的回應 → 雨勢倍率。資料不能用（缺測的 -99、格式變了）回 null
function readRainTier(data) {
    const rain = data?.records?.Station?.[0]?.RainfallElement;
    const past10Min = Number(rain?.Past10Min?.Precipitation);
    const past1hr = Number(rain?.Past1hr?.Precipitation);
    if (!(past10Min >= 0 && past1hr >= 0)) return null;
    return rainTier(past10Min, past1hr);
}

// random 的那一把骰：中了就照主題下（沒中、或主題沒天氣是 null）
function rollWeather() {
    return Math.random() < (CONFIG.weatherChance ?? 0) ? THEME_WEATHER[weatherTheme] : null;
}

// 由 init() 呼叫。回傳這一刻的天氣（main 拿去通知太陽與季節）：
// random 當場擲完；live 先回 WEATHER_PENDING，答案回來再自己換天氣
function initWeather(themeName) {
    weatherTheme = themeName;
    if (!THEME_WEATHER[themeName]) return null;
    // 0 = 永遠晴天，兩種來源都聽它的：關掉天氣的網址不能因為改看真實天氣就下起雨
    if (!((CONFIG.weatherChance ?? 0) > 0)) return null;
    if ((CONFIG.weather ?? 'live') === 'live') {
        weatherLive = true;
        weatherNow = WEATHER_PENDING;
        askLiveWeather();
        return WEATHER_PENDING;
    }
    const kind = rollWeather();
    return kind ? buildWeather(kind, 1) : null;
}

// 問一次真實天氣，答案交給 changeWeather（太陽與季節跟著變）
async function askLiveWeather() {
    if (weatherAsking) return;
    weatherAsking = true;
    let tier = null;
    try {
        const res = await fetch(LIVE_WEATHER_URL);
        if (res.ok) tier = readRainTier(await res.json());
    } catch {
        // file:// 直接開檔、離線、伺服器沒設 key（503）……都算問不到
    }
    weatherAsking = false;
    if (tier !== null) {
        // live 只演降水：雪地下雪，其他地形（沙灘、熔岩也是）下雨
        const kind = THEME_WEATHER[weatherTheme] === 'snow' ? 'snow' : 'rain';
        changeWeather(tier ? kind : null, tier);
    } else if (weatherNow === WEATHER_PENDING) {
        // 開頁那一次問不到就退回擲骰，跟 random 一樣；之後的失敗維持現狀——
        // 雨下到一半因為一次逾時就停，比沿用十分鐘前的答案更假
        changeWeather(rollWeather(), 1);
    }
}

// 每一幀由 gameLoop 呼叫，節流成 WEATHER_POLL_MS 問一次（只有 live 會問）
function updateWeather(deltaTime) {
    if (!weatherLive) return;
    weatherClock += deltaTime;
    if (weatherClock < WEATHER_POLL_MS) return;
    weatherClock = 0;
    askLiveWeather();
}

// 換天氣：撒新的一層（或收掉），再通知太陽（陰天打折）與季節（有天氣就讓天氣演）。
// 跟現在一樣就什麼都不做——不會每十分鐘重撒一次
function changeWeather(kind, tier) {
    if (kind === weatherNow && (!kind || tier === weatherTier)) return;
    if (kind) {
        buildWeather(kind, tier);
    } else {
        weatherEl?.remove();
        weatherEl = null;
        weatherNow = null;
    }
    setSunOvercast(kind);
    setSeasonWeather(kind);
}

// 撒（或換掉）天氣那一層。tier = 雨勢倍率（random 固定 1），回傳 kind
function buildWeather(kind, tier) {
    weatherEl?.remove(); // 換天氣時先收掉舊的那一層
    weatherEl = document.createElement('div');
    weatherEl.id = 'weather';
    weatherNow = kind;
    weatherTier = tier;
    const density = Math.min(Math.max((CONFIG.weatherDensity ?? 1) * tier, 0.2), 5);
    const count = base => Math.max(1, Math.round(window.innerWidth / base * density));
    weatherWind ||= Math.random() < 0.5 ? 1 : -1;
    const windDir = weatherWind;

    if (kind === 'rain') {
        for (let i = 0; i < count(16); i++) {
            const d = document.createElement('div');
            d.className = 'rain-drop';
            d.style.left = `${(Math.random() * 110 - 5).toFixed(1)}%`;
            d.style.height = `${randomInt(10, 18)}px`;
            d.style.background = Math.random() < 0.5 ? '#6faae8' : '#4a7fd4';
            d.style.opacity = (0.45 + Math.random() * 0.35).toFixed(2);
            const dur = 0.7 + Math.random() * 0.5;
            d.style.setProperty('--dur', `${dur.toFixed(2)}s`);
            d.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
            // 雨絲的傾角必須「躺在自己的速度向量上」：整段行程是
            // translate(drift, 125vh)，傾角就是 atan(drift ÷ 125)。
            // 注意號向：CSS rotate 的正角是順時針，直立桿順時針轉是「/」，
            // 而往右下落（drift 為正）該躺成「\」——所以 tilt 與 drift
            // 必須「反號」。同號會變成傾斜方向與降落方向鏡像相反（踩過一次）
            const drift = 20 + Math.random() * 10; // vh，佔 125vh 落高的橫移量
            const tilt = -windDir * Math.atan(drift / 125) * (180 / Math.PI);
            d.style.setProperty('--tilt', `${tilt.toFixed(1)}deg`);
            d.style.setProperty('--drift', `${(windDir * drift).toFixed(1)}vh`);
            weatherEl.appendChild(d);
        }
    } else if (kind === 'snow') {
        for (let i = 0; i < count(26); i++) {
            const f = document.createElement('div');
            f.className = 'snow-flake';
            f.style.left = `${(Math.random() * 100).toFixed(1)}%`;
            const dur = 7 + Math.random() * 6;
            f.style.setProperty('--dur', `${dur.toFixed(2)}s`);
            f.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
            const dot = document.createElement('div');
            const size = randomInt(2, 4);
            dot.style.width = `${size}px`;
            dot.style.height = `${size}px`;
            dot.style.background = '#ffffff';
            dot.style.opacity = (0.6 + Math.random() * 0.4).toFixed(2);
            dot.style.setProperty('--amp', `${randomInt(6, 16)}px`);
            dot.style.setProperty('--sway', `${(1.6 + Math.random() * 1.6).toFixed(2)}s`);
            f.appendChild(dot);
            weatherEl.appendChild(f);
        }
    } else if (kind === 'sand') {
        for (let i = 0; i < count(20); i++) {
            const g = document.createElement('div');
            g.className = 'sand-grain';
            g.style.top = `${(5 + Math.random() * 90).toFixed(1)}%`;
            // 從風的上游畫面外出發，一路橫掃到對側畫面外
            g.style.left = windDir === 1
                ? `-${randomInt(5, 15)}vw`
                : `${randomInt(105, 115)}vw`;
            g.style.width = `${randomInt(8, 16)}px`;
            g.style.background = Math.random() < 0.5 ? '#f7e7b3' : '#cfa855';
            g.style.opacity = (0.4 + Math.random() * 0.4).toFixed(2);
            const dur = 0.6 + Math.random() * 0.5;
            g.style.setProperty('--dur', `${dur.toFixed(2)}s`);
            g.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
            g.style.setProperty('--travel', `${windDir * 125}vw`);
            g.style.setProperty('--dip', `${randomInt(20, 60)}px`);
            weatherEl.appendChild(g);
        }
    } else { // ember（熔岩火星）
        for (let i = 0; i < count(38); i++) {
            const e = document.createElement('div');
            e.className = 'lava-ember';
            e.style.left = `${(Math.random() * 100).toFixed(1)}%`;
            e.style.bottom = `${randomInt(0, 12)}vh`; // 從熔岩表面附近竄起
            const size = randomInt(2, 3);
            e.style.width = `${size}px`;
            e.style.height = `${size}px`;
            e.style.background = ['#ff8c1a', '#ffc63f', '#ff6b1a'][randomInt(0, 2)];
            const dur = 3 + Math.random() * 3;
            e.style.setProperty('--dur', `${dur.toFixed(2)}s`);
            e.style.setProperty('--delay', `-${(Math.random() * dur).toFixed(2)}s`);
            e.style.setProperty('--rise', `-${randomInt(30, 65)}vh`);
            e.style.setProperty('--sway', `${randomInt(-24, 24)}px`);
            weatherEl.appendChild(e);
        }
    }
    app.appendChild(weatherEl);
    return kind;
}
