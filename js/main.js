// ---------------------------------------------------------
// 主程式邏輯 (Main)
// ---------------------------------------------------------
const app = document.getElementById('app');
const pokemons = [];
const cameos = [];
let lastTime = 0;

async function init() {
    // 主題先抽定（random 在這裡擲骰）：地面與天氣要吃同一個結果
    const themeName = resolveTheme(CONFIG.theme ?? 'none');
    // 主題地面先鋪（none 不鋪）：寶可夢得知道自己該站多高
    const groundLift = initGround(themeName);
    groundLevel = groundLift; // 丟下來的果實也落在同一個地面上
    // 場景決定天氣種類，weatherChance 決定下不下；
    // 下起雨雪風沙就把直射光打散（投射影變短變軟，見 sun.js）
    const weatherKind = initWeather(themeName);
    setSunOvercast(weatherKind);
    // 季節落下物要知道「這次下了什麼」：有天氣就讓天氣演（見 js/season.js）
    initSeason(themeName, weatherKind);

    // URL 有帶 ?ids= 就用固定清單，否則照 count/minId/maxId 抽
    // （抽選還會吃 team 與夜行偏好，規則全在 js/roster.js）
    const ids = CONFIG.fixedIds ?? pickRoster(CONFIG.count, CONFIG.minId, CONFIG.maxId);

    // 先向 PokéAPI 查每隻的身高，決定體型分級（並行查詢）
    const scales = await Promise.all(ids.map(getSizeScale));

    // 實例化 Pokemon（index 同時當作出生跑道編號）
    ids.forEach((id, i) => {
        pokemons.push(new Pokemon(id, app, scales[i], i, groundLift));
    });

    // 客串事件排程：機率 0 或名單檔沒載到（獨立檔案，可能被拿掉）就整個不啟動
    if ((CONFIG.flybyChance ?? 0) > 0 && (window.POKE_FLYING?.length || window.POKE_LEGENDARY?.length)) {
        scheduleFlyby();
    }

    // 啟動動畫迴圈
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    // 限制 deltaTime 上限：避免切換分頁再回來時瞬間跳一大步
    const deltaTime = Math.min(timestamp - lastTime, 100);
    lastTime = timestamp;

    updateSun(deltaTime);    // 太陽先走（節流）：影子的方向與長短是全場共用的
    updateNight(deltaTime);  // 夜色跟著時間濃淡（節流）：入夜才建元素，白天整層收起來
    updateSeason(deltaTime); // 換季才重建落下物（節流成一分鐘一次，掛久了才用得到）

    pokemons.forEach(p => p.update(deltaTime, pokemons));

    updateBerries(deltaTime); // 丟下來的果實們（有的話）繼續掉
    updateSnatch(deltaTime);  // 空中搶食的那一場（有的話）繼續演

    // 客串成員：倒著掃，飛完行程（或載圖全滅）就移除
    for (let i = cameos.length - 1; i >= 0; i--) {
        if (!cameos[i].update(deltaTime)) {
            cameos[i].el.remove();
            cameos.splice(i, 1);
        }
    }

    requestAnimationFrame(gameLoop);
}

// 視窗大小改變不需要另外監聽：
// update() 的邊界檢查每一幀都會用當下的視窗寬度重新計算

// 啟動！（找不到設定檔就不啟動，並在主控台提示）
if (CONFIG) {
    applyQueryOverrides(CONFIG);
    init();
} else {
    console.error('[PokéFooter] 找不到 window.POKE_CONFIG，請確認 config.js 與本 HTML 放在同一個資料夾。');
}
