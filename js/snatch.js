// ---------------------------------------------------------
// 空中搶食 (Berry Snatch)
// 半路殺出的埋伏，不是開場就攤牌：左鍵點空白處丟果實，被指派的
// 那隻與果實落點的距離「超過 snatchDistance」才擲 snatchChance——
// 門檻內絕對安全（果實丟在腳邊護得住），餵食因此有了取捨：
// 餵得近 = 安全、丟得遠 = 賭一把。
// 擲中了牠也照常起跑（看不出任何異狀），跑完「一半路程」時賊鳥
// 從果實那一側的畫面外進場：牠再冒一次驚嘆號、原地停步
// （SNATCH_WATCH），果實同時變無主。賊鳥沿 V 字軌跡俯衝到底部
// 叼走果實（還在半空也接得住），再沿進場俯衝角度的「鏡像」斜上
// 遠走高飛——恆定速度、越飛越小、越飛越淡（透視感），淡完或
// 飛出畫面先到者為準。被叼走的那一刻目擊者換成一團黑線，
// 沮喪個幾秒才回去散步；其他成員照常散步——世界不會為一顆果實
// 停下來。與飛行系客串（flyby）互相獨立，兩者可同時在場；
// 一次只演一場；只作用於「點擊丟的」果實，遙控 feed 與信使鳥空投
// 不受影響
// ---------------------------------------------------------
const SNATCH_LIFT = 24;        // 果實叼在腳下的高度（同信使鳥空投）
// 縮小與淡出的「基準」時長：snatchShrinkRate / snatchFadeRate 都是 1 時，
// 兩者各花這麼久走完；倍速快就早收，0 = 凍住不動（見 update 的 FLEE 段）
const SNATCH_FLEE_MS = 2400;
const SNATCH_GLOOM_MS = 2600;  // 目擊者黑線沮喪的時長
// 透視係數：遠走時 scale = 1 / (1 + k·t)——等速遠離時投影大小就是
// 這個形狀（近快遠慢），t = 1 收在 0.25 倍
const SNATCH_RECEDE = 3;

let pendingSnatch = null; // 被盯上的那一對 { berry, seeker, triggerDist }（伏筆期）
let activeSnatch = null;  // 進行中的那一場（一次只演一場）

class Snatcher {
    constructor(id, sizeScale, berry, victim) {
        this.dead = false;
        this.berry = berry;
        this.victim = victim;
        this.carrying = false; // 叼到果實了沒
        this.phase = 'DIVE';   // DIVE 俯衝 → FLEE 遠走高飛
        this.shrinkT = 0;      // 遠走的縮小進度 0 → 1（吃 snatchShrinkRate 倍速）
        this.fadeT = 0;        // 遠走的變淡進度 0 → 1（吃 snatchFadeRate 倍速）
        this.scale = 1;
        this.isShiny = Math.random() < (CONFIG.shinyChance ?? 0);
        const shinyDir = this.isShiny ? 'shiny/' : '';

        this.height = Math.round(CONFIG.baseSize * sizeScale);
        // 速度 = 巡航（flybySpeed）× 各段倍率（snatchDiveRate / snatchFleeRate，
        // 外部可調），兩段共用同一次 ±10% 變異抽選。0.5 px/幀的下限只防止
        // 極端組合把賊鳥釘在空中——想演多慢是使用者的事，目擊者的保險絲
        // 會跟著實際航程重算（見 beginSnatch），不會提前走人
        const base = (CONFIG.flybySpeed ?? 5) * (0.9 + Math.random() * 0.2);
        this.speed = Math.max(0.5, base * (CONFIG.snatchDiveRate ?? 1.6));     // 俯衝段
        this.fleeSpeed = Math.max(0.5, base * (CONFIG.snatchFleeRate ?? 1.8)); // 遠走段

        // 從果實那一側的畫面外進場：橫向行進方向全程不變（V 字是垂直方向
        // 的翻轉），叼到後往「對側」遠走——剩下的畫面寬度越長，遠走越有戲
        this.direction = berry.x <= window.innerWidth / 2 ? 1 : -1;
        this.margin = this.height * 1.5 + 40;
        this.x = this.direction === 1 ? -this.margin : window.innerWidth + this.margin;
        // 進場高度與客串同一個高度帶（視窗高 45% ~ 75%），世界觀一致
        this.bottom = window.innerHeight * (0.45 + Math.random() * 0.3);
        this.startX = this.x;           // 進場點：遠走時拿來鏡像出 V 字的另一邊
        this.startBottom = this.bottom;

        this.el = document.createElement('div');
        this.el.className = 'cameo'; // 沿用客串樣式：pixelated、不可點擊
        this.el.style.bottom = '0px';
        this.el.style.zIndex = 20001; // 叼著果實的主角時刻：蓋過場上所有東西
        this.img = document.createElement('img');
        this.img.className = 'sprite';
        this.img.style.height = `${this.height}px`;
        // 原圖面向左：往右飛要鏡像
        this.img.style.transform = this.direction === 1 ? 'scaleX(-1)' : '';
        this.img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shinyDir}${id}.gif`;
        // 備援同客串：動圖 → 靜圖 → 兩段都失敗就取消這場搶食
        this.img.onerror = () => {
            this.img.onerror = () => {
                this.img.onerror = null;
                this.dead = true;
            };
            this.img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shinyDir}${id}.png`;
        };
        this.el.appendChild(this.img);
        app.appendChild(this.el);
        this.render();
    }

    // 身體寬（載入前用高度概算，跟客串同一招）
    width() {
        return this.el.offsetWidth || this.height;
    }

    // 回傳是否還在演（false = 該移除了）
    update(deltaTime) {
        if (this.dead) { this.abort(); return false; }
        const dt = deltaTime / (1000 / 60);
        if (this.phase === 'DIVE') {
            if (!berries.includes(this.berry)) {
                // 防禦：俯衝到一半果實意外沒了（現行規則下到不了這裡，
                // 但規則會演化）——空爪轉遠走，目擊者直接解脫、不用沮喪
                if (this.victim?.state === 'SNATCH_WATCH') this.victim.state = 'WALKING';
                this.startFlee();
            } else {
                // 逐幀朝果實「當下位置」修正的等速直線：果實還在半空
                // 也接得住（直接空中攔截），落了地就是俯衝到地面叼起
                const tx = this.berry.x - this.width() / 2;
                const ty = this.berry.bottom + SNATCH_LIFT;
                const dx = tx - this.x;
                const dy = ty - this.bottom;
                const dist = Math.hypot(dx, dy);
                const step = this.speed * dt;
                if (dist <= step) {
                    this.x = tx;
                    this.bottom = ty;
                    this.grabBerry();
                } else {
                    this.x += (dx / dist) * step;
                    this.bottom += (dy / dist) * step;
                }
            }
        } else {
            // FLEE：沿鏡像角度恆速直線飛（fleeSpeed 是字面上的每幀位移）。
            // 縮小與變淡「分軌計時」，各吃各的倍速（外部可調、逐幀讀取）：
            // 縮小走 1/(1+k·t) 的透視曲線（近快遠慢），
            // 透明度前段幾乎不淡（看得清楚戰利品），尾段 1 - t² 一口氣收乾淨
            this.shrinkT = Math.min(1, this.shrinkT
                + (deltaTime / SNATCH_FLEE_MS) * Math.max(0, CONFIG.snatchShrinkRate ?? 1));
            this.fadeT = Math.min(1, this.fadeT
                + (deltaTime / SNATCH_FLEE_MS) * Math.max(0, CONFIG.snatchFadeRate ?? 1));
            this.x += this.fleeVX * dt;
            this.bottom += this.fleeVY * dt;
            this.scale = 1 / (1 + SNATCH_RECEDE * this.shrinkT);
            this.el.style.opacity = (1 - this.fadeT * this.fadeT).toFixed(3);
            // 淡完或飛出畫面，先到者為準（變淡倍速 0 = 永不淡，就飛到出界為止）
            if (this.fadeT >= 1
                || this.x > window.innerWidth + this.margin || this.x < -this.margin) {
                return false;
            }
        }
        this.render();
        return true;
    }

    // 遠走高飛的起手式：方向 = 進場俯衝段（進場點 → 當下）的鏡像，
    // 跌多少就爬多少，V 字左右對稱；近水平的空中攔截至少抬 25% 仰角，
    // 別貼著地平線飛出去
    startFlee() {
        this.phase = 'FLEE';
        this.shrinkT = 0;
        this.fadeT = 0;
        const run = Math.max(Math.abs(this.x - this.startX), 1);
        const rise = Math.max(Math.abs(this.bottom - this.startBottom), run * 0.25);
        const len = Math.hypot(run, rise);
        this.fleeVX = this.direction * this.fleeSpeed * (run / len);
        this.fleeVY = this.fleeSpeed * (rise / len);
    }

    // V 字底部：叼走果實、開始遠走高飛
    grabBerry() {
        this.startFlee();
        // 果實從場上除名，改掛到腳下一起飛——是同一個元素搬家，
        // 之後整體的 scale 與淡出會帶著它一起變小變淡；
        // 地上的影子收掉（果實已經上天，影子留著就穿幫）
        const i = berries.indexOf(this.berry);
        if (i >= 0) berries.splice(i, 1);
        this.berry.shadow?.remove();
        this.berry.el.style.left = '50%';
        this.berry.el.style.transform = 'translateX(-50%)';
        this.berry.el.style.bottom = `${-SNATCH_LIFT}px`;
        this.el.appendChild(this.berry.el);
        this.carrying = true;
        // 目擊者親眼看著到嘴的果實飛了：驚嘆號換成一團黑線，
        // 沮喪計時走完自己會回去散步。中途被抓走/送走的就不演了
        if (this.victim?.state === 'SNATCH_WATCH') {
            this.victim.watchTimer = SNATCH_GLOOM_MS;
            if (!this.victim.showEmote('scribble', SNATCH_GLOOM_MS)) {
                this.victim.hideEmote();
            }
        }
    }

    // 意外收場（載圖全滅）：無主果實還在場上就收掉（沒有 feeder，
    // 不收就永遠躺著占位），目擊者也立刻解脫，別對著空氣沮喪
    abort() {
        if (!this.carrying) removeBerry(this.berry);
        if (this.victim?.state === 'SNATCH_WATCH') {
            this.victim.state = 'WALKING';
            this.victim.hideEmote();
        }
    }

    render() {
        const s = this.phase === 'FLEE' ? ` scale(${this.scale.toFixed(3)})` : '';
        this.el.style.transform = `translate3d(${this.x}px, ${-Math.round(this.bottom)}px, 0)${s}`;
    }
}

// 搶食擲骰：點擊丟果實「成功指派後」擲一次；追到一半被抓走再放開，
// 落地時依新的距離再擲（兩個入口都來這裡，snatchable 旗把遙控
// feed 與信使鳥空投擋在外面）。距離超過門檻才擲，擲中就埋伏筆——
// 這裡不動任何畫面，被盯上的那隻照常起跑，玩家看不出異狀
function maybeMarkSnatch(berry) {
    if (!berry.snatchable) return;             // 點擊丟的才可能被盯上
    if (pendingSnatch || activeSnatch) return; // 一次只演一場
    if (!window.POKE_FLYING?.length) return;   // 名單檔沒載到就沒有賊鳥
    const dist = Math.abs(berry.feeder.centerX() - berry.x);
    if (dist <= Math.max(0, CONFIG.snatchDistance ?? 300)) return; // 夠近 = 護得住
    if (Math.random() >= (CONFIG.snatchChance ?? 0)) return;
    // 觸發點 = 走完一半路程；到點才開演，見 updateSnatch
    pendingSnatch = { berry, seeker: berry.feeder, triggerDist: dist / 2 };
}

// 伏筆兌現：賊鳥進場、被盯上的那隻再冒一次驚嘆號原地停步，
// 果實同時變無主（沒有 feeder 就不會被任何隻接手，賊鳥的目標跑不掉）。
// 苦主被玩家抓在手上的話不演目擊戲——牠正忙著掙扎，沒空驚嘆
// 也沒空沮喪（victim 留空缺）；targetBerry 留著，放手時若還來得及
// 撞見俯衝，release() 會補開演
function beginSnatch(berry, seeker) {
    berry.feeder = null;
    const held = seeker.state === 'HELD';
    if (!held) {
        seeker.targetBerry = null;
        seeker.startSnatchWatch();
    }
    // 賊鳥從飛行池抽。體型同步查本地身高表（查不到當中型）：
    // 開演的當下就要鎖住場面，不等 getSizeScale 的網路備援
    const id = window.POKE_FLYING[randomInt(0, window.POKE_FLYING.length - 1)];
    const dm = window.POKE_HEIGHTS?.[id];
    const scale = dm === undefined ? fallbackSizeScale() : scaleFromDeciMeters(dm);
    activeSnatch = new Snatcher(id, scale, berry, held ? null : seeker);
    // 目擊者的保險絲跟著實際航程重算：俯衝速度現在開放外部調整
    // （snatchDiveRate），演得再慢目擊者也不會提前走人；
    // 叼走那一刻會再改設為沮喪時長
    if (!held) {
        const diveDist = Math.hypot(
            activeSnatch.x - berry.x, activeSnatch.bottom - berry.bottom);
        seeker.watchTimer = (diveDist / activeSnatch.speed) * (1000 / 60) + 8000;
    }
}

// 每一幀推進（gameLoop 呼叫）：伏筆期盯著「走到一半沒」，
// 開演後推劇情，演完（或意外死亡）就清場
function updateSnatch(deltaTime) {
    if (pendingSnatch) {
        const { berry, seeker, triggerDist } = pendingSnatch;
        if (!berries.includes(berry) || seeker.targetBerry !== berry
            || (seeker.state !== 'SEEK_BERRY' && seeker.state !== 'HELD')) {
            // 果實沒了（被 leave 送走）或流程斷了（已經站到嘴邊開吃）：
            // 伏筆作廢，這齣不演了
            pendingSnatch = null;
        } else if (seeker.state === 'HELD') {
            // 追果實的那隻被玩家抓在半空：果實沒人護著，賊鳥豈有
            // 等牠走完半程的道理——伏筆立刻兌現（目擊戲的取捨見 beginSnatch）
            pendingSnatch = null;
            beginSnatch(berry, seeker);
        } else if (Math.abs(seeker.centerX() - berry.x) <= triggerDist) {
            pendingSnatch = null;
            beginSnatch(berry, seeker);
        }
    }
    if (activeSnatch && !activeSnatch.update(deltaTime)) {
        activeSnatch.el.remove();
        activeSnatch = null;
    }
}
