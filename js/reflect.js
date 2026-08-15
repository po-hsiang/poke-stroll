// ---------------------------------------------------------
// 水面倒影 (Reflection)
// 站在水裡的那一隻，水面下該有一個上下顛倒的自己。
// 這一層跟影子是同一套幾何、相反的方向：影子是「直射光被身體擋住」印在地上，
// 倒影是「本體被水面鏡射」印在水裡——所以它吃的是同一組數字（面向、離地高度），
// 只是把 Y 軸翻過來：本體往上跳，水裡的那個就往下沉。
//
// 鏡面取「水面」而不是「腳底」：水域地形的踩入深度讓腳踩在水面下，
// 從腳底翻會在水面留一條接不起來的縫。以水面翻，水面那一條線上的點翻過去
// 還是自己，兩側才連得起來。
//
// 能畫的高度就是地面那一條帶（themeHeight）——這是頁尾 widget，水面以下
// 沒有更多空間了，超出的部分交給頁面底邊裁掉。預設的 6px 地面只會在腳邊
// 留一抹濕痕；想要一片看得出來的水，把地面拉高：?theme=water&themeHeight=40
// ---------------------------------------------------------

// sprite 的腳底離容器底邊 1px（CSS 的 .sprite { margin-bottom: 1px }，
// 讓牠視覺上站進貼底的影子裡）。鏡射軸的距離要扣掉這 1px，
// 水面那條線才對得齊——測試會核對 CSS 與這個常數一致
const SPRITE_FOOT_GAP = 1;
// 水紋左右搖曳一趟的基準秒數（reflectWave 是它的倍速）
const REFLECT_WAVE_SEC = 2.4;

// 這塊地面現在的倒影強度（0 = 不畫）。
// 地形本身要反光（GROUND_THEMES 的 reflect），使用者也沒關掉
function reflectStrength() {
    if ((CONFIG.reflect ?? 'on') === 'off') return 0;
    const opacity = Math.min(Math.max(CONFIG.reflectOpacity ?? 0.35, 0), 1);
    return groundSurface.reflect * opacity;
}

// 掛上倒影。不反光的地形（或關掉、或地面薄到畫不出東西）就什麼都不做——
// DOM 上連元素都不會有，非水域場景的成本是零
function attachReflection(p) {
    const strength = reflectStrength();
    if (strength <= 0 || groundSurface.band <= 0) return;

    // 外層負責裁切：上緣是水面、下緣貼齊頁面底邊（容器底邊再往下 lift px）
    const wrap = document.createElement('div');
    wrap.className = 'reflection';
    wrap.style.bottom = `${-groundSurface.lift}px`;
    wrap.style.height = `${groundSurface.band}px`;
    wrap.style.opacity = strength;

    // 中間層只做左右搖曳。本體的 transform 由 JS 每一幀改寫，CSS 動畫掛在
    // 同一個元素上會互相蓋掉，所以水紋自己住一層
    const wave = document.createElement('div');
    wave.className = 'reflect-wave';
    const rate = Math.max(CONFIG.reflectWave ?? 1, 0);
    if (rate > 0) wave.style.animationDuration = `${(REFLECT_WAVE_SEC / rate).toFixed(2)}s`;
    else wave.style.animation = 'none'; // 0 = 靜止的水面

    // 最內層是鏡射的本體。水面離腳底 (band - lift) px，倒影的腳落在水面
    // 上方同樣距離處，所以整張圖往上挪這一段，水面兩側才接得起來
    const img = document.createElement('img');
    img.className = 'reflect-sprite';
    img.src = p.img.src;
    img.style.height = p.img.style.height;
    img.style.top = `${SPRITE_FOOT_GAP - (groundSurface.band - groundSurface.lift)}px`;

    wave.appendChild(img);
    wrap.appendChild(wave);
    p.el.appendChild(wrap);
    p.reflection = img;

    // sprite 換圖時（動圖失敗退回靜態圖）跟著換，別讓水裡留一張破圖
    p.img.addEventListener('load', () => { img.src = p.img.src; });
}

// 倒影的 transform：面向與離地高度都照抄本體，只是 Y 軸翻過來。
// translateY 接在 scaleY(-1) 之後，位移就自動變成鏡射方向——
// 本體升高多少，水裡的那個就往下沉多少
function reflectTransform(scale, lift) {
    return `scaleX(${scale}) scaleY(-1) translateY(${-lift}px)`;
}
