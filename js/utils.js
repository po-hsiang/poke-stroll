// ---------------------------------------------------------
// 工具函式 (Utils)
// ---------------------------------------------------------

// 產生範圍內的隨機整數
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 註：「抽哪幾隻」不在這裡——那已經不只是隨機取數，還要照 team 與夜行偏好
// 篩名單，整套住在 js/roster.js 的 pickRoster()

// 查不到身高時的保底體型：取 sizeTiers 正中間那一級（預設三級 = 中型）。
// 不寫死數字，調整 sizeTiers 時保底值會自己跟上
function fallbackSizeScale() {
    const tiers = CONFIG.sizeTiers ?? [];
    return tiers[Math.floor(tiers.length / 2)]?.scale ?? 1;
}

// 身高（分米）→ 大中小縮放比例的對照（純同步，查表後的最後一步）
function scaleFromDeciMeters(deciMeters) {
    const meters = deciMeters / 10;
    const tier = CONFIG.sizeTiers.find(t => meters < t.maxMeters);
    return tier ? tier.scale : fallbackSizeScale();
}

// 依身高換算成大中小的縮放比例：
// 優先查本地靜態對照表（pokemon_heights.js，離線可用、不打 API），
// 查不到才退回 PokéAPI，再失敗就當中型
async function getSizeScale(id) {
    let deciMeters = window.POKE_HEIGHTS ? window.POKE_HEIGHTS[id] : undefined;

    if (deciMeters === undefined) {
        try {
            const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
            const data = await res.json();
            deciMeters = data.height; // API 的 height 單位是分米 (0.1 公尺)
        } catch (e) {
            return fallbackSizeScale(); // 查不到身高就當中型
        }
    }

    return scaleFromDeciMeters(deciMeters);
}
