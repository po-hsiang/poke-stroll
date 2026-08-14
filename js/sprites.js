// ---------------------------------------------------------
// 發呆心情對話框 (Emote Bubble)
// 對話框與圖示都是手繪的字元畫像素圖：
// 字元畫 → canvas 逐格上色 → dataURL 當 <img> 用，
// 顯示時整數倍放大 + image-rendering: pixelated 維持點陣風格。
// 不依賴任何外部圖檔，離線也能用。
// ---------------------------------------------------------
const EMOTE_PALETTE = {
    '#': '#2b2b2b', // 外框黑 / 線條
    'w': '#ffffff', // 對話框底白
    'r': '#e8455a', // 愛心紅 / 驚嘆號紅
    'b': '#9c6a33', // 大便棕
    'B': '#6e4620', // 大便深棕（底部陰影）
    'u': '#4a6fd8', // 問號藍
    'y': '#ecb200', // 星光金
};

// 尾巴根部距「它勾過去那一側」邊緣的點陣圖 px（框的圓角本身就佔掉 2px）。
// 尾巴貼近下角、不掛在正中央：對話框擺在本體側邊時，尾巴要從靠本體的那個
// 下角伸出來才像在講話，掛中央會指向本體旁邊的空氣
const TAIL_INSET = 6;

// 對話框外框產生器：給定總寬度與內部（白底）列數，
// 組出「圓角方框 + 底部尖尾巴」。概念上等同遊戲 UI 的 9-slice：
// 四角與尾巴樣式固定，邊框依內容的 bounding box 雙向伸縮。
// tailDir: 1 = 尾巴在右下角、朝右勾（預設）、-1 = 左下角、朝左勾
function buildBubbleFrame(width, innerRows = 12, tailDir = 1) {
    // 尾巴開口左緣。夾在 [2, width-4]：兩端都要留得下圓角與邊框，
    // 窄框（如驚嘆號的 10px）擺不到那麼靠邊時就以夾住的位置為準
    const tail = Math.min(Math.max(2, width - TAIL_INSET), width - 4);
    const rows = [];
    rows.push('..' + '#'.repeat(width - 4) + '..');
    rows.push('.#' + 'w'.repeat(width - 4) + '#.');
    for (let i = 0; i < innerRows - 2; i++) {
        rows.push('#' + 'w'.repeat(width - 2) + '#');
    }
    rows.push('.#' + 'w'.repeat(width - 4) + '#.');
    rows.push('..' + '#'.repeat(tail - 2) + 'ww' + '#'.repeat(width - tail - 4) + '..');
    rows.push('.'.repeat(tail - 1) + '#ww#' + '.'.repeat(width - tail - 3));
    rows.push('.'.repeat(tail) + '#w#' + '.'.repeat(width - tail - 3));
    rows.push('.'.repeat(tail + 1) + '#' + '.'.repeat(width - tail - 2));
    // 尾巴朝左：整個框左右翻轉。方框本身左右對稱，
    // 所以翻轉的淨效果就只有尾巴改朝向。
    // 心情圖示是「翻轉後」才疊上去的，不會跟著鏡像
    // （音符、問號、Zzz 鏡像過去會變成錯字）
    return tailDir === -1 ? rows.map(row => [...row].reverse().join('')) : rows;
}

// 四種心情圖示（'.' 代表透明、沿用底下對話框的底色），
// top/left 是貼進外框的位置（已置中對齊）。
// 尺寸撐滿框內可用區，但距邊框固定保留 2px 白邊（不觸碰邊框）
const EMOTE_ICONS = {
    heart: { top: 3, left: 5, art: [   // 愛心
        '.rr....rr.',
        'rrrr..rrrr',
        'rrrrrrrrrr',
        'rrrrrrrrrr',
        '.rrrrrrrr.',
        '..rrrrrr..',
        '...rrrr...',
        '....rr....',
    ]},
    note: { top: 3, left: 6, art: [    // 音符
        '....##..',
        '....#.#.',
        '....#..#',
        '....#.#.',
        '....#...',
        '..###...',
        '.####...',
        '..##....',
    ]},
    scribble: { top: 3, left: 4, art: [ // 一團黑線（心情阿雜）
        '...##.##....',
        '.##..#..##..',
        '#..##.##..#.',
        '.##.#..#.##.',
        '#..##.##..##',
        '.#.#..#.##..',
        '..##.##.#...',
        '....#.#.....',
    ]},
    poop: { top: 3, left: 5, art: [    // 大便（三層堆疊 + 右彎尖端）
        '.....bb...',
        '...bbb....',
        '...bbb....',
        '..bbbbbb..',
        '..bbbbbb..',
        'bbbbbbbbbb',
        'bbbbbbbbbb',
        '.BBBBBBBB.',
    ]},
    zzz: { top: 3, left: 3, frameWidth: 23, art: [ // Zzz（小中大三個 Z 沿對角線往右上爬升）
        '...........######',
        '...............#.',
        '..............#..',
        '.....#####...#...',
        '........#...#....',
        '.......#...######',
        '####..#..........',
        '..#..#####.......',
        '.#...............',
        '####.............',
    ]},
    exclaim: { top: 3, left: 3, frameWidth: 10, art: [ // 驚嘆號（紅色，4→2 收窄 + 2x2 圓點）
        'rrrr',
        'rrrr',
        'rrrr',
        '.rr.',
        '.rr.',
        '.rr.',
        '....',
        '.rr.',
        '.rr.',
    ]},
    question: { top: 3, left: 3, frameWidth: 14, art: [ // 問號（藍色，粗筆畫圓頂 + 2x2 圓點）
        '.uuuuu..',
        'uuuuuuu.',
        'uu...uuu',
        '.....uuu',
        '...uuuu.',
        '...uu...',
        '........',
        '...uu...',
        '...uu...',
    ]},
    sparkle: { top: 3, left: 3, frameWidth: 16, art: [ // 金色閃光（實心四芒星，如 emoji ✨），也是色違登場的專屬署名
        '....yy....',
        '....yy....',
        '...yyyy...',
        '..yyyyyy..',
        'yyyyyyyyyy',
        'yyyyyyyyyy',
        '..yyyyyy..',
        '...yyyy...',
        '....yy....',
        '....yy....',
    ]},
};

// 把圖示疊進對話框、畫到 canvas，回傳 dataURL
// （同圖案 × 同尾巴朝向只畫一次，之後走快取）
const emoteCache = {};
function getEmoteURI(name, tailDir = 1) {
    const key = `${name}:${tailDir}`;
    if (emoteCache[key]) return emoteCache[key];
    const icon = EMOTE_ICONS[name];
    // 內部列數自動配合圖案高度（上下各留 2px 白邊），最少維持 12
    const innerRows = Math.max(12, icon.art.length + 4);
    const rows = buildBubbleFrame(icon.frameWidth ?? 20, innerRows, tailDir).map((row, r) => {
        const overlay = icon.art[r - icon.top];
        if (!overlay) return row;
        const patched = [...overlay].map((ch, i) => ch === '.' ? row[icon.left + i] : ch).join('');
        return row.slice(0, icon.left) + patched + row.slice(icon.left + overlay.length);
    });
    const canvas = document.createElement('canvas');
    canvas.width = rows[0].length;
    canvas.height = rows.length;
    const ctx = canvas.getContext('2d');
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
        if (EMOTE_PALETTE[ch]) {
            ctx.fillStyle = EMOTE_PALETTE[ch];
            ctx.fillRect(x, y, 1, 1);
        }
    }));
    return emoteCache[key] = canvas.toDataURL();
}

// ---------------------------------------------------------
// 色違登場的星星粒子 (Shiny Burst)
// 兩種尺寸的像素四芒星 × 兩種金色，canvas 畫一次就快取
// ---------------------------------------------------------
const STAR_ARTS = {
    big:   ['..y..', '.yyy.', 'yyyyy', '.yyy.', '..y..'],
    small: ['.y.', 'yyy', '.y.'],
};
const starCache = {};
function getStarURI(shape, color) {
    const key = `${shape}:${color}`;
    if (starCache[key]) return starCache[key];
    const art = STAR_ARTS[shape];
    const canvas = document.createElement('canvas');
    canvas.width = art[0].length;
    canvas.height = art.length;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    art.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === 'y') ctx.fillRect(x, y, 1, 1);
    }));
    return starCache[key] = canvas.toDataURL();
}

// ---------------------------------------------------------
// 樹果的像素圖 (Berry Sprite)
// 參考文柚果的 Bag Sprite：金黃梨形 + 頂上一片綠葉，
// 12×14 點陣、canvas 畫一次就快取，一樣不吃外部素材
// ---------------------------------------------------------
const BERRY_SCALE = 2; // 顯示放大倍率（整數，維持點陣感）
const BERRY_ART = [
    '......kk....',
    '.....ks.....',
    '..kk.ks.....',
    '.kLlkks.....',
    '.kllLkkk....',
    '..kkkyYk....',
    '...kYyyyk...',
    '..kYYyyydk..',
    '..kYyyyydk..',
    '.kYyyyyyddk.',
    '.kyyyyyyddk.',
    '.kyyyyyddk..',
    '..kyyyddk...',
    '...kkkkk....',
];
const BERRY_PALETTE = {
    k: '#4a3214', // 墨線：深褐
    s: '#8a5a2b', // 果蒂
    l: '#7ac74c', // 葉片亮綠
    L: '#4e8f34', // 葉片暗綠
    y: '#f5c435', // 果身金黃
    Y: '#fbe98c', // 受光面
    d: '#c9952b', // 背光面
};
let berryURICache = null;
function getBerryURI() {
    if (berryURICache) return berryURICache;
    const canvas = document.createElement('canvas');
    canvas.width = BERRY_ART[0].length;
    canvas.height = BERRY_ART.length;
    const ctx = canvas.getContext('2d');
    BERRY_ART.forEach((row, y) => [...row].forEach((ch, x) => {
        if (BERRY_PALETTE[ch]) {
            ctx.fillStyle = BERRY_PALETTE[ch];
            ctx.fillRect(x, y, 1, 1);
        }
    }));
    return berryURICache = canvas.toDataURL();
}
