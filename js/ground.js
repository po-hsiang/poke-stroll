// ---------------------------------------------------------
// 主題地面 (Themed Ground)
// theme 參數開啟後，在頁面最底鋪一條像素地面，讓散步有地方踩。
// 貼片是載入時即場生成：頂緣墨線 + 亮色 + 底色，再隨機灑斑點與
// 小圖章（花、貝殼、裂縫…），每次重新整理的地面都長得不太一樣。
// 一樣是 canvas → dataURL，不吃任何外部素材。
// inset = 腳掌「踩進」表面的深度（點陣 px）：
// 草會蓋到腳邊、雪會陷進去、水會泡到小腿，岩地就只是站在上面
// ---------------------------------------------------------
const GROUND_SCALE = 2;      // 顯示放大倍率（整數，維持點陣感）
const GROUND_TILE_W = 256;   // 貼片寬（點陣 px），夠寬就看不出重複
// 貼片高不再寫死：由 CONFIG.themeHeight（畫面 px）換算成列數，見 initGround
const GROUND_THEMES = {
    grass: {
        inset: 3,
        top: ['#245c31', '#8ee06a'],
        fill: '#47a04f',
        speckles: [{ color: '#2c6e35', density: 0.06 }, { color: '#8ee06a', density: 0.03 }],
        stamps: [
            { avg: 40, colors: { w: '#ffffff', y: '#ecb200' }, art: ['w.w', '.y.', 'w.w'] }, // 小白花
            { avg: 28, colors: { g: '#2c6e35' }, art: ['g.g', 'g.g'] },                      // 草叢短枝
        ],
    },
    water: {
        inset: 5,
        flow: 16,
        top: ['#1b4a7a', '#d8f1ff'],
        fill: '#3f7fd4',
        speckles: [{ color: '#6faae8', density: 0.05 }, { color: '#2c62ad', density: 0.04 }],
        stamps: [
            { avg: 36, colors: { w: '#d8f1ff' }, art: ['ww..', '..ww'] }, // 波光
        ],
    },
    snow: {
        inset: 4,
        top: ['#8fa8bd', '#ffffff'],
        fill: '#edf5fb',
        speckles: [{ color: '#d7e7f2', density: 0.06 }, { color: '#ffffff', density: 0.04 }],
        stamps: [
            { avg: 48, colors: { u: '#b7d4e8' }, art: ['.u.', 'u.u', '.u.'] }, // 冰晶
        ],
    },
    sand: {
        inset: 2,
        top: ['#a9803c', '#f7dfa0'],
        fill: '#e8c979',
        speckles: [{ color: '#cfa855', density: 0.06 }, { color: '#f7e7b3', density: 0.04 }],
        stamps: [
            { avg: 56, colors: { w: '#fff6e0', d: '#b08a45' }, art: ['.ww.', 'wwdw', '.dd.'] }, // 小貝殼
        ],
    },
    rock: {
        inset: 1,
        top: ['#3f3f46', '#a8a8b0'],
        fill: '#7d7d86',
        speckles: [{ color: '#5f5f68', density: 0.06 }, { color: '#96969e', density: 0.04 }],
        stamps: [
            { avg: 44, colors: { d: '#4c4c54' }, art: ['d..', '.d.', '..d'] },          // 裂縫
            { avg: 60, colors: { l: '#b8b8c0', d: '#5f5f68' }, art: ['.ll.', 'lldd'] }, // 碎石
        ],
    },
    dirt: {
        inset: 2,
        top: ['#57390f', '#c89a5b'],
        fill: '#9a6b38',
        speckles: [{ color: '#7c5426', density: 0.06 }, { color: '#c89a5b', density: 0.03 }],
        stamps: [
            { avg: 52, colors: { l: '#b9b2a6', d: '#6e6357' }, art: ['ll', 'dd'] }, // 小石子
        ],
    },
    lava: {
        inset: 1,
        flow: 40,
        top: ['#2a1512', '#ff9b2f'],
        fill: '#45231d',
        speckles: [
            { color: '#ff6b1a', density: 0.05 },
            { color: '#ffc63f', density: 0.02 },
            { color: '#2a1512', density: 0.05 },
        ],
        stamps: [
            { avg: 30, colors: { o: '#ff8c1a' }, art: ['oo..', '..oo'] }, // 岩縫火光
        ],
    },
};

// 生成主題貼片，回傳 dataURL（GROUND_TILE_W × artH 點陣 px）
function buildGroundTexture(theme, artH) {
    const canvas = document.createElement('canvas');
    canvas.width = GROUND_TILE_W;
    canvas.height = artH;
    const ctx = canvas.getContext('2d');
    theme.top.forEach((color, y) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, y, GROUND_TILE_W, 1);
    });
    ctx.fillStyle = theme.fill;
    ctx.fillRect(0, theme.top.length, GROUND_TILE_W, artH - theme.top.length);
    for (const s of theme.speckles ?? []) {
        const n = Math.round(GROUND_TILE_W * (artH - theme.top.length) * s.density);
        ctx.fillStyle = s.color;
        for (let i = 0; i < n; i++) {
            ctx.fillRect(randomInt(0, GROUND_TILE_W - 1), randomInt(theme.top.length, artH - 1), 1, 1);
        }
    }
    for (const st of theme.stamps ?? []) {
        // 地面矮到塞不下的圖章直接跳過（超低 themeHeight 時只留斑點質感）
        if (artH - theme.top.length < st.art.length) continue;
        const n = Math.max(1, Math.round(GROUND_TILE_W / st.avg));
        for (let i = 0; i < n; i++) {
            const ox = randomInt(0, GROUND_TILE_W - st.art[0].length);
            const oy = randomInt(theme.top.length, artH - st.art.length);
            st.art.forEach((row, y) => [...row].forEach((ch, x) => {
                if (st.colors[ch]) {
                    ctx.fillStyle = st.colors[ch];
                    ctx.fillRect(ox + x, oy + y, 1, 1);
                }
            }));
        }
    }
    return canvas.toDataURL();
}

// theme = 'random' 的擲骰：隨機池 = 七種地形 + 'none'（無地板也是
// 一種運勢），每次重新整理抽一次，狂按 F5 就是輪盤。
// 地面與天氣要吃「同一個」抽選結果，所以 init() 先抽好再分頭傳入；
// 具體的主題名原樣通過
function resolveTheme(themeName) {
    if (themeName !== 'random') return themeName;
    const pool = [...Object.keys(GROUND_THEMES), 'none'];
    return pool[randomInt(0, pool.length - 1)];
}

// 鋪地面。回傳寶可夢要抬高的量（畫面 px）= 地面高度 - 踩入深度。
// theme 不存在（none / 打錯字）就不鋪、回傳 0，一切維持原樣
function initGround(themeName) {
    const theme = GROUND_THEMES[resolveTheme(themeName)];
    if (!theme) return 0;
    // 高度以畫面 px 指定（themeHeight），內部換成 2px 像素格的列數，
    // 所以實際高度會取到最接近的偶數；最少 3 列（頂緣 2 列 + 至少 1 列底）
    const artH = Math.max(3, Math.round((CONFIG.themeHeight ?? 6) / GROUND_SCALE));
    const displayH = artH * GROUND_SCALE;
    const ground = document.createElement('div');
    ground.id = 'ground';
    ground.style.height = `${displayH}px`;
    ground.style.backgroundImage = `url(${buildGroundTexture(theme, artH)})`;
    ground.style.backgroundSize = `${GROUND_TILE_W * GROUND_SCALE}px ${displayH}px`;
    if (theme.flow) {
        // 水與熔岩緩慢橫向流動：一輪位移剛好一張貼片寬，無縫循環
        ground.className = 'ground-flow';
        ground.style.setProperty('--flow-width', `-${GROUND_TILE_W * GROUND_SCALE}px`);
        ground.style.setProperty('--flow-duration', `${theme.flow}s`);
    }
    app.appendChild(ground);
    return Math.max(0, displayH - theme.inset * GROUND_SCALE);
}
