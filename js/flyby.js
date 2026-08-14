// ---------------------------------------------------------
// 客串事件 (Fly-by Cameo)
// 三層機率：
//   1. 隨機間隔——從 flybyDelay 區間抽下一個「擲骰時點」
//   2. flybyChance——該時點是否真的觸發
//   3. 抽誰——飛行池平均分佈，flybyLegendaryChance 的極低機率改抽傳說池
// 客串不加入常駐陣容：從畫面外高速橫越，飛出另一側就移除。
// 色違吃全頁同一個 shinyChance，中了會拖著金色星塵尾跡（流星本人）
// ---------------------------------------------------------
class Cameo {
    constructor(id, sizeScale, opts = {}) {
        this.dead = false;
        this.delivery = !!opts.delivery; // 空投任務：叼著果實，半路鬆爪
        this.carried = null; // 叼著的那顆果實元素
        this.dropX = null;   // 預定投放點（試過一次就清掉，不回頭）
        this.direction = Math.random() > 0.5 ? 1 : -1;
        // 每次 ±15% 隨機，連續兩次客串速度也不會一模一樣
        this.speed = (CONFIG.flybySpeed ?? 5) * (0.85 + Math.random() * 0.3);
        this.isShiny = Math.random() < (CONFIG.shinyChance ?? 0);
        const shinyDir = this.isShiny ? 'shiny/' : '';

        this.height = Math.round(CONFIG.baseSize * sizeScale);
        this.el = document.createElement('div');
        this.el.className = 'cameo';
        // 高度以 bottom: 0 為基準，實際垂直位置全走 transform
        // （斜線 + 浮沉每一幀都在變，translate 不觸發 layout）
        this.el.style.bottom = '0px';

        this.img = document.createElement('img');
        this.img.className = 'sprite';
        this.img.style.height = `${this.height}px`;
        // 原圖面向左：往右飛要鏡像
        this.img.style.transform = this.direction === 1 ? 'scaleX(-1)' : '';
        this.img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shinyDir}${id}.gif`;
        // 備援同散步成員：動圖 → 靜圖 → 直接取消這次客串
        this.img.onerror = () => {
            this.img.onerror = () => {
                this.img.onerror = null;
                this.dead = true;
            };
            this.img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shinyDir}${id}.png`;
        };
        this.el.appendChild(this.img);

        // 出發點：畫面外一個身位（寬度未載入前用高度概算，流星不等人）
        this.margin = this.height * 1.5 + 40;
        this.startX = this.direction === 1 ? -this.margin : window.innerWidth + this.margin;
        this.x = this.startX;
        this.trailTimer = 0;

        // 斜線航道：起點與終點高度「各自」在視窗高 45% ~ 75% 內隨機——
        // 這趟可能從左 45% 爬升到右 60%，下一趟從右 70% 滑降到左 50%。
        // （45%~75%：OBS 全畫布時劃過半空，200px 的 footer iframe 也還在框內、
        //   於散步成員的頭頂之上）
        const altitude = () => window.innerHeight * (0.45 + Math.random() * 0.3);
        this.startBottom = altitude();
        this.endBottom = altitude();
        // 每前進 1px 的爬升/下降量，以出發當下的全程距離換算
        this.slope = (this.endBottom - this.startBottom) / (window.innerWidth + this.margin * 2);

        // 浮沉：飛行版的小跳步。走路是 |sin| 的落地彈跳，
        // 飛行是完整 sin 波的上下漂浮；振幅與節奏每隻略異，不會像編隊飛行
        this.floatPhase = Math.random() * Math.PI * 2;
        this.floatAmp = 3 + Math.random() * 4;          // 3 ~ 7 px
        this.floatFreq = 0.003 + Math.random() * 0.003; // 相位速度 rad/ms

        // 空投任務：果實掛在腳下跟著飛，投放點在活動範圍內隨機挑
        // （散步成員才搆得到落點，不會丟到牆外沒人撿）
        if (this.delivery) {
            this.carried = document.createElement('img');
            this.carried.className = 'berry';
            this.carried.src = getBerryURI();
            this.carried.style.width = `${BERRY_ART[0].length * BERRY_SCALE}px`;
            this.carried.style.left = '50%';
            this.carried.style.transform = 'translateX(-50%)';
            this.carried.style.bottom = '-24px'; // 叼在腳下，稍微咬進腳邊
            this.el.appendChild(this.carried);
            this.dropX = window.innerWidth
                * (CONFIG.bounds.min + Math.random() * (CONFIG.bounds.max - CONFIG.bounds.min));
        }

        app.appendChild(this.el);
        this.render();
    }

    // 回傳是否還在畫面行程內（false = 該移除了）
    update(deltaTime) {
        if (this.dead) return false;
        const dt = deltaTime / (1000 / 60);
        this.x += this.speed * this.direction * dt;
        this.floatPhase += deltaTime * this.floatFreq;

        // 色違的星塵尾跡：定時在「身後」撒一顆金星，飄落漸淡
        if (this.isShiny) {
            this.trailTimer -= deltaTime;
            if (this.trailTimer <= 0) {
                this.dropTrailStar();
                this.trailTimer = 90;
            }
        }

        this.render();

        // 空投：飛越預定投放點時鬆爪，果實從飛行高度掉下去、
        // 走一般的餵食流程。這一刻沒隻有空（throwBerry 婉拒）就整顆
        // 叼走——果實不落在沒人吃的地上；只試這一次，飛過了不回頭
        if (this.carried && this.dropX !== null
            && (this.direction === 1 ? this.x >= this.dropX : this.x <= this.dropX)) {
            const w = this.el.offsetWidth || this.height;
            if (throwBerry(this.x + w / 2, Math.max(0, this.curBottom - 24))) {
                this.carried.remove();
                this.carried = null;
            }
            this.dropX = null;
        }

        return this.direction === 1
            ? this.x <= window.innerWidth + this.margin
            : this.x >= -this.margin;
    }

    render() {
        // 垂直位置 = 航道起點高度 + 斜率 × 已飛距離 + 浮沉波
        const traveled = Math.abs(this.x - this.startX);
        this.curBottom = this.startBottom + traveled * this.slope
                         + Math.sin(this.floatPhase) * this.floatAmp;
        this.el.style.transform = `translate3d(${this.x}px, ${-Math.round(this.curBottom)}px, 0)`;
    }

    dropTrailStar() {
        const shape = Math.random() < 0.5 ? 'big' : 'small';
        const star = document.createElement('img');
        star.className = 'burst-star';
        star.src = getStarURI(shape, Math.random() < 0.5 ? '#ecb200' : '#ffd84d');
        star.style.width = `${STAR_ARTS[shape][0].length * 2}px`;
        star.style.animationDuration = '700ms';
        // 撒在目前身體中央（跟著斜線航道的當下高度），靠 CSS 動畫往後下方飄散
        star.style.left = `${Math.round(this.x + this.height * 0.6)}px`;
        star.style.bottom = `${Math.round(this.curBottom + this.height * 0.45)}px`;
        star.style.zIndex = 9999; // 墊在本體後面一階
        star.style.setProperty('--dx', `${-this.direction * (14 + Math.round(Math.random() * 18))}px`);
        star.style.setProperty('--dy', `${10 + Math.round(Math.random() * 16)}px`);
        star.addEventListener('animationend', () => star.remove());
        app.appendChild(star);
    }
}

// 排程器：抽下一個擲骰時點 → 到點擲骰 → 不論中沒中，再排下一輪。
// 分頁在背景時這次擲骰直接作廢：setTimeout 在背景照跑，但 rAF 是停的，
// 生出來的客串只會凍在半空累積，切回分頁的瞬間全員同時起飛（流星雨）。
// OBS 的瀏覽器來源永遠算可見，不受影響
function scheduleFlyby() {
    const delay = randomInt(CONFIG.flybyDelay.min, CONFIG.flybyDelay.max);
    setTimeout(() => {
        if (!document.hidden && Math.random() < (CONFIG.flybyChance ?? 0)) spawnFlyby();
        scheduleFlyby();
    }, delay);
}

// 信使鳥：叼果實空投的專職快遞員（聖誕鳥送禮的原作梗）
const DELIVERY_ID = 225;

async function spawnFlyby() {
    // 信使鳥空投：小機率這趟客串改派信使鳥叼著果實橫越，半路鬆爪空投，
    // 落地後就是一般的餵食流程（果實總開關關著就不派這趟任務）
    if ((CONFIG.berry ?? 'on') !== 'off'
        && Math.random() < (CONFIG.flybyDeliveryChance ?? 0)) {
        cameos.push(new Cameo(DELIVERY_ID, await getSizeScale(DELIVERY_ID), { delivery: true }));
        return;
    }
    const legendary = Math.random() < (CONFIG.flybyLegendaryChance ?? 0);
    const pool = legendary ? window.POKE_LEGENDARY : window.POKE_FLYING;
    if (!pool || !pool.length) return;
    const id = pool[randomInt(0, pool.length - 1)];
    // 體型分級與散步成員同一套，世界觀比例一致（傳說通常就是大隻）
    cameos.push(new Cameo(id, await getSizeScale(id)));
}
