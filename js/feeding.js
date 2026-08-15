// ---------------------------------------------------------
// 丟果實餵食 (Berry Feeding)
// 左鍵點「寶可夢本體」= 抓起來（事件在本體上就被攔下）；
// 左鍵點「空白處」= 從點擊位置掉下一顆樹果，距離最近且「有空」的
// 那隻冒出驚嘆號發現它，跑過來三口吃掉 + 冒愛心。
// 一隻只追一顆：整套（發現 → 跑去 → 吃 → 愛心）演完前
// 不會發現其他果實。丟新果實要有隻有空的，這個配對制
// 同時就是上限——場上同時最多「常駐數量」顆果實
// ---------------------------------------------------------
let berries = [];    // 場上的果實們 [{ el, x, bottom, vy, state, feeder, snatchable, bite }]
let groundLevel = 0; // 果實落點 = 地面抬高量（主題地面），init() 時寫入
// 果實影子的原始寬度，與 .berry-shadow 的 CSS 寬度一致
// （投射影要靠它算「往外長多少」，逐幀讀 offsetWidth 太貴）
const BERRY_SHADOW_W = 24;

function feedingBusy() {
    return berries.length > 0;
}

// 果實吃完（或意外沒了）的下場：DOM 移除（影子一起）+ 從場上除名
function removeBerry(b) {
    b.el.remove();
    b.shadow?.remove();
    const i = berries.indexOf(b);
    if (i >= 0) berries.splice(i, 1);
}

// 生一顆果實（DOM + 掉落物理的初始狀態）並掛進場上清單。
// feeder = null 的果實不屬於任何餵食流程（空中搶食鎖定的就是這種）
function dropBerry(bx, dropBottom, feeder = null) {
    const w = BERRY_ART[0].length * BERRY_SCALE;
    const el = document.createElement('img');
    el.className = 'berry';
    el.src = getBerryURI();
    el.style.width = `${w}px`;
    el.style.left = `${Math.round(bx - w / 2)}px`;
    const startBottom = Math.max(groundLevel, dropBottom);
    el.style.bottom = `${Math.round(startBottom)}px`;
    app.appendChild(el);
    // 影子釘在正下方的地面上，大小深淺跟著果實的高度走（見 updateBerryShadow）
    const shadow = document.createElement('div');
    shadow.className = 'berry-shadow';
    shadow.style.left = `${Math.round(bx)}px`;
    shadow.style.bottom = `${Math.round(groundLevel)}px`;
    app.appendChild(shadow);
    const berry = {
        el, shadow, x: bx, bottom: startBottom, vy: 0,
        state: startBottom > groundLevel ? 'FALLING' : 'LANDED',
        feeder,
        snatchable: false, // 點擊丟的 throwBerry 才會升旗（搶食限定入口）
        bite: 1,           // 被咬掉幾口的縮放（吃的時候由 EATING 寫入）
    };
    updateBerryShadow(berry); // 生成的第一幀就要是正確的大小深淺
    berries.push(berry);
    return berry;
}

// 果實影子的物理表現：越高越小越淡（120px 高視為「完全飄遠」），
// 快落地時放大加深回來——跟寶可夢跳躍時影子的語彙同一套；
// 被咬小了也跟著縮。最後交給太陽拉長、推向反側、調濃淡（見 sun.js）
function updateBerryShadow(berry) {
    const air = Math.min(Math.max(berry.bottom - groundLevel, 0) / 120, 1);
    berry.shadow.style.transform =
        sunShadowTransform(BERRY_SHADOW_W, (1 - air * 0.5) * (berry.bite ?? 1));
    berry.shadow.style.opacity = ((1 - air * 0.6) * sun.alpha).toFixed(3);
}

function throwBerry(x, dropBottom, snatchable = false) {
    if ((CONFIG.berry ?? 'on') === 'off') return false;
    // 有空的定義見 canTakeBerry()：一隻只追一顆，忙完才會發現下一顆
    const free = pokemons.filter(p => p.canTakeBerry());
    if (!free.length) return false; // 大家都在忙 → 這顆丟不出去

    // 有空的裡面距離最近的那隻發現果實，跑過來吃
    const feeder = free.reduce((a, b) =>
        Math.abs(a.centerX() - x) <= Math.abs(b.centerX() - x) ? a : b);

    // 果實釘在被指派那隻「碰得到」的範圍內：
    // 活動範圍（bounds）外的點擊，果實會落在最近的可達位置，
    // 否則牠會在邊界前踏步、永遠搆不到，整套餵食就此卡死
    const half = (feeder.img.offsetWidth || CONFIG.baseSize * feeder.sizeScale) / 2;
    const minC = window.innerWidth * CONFIG.bounds.min + half;
    const maxC = Math.max(minC, window.innerWidth * CONFIG.bounds.max - half);
    const bx = Math.min(Math.max(x, minC), maxC);

    const berry = dropBerry(bx, dropBottom, feeder);
    // 點擊丟的才可能被搶食盯上——旗子留在果實身上，因為擲骰不只
    // 這一次：追到一半被抓走再放開，落地時會依新的距離重擲（見 release）
    berry.snatchable = snatchable;
    feeder.startSeekBerry(berry);
    maybeMarkSnatch(berry);
    return true;
}

// 果實們的掉落物理（每一幀由 gameLoop 呼叫）：
// 重力手感與點擊跳躍同一套，落地夠快會小彈跳一次
function updateBerries(deltaTime) {
    const dt = deltaTime / (1000 / 60);
    for (const berry of berries) {
        if (berry.state === 'FALLING') {
            berry.vy += 0.35 * dt;
            berry.bottom -= berry.vy * dt;
            if (berry.bottom <= groundLevel) {
                berry.bottom = groundLevel;
                if (berry.vy > 2.5) {
                    berry.vy = -berry.vy * 0.35; // 彈起（速度衰減）
                } else {
                    berry.state = 'LANDED';
                }
            }
            berry.el.style.bottom = `${Math.round(berry.bottom)}px`;
        }
        // 影子跟著高度縮放淡出（含彈跳）。落地的果實也要重算——
        // 太陽在動，影子的方向與長短跟著在變
        updateBerryShadow(berry);
    }
}

// 點擊分流：本體的 click 監聽器會 stopPropagation，
// 事件能冒泡到 document 的都是「空白處」。
// 座標換算成 bottom 基準（頁面底 = 0），跟其他元素同一套座標系
document.addEventListener('click', e => {
    // 拖曳的結尾也會補一發 click（放手處若不在本體上，就直接冒到這裡）。
    // 那不是「點空白處」，別掉果實
    if (swallowClick) { swallowClick = false; return; }
    // 第三個參數：只有「點擊丟的」果實可能引來空中搶食，
    // 遙控 feed 與信使鳥空投的不會（見 maybeMarkSnatch）
    throwBerry(e.clientX, window.innerHeight - e.clientY, true);
});
