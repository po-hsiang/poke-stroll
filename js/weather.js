// ---------------------------------------------------------
// 天氣 (Weather)
// 主題地面決定天氣種類，weatherChance 決定這一次載入下不下：
//   雨（草地/水域/岩地/土徑）— 斜斜細細長長的藍色雨絲
//   雪（雪地）— 白色小點慢慢飄，左右搖曳
//   風沙（沙灘）— 淡黃色橫向沙痕，順著風向橫掃
//   火星（熔岩）— 橘黃小火星從低處緩緩上飄、漸滅
// 風向（雨的斜向、沙的走向）每次載入隨機一邊，全場統一。
// 粒子生成一次就交給 CSS 動畫循環（見 <style>），主迴圈零負擔；
// theme = none 沒有場景，也就沒有天氣
// ---------------------------------------------------------
const THEME_WEATHER = {
    grass: 'rain', water: 'rain', rock: 'rain', dirt: 'rain',
    snow: 'snow', sand: 'sand', lava: 'ember',
};
let weatherEl = null;

function initWeather(themeName) {
    const kind = THEME_WEATHER[themeName];
    if (!kind) return null;
    if (Math.random() >= (CONFIG.weatherChance ?? 0)) return null;

    weatherEl?.remove(); // 防重複（正常流程一頁只會下一場）
    weatherEl = document.createElement('div');
    weatherEl.id = 'weather';
    const density = Math.min(Math.max(CONFIG.weatherDensity ?? 1, 0.2), 5);
    const count = base => Math.max(1, Math.round(window.innerWidth / base * density));
    const windDir = Math.random() < 0.5 ? 1 : -1;

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
