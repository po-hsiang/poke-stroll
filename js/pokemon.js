// ---------------------------------------------------------
// 寶可夢類別 (Pokemon Class)
// 這就像是用 Golang 定義一個 Struct，包含狀態與行為
// ---------------------------------------------------------
// 寒暄站位時，兩隻身體邊緣之間留的空隙（畫面 px）
const GREET_GAP = 16;
// 被抓在手上時的掙扎動畫：擺動的基礎相位速度（rad/ms）與最大傾角（度）。
// GIF 的播放速率瀏覽器不給控制，「掙扎得多快」就靠這兩個值 × dragStruggleRate
const STRUGGLE_FREQ = 0.012;
const STRUGGLE_TILT = 10;
// 「發現」的驚訝節奏，發現果實與發現賊鳥共用同一套肢體語言：
// 停下手邊的動作 → 原地跳一下並亮驚嘆號 → 定格走完才接下一步
// （追果實／換黑線）。定格蓋住起跳到落地的時間，跳完還留半拍餘韻
const STARTLE_MS = 600;
const EXCLAIM_MS = 1500; // 驚嘆號框的停留時長（黑線出現時會提前換掉）

class Pokemon {
    constructor(id, container, sizeScale, laneIndex, groundLift = 0) {
        this.id = id;
        this.container = container;
        this.sizeScale = sizeScale;

        // 狀態屬性
        // 出生點：把「允許活動範圍」(bounds) 分成 count 條跑道，
        // 每隻站在自己跑道的中心點，再加 ±20% 跑道寬的小抖動。
        // 相鄰間距至少保有 60% 跑道寬，出生時絕不重疊；
        // 抖動則避免完美等距的「閱兵感」。
        // （取跑道中心而非頭尾等分點：count = 1 不會除以零，
        //   頭尾兩隻也不會貼著邊界出生、下一幀就觸發撞牆掉頭）
        const roamMin = window.innerWidth * CONFIG.bounds.min;
        const roamWidth = window.innerWidth * (CONFIG.bounds.max - CONFIG.bounds.min);
        const laneWidth = roamWidth / CONFIG.count;
        const jitter = (Math.random() - 0.5) * laneWidth * 0.4;
        this.x = roamMin + (laneIndex + 0.5) * laneWidth + jitter;
        this.direction = Math.random() > 0.5 ? 1 : -1; // 1: 向右, -1: 向左
        this.state = 'WALKING'; // WALKING | IDLE
        this.speed = CONFIG.baseSpeed + Math.random() * CONFIG.speedVariance; // 隨機速度差異
        this.idleTimer = 0;
        this.avoidCooldown = 0; // 因避讓而掉頭後的冷卻時間
        this.targetBerry = null; // 正在追的那顆果實（一隻只追一顆）
        this.greetPartner = null; // 正在寒暄的對象（偶遇打招呼）
        this.greetTimer = 0;
        this.greetCooldown = 0; // 寒暄後的冷卻：同一對不會在原地無限寒暄
        this.watchTimer = 0; // 目擊空中搶食的呆站計時（見 SNATCH_WATCH）

        // 走路跳步動畫（GIF 本身只有原地待機動畫，沒有腳步，
        // 補上垂直的小跳躍才不會像滑行）
        this.walkPhase = Math.random() * Math.PI * 2; // 隨機起始相位，避免大家同步跳
        // 每隻跳的高度略有不同，體型越小跳得越低
        this.hopHeight = (CONFIG.hopHeight + Math.random() * CONFIG.hopVariance)
                         * (0.6 + sizeScale * 0.6);
        this.bobY = 0; // 目前離地高度

        // DOM 元素建立
        this.el = document.createElement('div');
        this.el.className = 'pokemon-container';
        // 有主題地面時整個容器抬高，站上地面的表面
        // （影子、對話框、星星都在容器裡，會一起跟上去）
        if (groundLift) this.el.style.bottom = `${groundLift}px`;

        // 陰影（保留參考，跳起來時要縮小它）。
        // 寬度以「圖片實際顯示寬度」為準，讓影子跟寶可夢差不多寬；
        // 圖片載入前先用體型估一個過渡值。
        // 顏色依主屬性染色（暗色系），查不到屬性就用預設黑影
        this.shadow = document.createElement('div');
        this.shadow.className = 'shadow';
        // 寬度另外記一份：投射影要靠它算「往外長多少」（見 sunShadowTransform）
        this.shadowW = Math.round(48 * sizeScale + 8);
        this.shadow.style.width = `${this.shadowW}px`;
        const primaryType = window.POKE_TYPES ? window.POKE_TYPES[id] : undefined;
        this.shadow.style.background =
            CONFIG.typeShadowColors?.[primaryType] || CONFIG.typeShadowColors?.default
            || 'rgba(0, 0, 0, 0.2)';
        this.el.appendChild(this.shadow);

        // 色違判定：每一隻「獨立」擲骰，不是一次骰全體
        this.isShiny = Math.random() < (CONFIG.shinyChance ?? 0);
        const shinyDir = this.isShiny ? 'shiny/' : '';

        // 圖片：高度依體型分級縮放（寬度 auto，會等比例跟著縮）
        this.img = document.createElement('img');
        this.img.className = 'sprite';
        this.img.style.height = `${Math.round(CONFIG.baseSize * sizeScale)}px`;
        // 使用 PokéAPI 的 GitHub Raw 資源庫，這是第五世代的動態 GIF，非常可愛
        // （色違版只差一層 shiny/ 目錄，動圖與靜圖皆同）
        this.img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shinyDir}${this.id}.gif`;

        // 載入失敗處理 (有些稀有 ID 可能沒有動圖)。
        // 備援只有一次機會：觸發時先換掛「最終防線」再換圖，
        // 靜態圖也失敗（網路異常、來源被擋）就整隻隱藏，
        // 不露瀏覽器的破圖示，也杜絕 onerror 反覆觸發的重試迴圈
        this.img.onerror = () => {
            this.img.onerror = () => {
                this.img.onerror = null;
                this.el.style.display = 'none';
            };
            // 動圖失敗，退回使用一般靜態圖（色違同樣有 shiny/ 靜態圖）
            this.img.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shinyDir}${this.id}.png`;
        };

        // 圖片載入後把影子寬度對齊「實際顯示寬度 × shadowWidthRatio」
        // （換成備援圖時 load 會再觸發一次，寬度自動跟著重算）
        this.img.addEventListener('load', () => {
            if (this.img.offsetWidth) {
                const ratio = CONFIG.shadowWidthRatio ?? 0.9;
                this.shadowW = Math.round(this.img.offsetWidth * ratio);
                this.shadow.style.width = `${this.shadowW}px`;
            }
        });

        // 心情對話框（發呆時隨機冒出）。
        // 放大倍率取整數，像素才不會被非整數縮放糊掉：小體型 2x、大體型 3x。
        // 顯示寬度依各圖案的框寬而定，在 maybeShowEmote 時才設定
        this.bubbleScale = Math.max(2, Math.round(sizeScale * 3));
        this.bubble = document.createElement('img');
        this.bubble.className = 'bubble';
        this.bubble.style.display = 'none';
        this.bubbleName = null;   // 目前顯示的圖案（換邊重擺時要重新取圖）
        this.bubbleSide = 0;      // 目前擺在哪一側（1 右 / -1 左），要換邊才重擺
        this.bubbleLocked = false; // 保護期：期間內不被其他心情覆蓋（色違登場用）
        // placeBubble 算出的左右位移（不含抬升）。updateDOM 每幀把離地高度
        // 接在它後面——兩者掛同一個 transform，得留一份底稿才組得起來
        this.bubbleBase = null;
        this.el.appendChild(this.bubble);

        this.el.appendChild(this.img);

        // 水面倒影：站在會反光的地形上才掛（水域），其餘地形連元素都不會有。
        // 掛在容器裡 → 位置、隱藏、移除都跟著本體走，不必另外照顧
        attachReflection(this);

        // 名牌（頭頂的「No.25 皮卡丘」）：同樣掛在容器裡，nametag: 'off' 時不產生。
        // 要在色違登場的閃光之前掛好——placeBubble 會問名牌佔了頭頂沒有
        this.nametag = null;
        attachNametag(this);

        // 滑鼠互動（三種按法各司其職，見「滑鼠拖曳」一節的分流表）。
        // OBS 可用來源的「互動」視窗玩；iframe 預設 pointer-events: none 點不到，
        // 想開放給訪客要自行拿掉（取捨見 README）
        this.jumpY = 0; // 點擊跳躍目前的離地高度（與走路跳步疊加）
        this.jumpV = 0; // 點擊跳躍的垂直速度
        this.holdY = 0; // 被抓在手上時的離地高度（見「滑鼠拖曳」一節）
        this.struggleAngle = 0; // 掙扎中的傾角（度）
        this.grabDX = 0; // 抓起來那一刻，游標與身體左緣／地面的相對位置
        this.grabDY = 0;
        this.resnatchOnLand = false; // 追果實中被抓又放開：落地那一刻重擲賊鳥的骰（見 release）
        this.seekStartle = 0; // 發現果實的驚訝定格：> 0 時原地跳一下再起跑（見 seekBerry）
        // 左鍵按下去的那一刻就抓起來——沒有長按門檻，游標不會先跑掉一段
        this.el.addEventListener('pointerdown', e => beginDrag(this, e));
        // 右鍵：擋掉系統選單（「另存圖片」），改演戳戳互動。
        // 行動裝置的長按也會送 contextmenu，但那時牠已經在手上了，
        // poke() 的 HELD 防護會擋下來，不會抓著又被戳
        this.el.addEventListener('contextmenu', e => {
            e?.preventDefault?.();
            this.poke();
        });
        // 本體上的左鍵 click 到此為止：別冒泡到 document——
        // 那裡掛著「點空白處丟果實」，點到身上不該掉果實
        this.el.addEventListener('click', e => e?.stopPropagation());
        // sprite 是 <img>，瀏覽器預設可以被原生拖放（會拖出一張半透明鬼影，
        // 蓋掉我們自己的拖曳、放開手還會被當成外部檔案），直接擋掉
        this.img.addEventListener('dragstart', e => e?.preventDefault?.());

        this.container.appendChild(this.el);

        // 初始化渲染
        this.updateDOM();

        // 色違登場儀式：一出場必定亮出金色閃光（不吃 bubbleChance 機率，
        // 但尊重 bubblePosition=none 的全域關閉），4 秒後自動收起。
        // 這個閃光同樣是一種心情表達，且是色違的專屬署名，所以整段期間上鎖：
        // 登場後隨即發呆（或被戳）不會把它瞬間換成別的心情、也不會提前收走。
        // 星星特效等圖片載入、本體現身那一刻再炸開，儀式感才對得上
        if (this.isShiny) {
            this.showEmote('sparkle', 4000, true);
            this.img.addEventListener('load', () => this.celebrateShiny(), { once: true });
        }
    }

    // 每一幀的邏輯更新 (Update Loop)
    update(deltaTime, others) {
        if (this.avoidCooldown > 0) this.avoidCooldown -= deltaTime;
        if (this.greetCooldown > 0) this.greetCooldown -= deltaTime;

        // 點擊跳躍：初速 + 重力的迷你拋物線，和走路跳步（|sin| 波）各自獨立計算
        if (this.jumpV !== 0 || this.jumpY > 0) {
            const dt = deltaTime / (1000 / 60);
            this.jumpY += this.jumpV * dt;
            this.jumpV -= 0.4 * dt; // 重力
            if (this.jumpY <= 0) {
                this.jumpY = 0;
                this.jumpV = 0;
                // 追果實中被抓又放開的：落地這一刻才重擲賊鳥的骰——
                // 距離以「腳踏實地」的位置為準，半空中的都不算數（見 release）
                if (this.resnatchOnLand) {
                    this.resnatchOnLand = false;
                    if (this.state === 'SEEK_BERRY' && this.targetBerry
                        && berries.includes(this.targetBerry)) {
                        maybeMarkSnatch(this.targetBerry);
                    }
                }
            }
        }

        if (this.state === 'HELD') {
            // 在手上：位置由游標決定，這裡只演掙扎
            this.struggle(deltaTime);
        } else if (this.state === 'WALKING') {
            this.walk(deltaTime);
            this.avoidCrowding(others);
        } else if (this.state === 'IDLE') {
            this.idle(deltaTime);
        } else if (this.state === 'GREETING') {
            this.greet(deltaTime);
        } else if (this.state === 'SEEK_BERRY') {
            this.seekBerry(deltaTime);
        } else if (this.state === 'EATING') {
            this.eatBerry(deltaTime);
        } else if (this.state === 'FEED_HEART') {
            // 吃完的餘韻：愛心演完這隻的餵食才算結束
            this.bobY *= 0.8;
            this.heartTimer -= deltaTime;
            if (this.heartTimer <= 0) {
                this.state = 'WALKING'; // 忙完了，之後才會發現下一顆果實
            }
        } else if (this.state === 'SNATCH_WATCH') {
            // 目擊空中搶食：站在原地看戲（驚嘆號 → 被叼走那一刻換黑線），
            // 計時走完才回去散步。這個計時同時是保險絲——
            // 賊鳥意外消失（載圖全滅等）也不會呆站到永遠
            this.bobY *= 0.8;
            this.watchTimer -= deltaTime;
            if (this.watchTimer <= 0) this.state = 'WALKING';
        }

        // 邊界檢查：只能在 bounds 指定的 X 軸比例區間內活動。
        // 每一幀都用「當下的」視窗寬度計算，所以視窗縮放時會自動修正
        const width = this.img.offsetWidth || CONFIG.baseSize * this.sizeScale;
        const minX = window.innerWidth * CONFIG.bounds.min;
        const maxX = window.innerWidth * CONFIG.bounds.max - width; // 扣掉自身寬度，右緣不超線
        if (maxX <= minX) {
            // 活動範圍窄到塞不下自己（大體型 + 窄範圍的組合）：
            // 釘在左界原地踏步。若放任兩個夾點互相彈，會每幀翻面抖動
            this.x = minX;
        } else if (this.x < minX) {
            this.x = minX;
            // 撞到左邊界回頭。被抓著的那隻不轉向：游標拉出界時牠是
            // 貼著邊界繼續掙扎，每幀翻面會抖成一團
            if (this.state !== 'HELD') this.direction = 1;
        } else if (this.x > maxX) {
            this.x = maxX;
            if (this.state !== 'HELD') this.direction = -1; // 撞到右邊界回頭
        }

        this.updateDOM();
    }

    walk(deltaTime) {
        // 以 60fps 為基準做時間校正，移動速度不受螢幕更新率影響。
        // 夜裡走慢一點（見 js/circadian.js）——追果實用的是 seekBerry
        // 自己的小跑速度，不吃這個折扣
        const dt = deltaTime / (1000 / 60);
        this.x += this.speed * moveScale() * this.direction * dt;

        // 用 |sin| 波模擬小跳步，速度越快的跳越頻繁（夜裡跳得低一點）
        this.walkPhase += deltaTime * CONFIG.hopFrequency * (this.speed / CONFIG.baseSpeed);
        this.bobY = Math.abs(Math.sin(this.walkPhase)) * this.hopHeight * hopScale();

        // 隨機決定是否停下來看鏡頭（夜裡停得更頻繁、也站得更久）
        if (Math.random() < idleChanceNow()) {
            this.state = 'IDLE';
            // 設定發呆時間
            this.idleTimer = Math.round(
                randomInt(CONFIG.lookTime.min, CONFIG.lookTime.max) * idleTimeScale());
            this.maybeShowEmote();
        }
    }

    // 顯示指定的心情對話框（尊重 bubblePosition 的全域關閉）。
    // duration > 0：幾毫秒後自動收起（0 = 留到發呆結束才收）
    // lock：保護期，期間內不接受其他心情覆蓋、也不會被提前收起
    // 回傳是否真的顯示了
    showEmote(name, duration = 0, lock = false) {
        const mode = CONFIG.bubblePosition ?? 'side';
        if (mode === 'none') return false; // 嵌入方選擇完全關閉對話框
        if (this.bubbleLocked) return false; // 保護期中（色違登場的金色閃光還沒演完）
        clearTimeout(this.bubbleTimer); // 別讓前一個自動收起計時（點擊愛心）誤傷這次的對話框
        this.bubbleName = name;
        // 寬度 = 該圖案的框寬 × 整數倍率（框寬依內容而不同，如驚嘆號是瘦框）
        this.bubble.style.width = `${(EMOTE_ICONS[name].frameWidth ?? 20) * this.bubbleScale}px`;
        this.placeBubble();
        this.bubble.style.display = 'block';

        if (lock) this.bubbleLocked = true;
        if (duration > 0) {
            this.bubbleTimer = setTimeout(() => {
                this.bubbleLocked = false; // 保護期到此為止
                this.hideEmote();
            }, duration);
        }
        return true;
    }

    // 收起對話框（保護期內一律讓路，例如色違剛登場就結束發呆）
    hideEmote() {
        if (this.bubbleLocked) return;
        clearTimeout(this.bubbleTimer);
        this.bubble.style.display = 'none';
    }

    // side 模式的對話框寬度與空隙（都是純算術，可以每幀重算不碰 DOM）。
    // gap 的設定值是「點陣圖上的像素」，乘上放大倍率換成畫面 px；
    // 取整數避免半像素位移把點陣圖弄糊（負數代表往身體上疊）
    bubbleMetrics() {
        return {
            width: (EMOTE_ICONS[this.bubbleName].frameWidth ?? 20) * this.bubbleScale,
            gap: Math.round((CONFIG.bubbleSideGap ?? 2) * this.bubbleScale),
        };
    }

    // 對話框要放哪一側（回傳 1 = 右、-1 = 左）。
    // 原則上跟著面向，但「快出畫面就翻到內側」：頁面 overflow 是 hidden，
    // 貼著邊界的那隻若照面向擺，框會被畫面邊緣切掉半個。
    // 兩側都塞不下（視窗超窄）就維持面向，不要每幀左右彈跳
    desiredBubbleSide() {
        if ((CONFIG.bubblePosition ?? 'side') !== 'side') return this.direction;
        const { width, gap } = this.bubbleMetrics();
        const bodyW = this.img.offsetWidth || CONFIG.baseSize * this.sizeScale;
        const fitsRight = this.x + bodyW + gap + width <= window.innerWidth;
        const fitsLeft = this.x - gap - width >= 0;
        if (this.direction === 1 && !fitsRight && fitsLeft) return -1;
        if (this.direction === -1 && !fitsLeft && fitsRight) return 1;
        return this.direction;
    }

    // 擺位 + 尾巴朝向：
    // top  = 頭頂正上方（尾巴朝下，維持預設朝向）
    // side = 由 desiredBubbleSide() 決定的那一側斜上方，垂直錨在身高六成處。
    //        整個框推到本體邊界「之外」再留一點空隙——切齊或半重疊都會被
    //        大鉗蟹、鐵甲蛹這類寬體型蓋住；尾巴則鏡像成朝內指回本體
    //        （框在右側 → 尾巴朝左下）
    placeBubble(bubbleSide = this.desiredBubbleSide()) {
        const mode = CONFIG.bubblePosition ?? 'side';
        const side = mode === 'side';
        this.bubble.src = getEmoteURI(this.bubbleName, side ? -bubbleSide : 1);

        // 上下層：sprite 有 will-change: transform，會自成堆疊脈絡並被歸到
        // 「z-index: 0」那一階畫，又排在 bubble 之後，所以光靠 DOM 順序
        // 一定被它蓋掉——要用明確的正/負 z-index 才跨得過去
        this.bubble.style.zIndex = (CONFIG.bubbleLayer ?? 'front') === 'behind' ? -1 : 2;
        if (side) {
            const { gap } = this.bubbleMetrics();
            // 擺左側時要再往左退自己一個身（-100%）。gap 允許負數，
            // 所以正負分開組字串，避免產生 calc(-100% - -6px) 這種雙負號
            const back = gap >= 0 ? `- ${gap}px` : `+ ${-gap}px`;
            this.bubble.style.left = bubbleSide === 1 ? '100%' : '0';
            this.bubble.style.transform = bubbleSide === 1
                ? `translateX(${gap}px)`
                : `translateX(calc(-100% ${back}))`;
            // 垂直錨在身高六成處，再吃 bubbleSideLift 的幾個 px 微調。
            // 正負號分開組，避免 calc(60% + -3px) 這種雙符號
            const lift = Math.round(CONFIG.bubbleSideLift ?? 2);
            this.bubble.style.bottom = lift === 0
                ? '60%'
                : `calc(60% ${lift > 0 ? '+' : '-'} ${Math.abs(lift)}px)`;
        } else {
            this.bubble.style.left = '50%';
            this.bubble.style.transform = 'translateX(-50%)';
            // 名牌常駐（nametag: 'on'）時頭頂已經被佔走，對話框往上讓一層。
            // 'hover' 模式不讓：那塊名牌平常是收著的，為了偶爾滑過去的那一秒
            // 永遠空一排並不划算——真的滑過去時名牌在上層（z-index 3），
            // 蓋住的是對話框而不是名字
            const tagH = (CONFIG.nametag ?? 'hover') === 'on' && this.nametag
                ? this.nametag.offsetHeight + 2 : 0;
            this.bubble.style.bottom = `calc(100% + ${2 + tagH}px)`;
        }
        this.bubbleSide = bubbleSide; // 記住實際擺在哪側，換側時才動 DOM
        this.bubbleBase = this.bubble.style.transform; // 底稿：updateDOM 要接抬升上去
    }

    // 起跳：拋物線小跳的共用入口（點擊互動與發呆亂跳都走這裡）
    jump() {
        this.jumpV = 4 * (0.7 + 0.3 * this.sizeScale); // 起跳初速，體型越大跳得越高
    }

    // 被戳（滑鼠右鍵，或遙控 poke 指令）：小跳一下 + 冒愛心，1.6 秒後自動收起。
    // 走路中、發呆中、甚至半空中都可以戳（半空中再戳會重新起跳）。
    // 色違登場閃光的保護期內只跳、不換對話框
    poke() {
        if (this.state === 'HELD') return; // 正在手上掙扎，戳不動
        this.jump();
        this.showEmote('heart', 1600);
    }

    // 被抓起來。整隻等於暫時離場：寒暄放對方自由、對話框收起來。
    // 追到一半（SEEK_BERRY）的果實「留在原地不收」——主權（feeder /
    // targetBerry）也保留，別隻不會接手，放手後牠會回去續追（見 release）。
    // 已經吃進嘴裡的（EATING）照舊收掉：咬了幾口的果實留在地上太獵奇
    grab(pointer) {
        if (this.state === 'HELD') return;
        this.breakGreet();
        if (this.targetBerry && this.state !== 'SEEK_BERRY') {
            removeBerry(this.targetBerry);
            this.targetBerry = null;
        }
        this.resnatchOnLand = false; // 半空中再被抓走：上一次放手的掛帳作廢
        this.seekStartle = 0; // 驚訝定格作廢：放手續追時直接起跑（牠可沒忘記）
        this.state = 'HELD';
        this.idleTimer = 0;
        this.hideEmote();
        // 掙扎從相位 0 起算：擺盪與抖動都從「不動」開始長出來，
        // 左鍵輕點一下（抓起來隨即放開）才不會閃一格歪頭
        this.walkPhase = 0;
        // 抓起來的那一刻不跳位：先把當下的離地高度接管過來，
        // 再記住「游標與身體」的相對位置，之後就照這個位移跟著走
        this.holdY = this.bobY + this.jumpY;
        this.jumpY = 0;
        this.jumpV = 0;
        this.grabDX = pointer.x - this.x;
        this.grabDY = pointer.bottom - groundLevel - this.holdY;
        this.el.className = 'pokemon-container held';
        this.img.style.transformOrigin = '50% 50%'; // 吊在手上：以身體中心為支點擺盪
        this.dragTo(pointer);
    }

    // 跟著游標走：面向被拉的方向，X 每一幀還會被 update() 的邊界檢查
    // 夾回活動範圍（游標拉出界就貼著界線繼續掙扎，不會被拖出場外），
    // 高度夾在地面與「整隻還看得見」之間
    dragTo(pointer) {
        if (this.state !== 'HELD') return;
        const nx = pointer.x - this.grabDX;
        if (Math.abs(nx - this.x) > 1) this.direction = nx > this.x ? 1 : -1;
        this.x = nx;
        const height = this.img.offsetHeight || CONFIG.baseSize * this.sizeScale;
        const ceiling = Math.max(0, window.innerHeight - groundLevel - height);
        this.holdY = Math.min(Math.max(pointer.bottom - groundLevel - this.grabDY, 0), ceiling);
    }

    // 在手上掙扎的每一幀：高頻的上下抖 + 左右擺盪。
    // GIF 本身的播放速率瀏覽器不給控制，「掙扎感」是這裡自己畫的，
    // dragStruggleRate 就是它的倍速（2 = 兩倍快，0 = 不掙扎）
    struggle(deltaTime) {
        const rate = Math.max(0, CONFIG.dragStruggleRate ?? 2);
        this.walkPhase += deltaTime * STRUGGLE_FREQ * rate;
        this.bobY = Math.abs(Math.sin(this.walkPhase)) * this.hopHeight * 0.6;
        // 擺盪取一半頻率，跟上下抖錯開，才不會整齊得像機械
        this.struggleAngle = Math.sin(this.walkPhase * 0.5) * STRUGGLE_TILT;
    }

    // 放手：把手上的高度交還給跳躍系統，用同一套重力自由落體回地面。
    // 追到一半被抓的這時接回餵食流程，三種收場：
    //   1. 賊鳥正朝自己的果實俯衝（被抓期間出的手）→ 回到地面
    //      正好撞見，照舊開演目擊戲（驚嘆號 → 被叼走換黑線）；
    //   2. 果實還在 → 直接續追（不再冒驚嘆號——牠可從來沒忘記），
    //      落地那一刻依「新的距離」重擲一次賊鳥的骰（掛帳給 update，
    //      被抓去遠方再放開，遠的距離就要面對遠的風險）；
    //   3. 果實沒了（被叼走／被 leave 收走）→ 空手回去散步
    release() {
        if (this.state !== 'HELD') return;
        this.jumpY = this.holdY;
        this.jumpV = 0;
        this.holdY = 0;
        this.struggleAngle = 0;
        this.el.className = 'pokemon-container';
        this.img.style.transformOrigin = ''; // 交還給 CSS 的 center bottom
        if (activeSnatch?.phase === 'DIVE' && berries.includes(activeSnatch.berry)
            && (activeSnatch.victim === this
                || (this.targetBerry && activeSnatch.berry === this.targetBerry))) {
            // 目擊戲補開演：victim === this 是「看戲看到一半被抓又放開」，
            // berry 相符是「被抓期間賊鳥才出手」——兩種都算撞見。
            // 保險絲同樣依剩餘航程重算，演得再慢也不會提前走人
            const berry = activeSnatch.berry;
            this.targetBerry = null;
            activeSnatch.victim = this;
            this.startSnatchWatch();
            const remain = Math.hypot(
                activeSnatch.x - berry.x, activeSnatch.bottom - berry.bottom);
            this.watchTimer = (remain / activeSnatch.speed) * (1000 / 60) + 8000;
        } else if (this.targetBerry && berries.includes(this.targetBerry)) {
            this.state = 'SEEK_BERRY';
            if (this.jumpY > 0) this.resnatchOnLand = true;
            else maybeMarkSnatch(this.targetBerry); // 貼地放開 = 這裡就是落點
        } else {
            this.targetBerry = null;
            this.state = 'WALKING';
        }
    }

    // 本體中心的 X 座標（this.x 是左緣）：算「誰離果實最近」用
    centerX() {
        return this.x + (this.img.offsetWidth || CONFIG.baseSize * this.sizeScale) / 2;
    }

    // 餵食流程中（發現 → 跑去 → 吃 → 愛心）：一隻只追一顆，
    // 期間不會發現其他果實，也不能被指派新的
    isFeeding() {
        return this.state === 'SEEK_BERRY'
            || this.state === 'EATING'
            || this.state === 'FEED_HEART';
    }

    // 有沒有空接一顆果實：看得見（sprite 兩段備援都失敗的不算，
    // 果實被看不見的東西吃掉太獵奇）、不在餵食流程中、也不在誰的手上、
    // 也沒在目擊搶食（正忙著沮喪，沒心情吃）。
    // 被抓著的那隻等於暫時離場：果實丟給牠會沒人去吃，還占著上限，
    // 所以點空白處、遙控 feed、信使鳥空投三個入口都問這一句
    canTakeBerry() {
        return this.el.style.display !== 'none'
            && !this.isFeeding()
            && this.state !== 'HELD'
            && this.state !== 'SNATCH_WATCH';
    }

    // 追果實追到一半被賊鳥嚇停：嚇得原地跳一下、再冒一次驚嘆號，
    // 站定看戲。之後的劇本由 Snatcher 推進——叼走那一刻把驚嘆號換成一團黑線
    startSnatchWatch() {
        this.breakGreet();
        this.state = 'SNATCH_WATCH';
        this.idleTimer = 0;
        this.watchTimer = 12000; // 保底值；beginSnatch 隨即依實際航程重算，叼走那一刻改設為沮喪時長
        this.startleJump();
        if (!this.showEmote('exclaim', EXCLAIM_MS)) this.hideEmote();
    }

    // 發現果實：不論正在走路還是發呆都放下手邊的事——
    // 原地跳一下 + 冒出驚嘆號，驚訝定格（STARTLE_MS）走完才起跑（見 seekBerry）。
    // 驚嘆號被婉拒時（bubblePosition=none 或色違閃光保護期），
    // 至少把進行中的心情收起（hideEmote 會給保護期讓路）
    startSeekBerry(target) {
        this.breakGreet(); // 寒暄中被果實叫走：自己收場、放對方自由
        this.targetBerry = target;
        this.state = 'SEEK_BERRY';
        this.idleTimer = 0;
        this.seekStartle = STARTLE_MS;
        this.startleJump();
        if (!this.showEmote('exclaim', EXCLAIM_MS)) this.hideEmote();
    }

    // 驚訝的那一跳：腳踏實地才跳（半空中被指派——剛被戳起跳之類——
    // 就不做二段跳，只定格），與發呆亂跳同一組防護
    startleJump() {
        if (this.jumpY === 0 && this.jumpV === 0) this.jump();
    }

    // 小跑步奔向自己的那顆果實：比散步快一截、跳步節奏也跟著加快。
    // 到口邊若果實還在半空，就站在底下等它落地（半空中接不到）
    seekBerry(deltaTime) {
        const berry = this.targetBerry;
        if (!berry) { this.state = 'WALKING'; return; } // 果實意外沒了就回去散步
        // 驚訝定格：發現的當下先停步、原地跳一下（startSeekBerry），
        // 這段時間站在原地不追也不吃，定格走完才起跑
        if (this.seekStartle > 0) {
            this.seekStartle -= deltaTime;
            this.bobY *= 0.8;
            return;
        }
        const dt = deltaTime / (1000 / 60);
        const dx = berry.x - this.centerX();
        if (Math.abs(dx) > 6) {
            this.direction = dx > 0 ? 1 : -1;
            const step = Math.max(this.speed * 2.5, 1) * dt;
            this.x += Math.sign(dx) * Math.min(Math.abs(dx), step);
            this.walkPhase += deltaTime * CONFIG.hopFrequency * 2.5 * (this.speed / CONFIG.baseSpeed);
            this.bobY = Math.abs(Math.sin(this.walkPhase)) * this.hopHeight;
        } else {
            this.bobY *= 0.8; // 站定等吃
            // 果實落了地、自己也得腳踏實地才開動：被放開後的自由落體
            // 若正好飄過果實上空，懸在半空啃果實太獵奇
            if (berry.state === 'LANDED' && this.jumpY <= 0) {
                this.direction = dx >= 0 ? 1 : -1; // 面向果實開動
                this.state = 'EATING';
                this.eatTimer = 900;
            }
        }
    }

    // 三口吃掉：果實隨剩餘時間分段縮小（縮放錨在底邊，往地面收），
    // 最後一口消失 → 開心跳 + 冒愛心，進入 FEED_HEART 收尾
    eatBerry(deltaTime) {
        this.bobY *= 0.8;
        this.eatTimer -= deltaTime;
        if (this.targetBerry) {
            const bite = this.eatTimer > 600 ? 1 : this.eatTimer > 300 ? 0.72 : 0.45;
            this.targetBerry.el.style.transform = `scale(${bite})`;
            // 影子跟著咬痕一口一口縮小，別留一圈跟果實不合身的影子。
            // 咬痕記在果實身上、由 updateBerryShadow 統一畫：影子每一幀都在
            // 重算（太陽在動），直接寫 transform 會被下一幀蓋掉
            this.targetBerry.bite = bite;
            updateBerryShadow(this.targetBerry);
        }
        if (this.eatTimer <= 0) {
            if (this.targetBerry) {
                removeBerry(this.targetBerry);
                this.targetBerry = null;
            }
            this.jump();
            this.showEmote('heart', 1600); // 色違保護期中會被婉拒，收尾計時照走
            this.state = 'FEED_HEART';
            this.heartTimer = 1600;
        }
    }

    // 色違登場的慶祝特效：一圈像素星星從本體中心向外炸開、漸淡。
    // 圖片載入後才觸發（本體現身的那一刻），星星本身用完即丟
    celebrateShiny() {
        // 背景分頁沒人在看，星星白放（清理還得靠 animationend，
        // 背景的動畫時鐘不可靠）——跳過這輪，重播排程照常鏈下去，
        // 切回分頁後的下一輪就看得到
        if (!document.hidden) {
            const height = this.img.offsetHeight || CONFIG.baseSize * this.sizeScale;
            const colors = ['#ecb200', '#ffd84d']; // 星光金 × 亮金，同色系兩層次
            const count = 10;
            for (let i = 0; i < count; i++) {
                const shape = i % 2 === 0 ? 'big' : 'small';
                const star = document.createElement('img');
                star.className = 'burst-star';
                star.src = getStarURI(shape, colors[Math.floor(Math.random() * colors.length)]);
                star.style.animationDuration = `${CONFIG.shinyBurstDuration ?? 1500}ms`;
                const w = STAR_ARTS[shape][0].length * this.bubbleScale;
                star.style.width = `${w}px`;
                // 從本體中央出發：角度沿「上半弧」平均分佈再加小亂數
                // （不取整圈：往正下方飛會立刻被頁面底邊裁掉），距離依體型放大
                const angle = Math.PI * (-0.15 + 1.3 * (i / (count - 1))) + (Math.random() - 0.5) * 0.3;
                // 飛散半徑 = 基礎距離 × 體型 × 全頁倍率（shinyBurstScale 只放大範圍，星星本身大小不變）
                const dist = (26 + Math.random() * 16) * (0.7 + this.sizeScale * 0.5)
                             * (CONFIG.shinyBurstScale ?? 1.5);
                star.style.left = `calc(50% - ${Math.round(w / 2)}px)`;
                star.style.bottom = `${Math.round(height * 0.5)}px`;
                star.style.setProperty('--dx', `${Math.round(Math.cos(angle) * dist)}px`);
                star.style.setProperty('--dy', `${Math.round(-Math.sin(angle) * dist)}px`);
                star.addEventListener('animationend', () => star.remove());
                this.el.appendChild(star);
            }
        }

        // 每隔一段隨機秒數重播一輪：色違常駐在頁面上，
        // 開頁那一下沒看到（或中途才進來）的人也不會錯過
        this.burstTimer = setTimeout(() => this.celebrateShiny(),
            randomInt(CONFIG.shinyBurstDelay?.min ?? 15000, CONFIG.shinyBurstDelay?.max ?? 20000));
    }

    // 只有站定發呆時才有機會冒心情對話框；走路中不觸發
    maybeShowEmote() {
        // 夜裡先擲一次「就這樣睡著了」：中了直接掛 Zzz 到發呆結束。
        // 先擲是關鍵——不然 Zzz 只是八種心情裡的八分之一，
        // 睡意再濃也只是偶爾冒一次（見 js/circadian.js）
        if (Math.random() < sleepEmoteChance()) {
            this.showEmote('zzz');
            return;
        }
        // 其他心情：夜裡整體壓低，白天照 config.js 的 bubbleChance
        if (Math.random() >= moodChanceNow()) return;
        const names = Object.keys(EMOTE_ICONS);
        this.showEmote(names[randomInt(0, names.length - 1)]);
    }

    // ---- 偶遇打招呼 (Greeting) ----
    // 有沒有空停下來寒暄：走路或發呆中、看得見、也不在寒暄冷卻期。
    // 餵食流程中（isFeeding）與寒暄中的都算沒空
    canGreet() {
        return (this.state === 'WALKING' || this.state === 'IDLE')
            && this.el.style.display !== 'none'
            && this.greetCooldown <= 0;
    }

    // 進入寒暄。不是原地開聊：擦肩相遇時兩隻多半疊在一起，
    // 先各退到「彼此身寬 + 一點空隙」的站位（SPACING），
    // 雙方都就位、面對面之後才冒對話框開聊（CHAT）
    startGreet(partner, faceDir, duration, targetX) {
        this.greetPartner = partner;
        this.state = 'GREETING';
        this.greetPhase = 'SPACING';
        this.greetTargetX = targetX;
        this.greetFace = faceDir;      // 就位後要面向對方的方向
        this.greetDuration = duration; // 聊多久（開聊那一刻才起跳）
        this.greetTimer = 4000;        // 讓位的保險絲：站位走不到就整組放棄
        this.idleTimer = 0;
        this.hideEmote(); // 對話框等面對面後才出現，先收掉進行中的心情
    }

    // 寒暄的每一幀（GREETING 狀態）
    greet(deltaTime) {
        if (this.greetPhase === 'CHAT') {
            // 聊天中：站定緩緩落地，聊完各自轉身走開
            this.bobY *= 0.8;
            this.greetTimer -= deltaTime;
            if (this.greetTimer <= 0) this.endGreet(true);
            return;
        }
        // 讓位卡住（視窗中途縮放把站位擠到界外之類）就整組放棄，
        // 別讓兩隻站成雕像
        this.greetTimer -= deltaTime;
        if (this.greetTimer <= 0) { this.breakGreet(); return; }
        const dx = this.greetTargetX - this.x;
        if (this.greetPhase === 'SPACING' && Math.abs(dx) > 1) {
            // 面向移動方向、用小跑步的節奏讓開
            const dt = deltaTime / (1000 / 60);
            this.direction = dx > 0 ? 1 : -1;
            const step = Math.max(this.speed * 2.5, 1) * dt;
            this.x += Math.sign(dx) * Math.min(Math.abs(dx), step);
            this.walkPhase += deltaTime * CONFIG.hopFrequency * 2.5 * (this.speed / CONFIG.baseSpeed);
            this.bobY = Math.abs(Math.sin(this.walkPhase)) * this.hopHeight;
            return;
        }
        // 就位：站上目標點、轉頭面向對方，等對方也站好
        this.x = this.greetTargetX;
        this.greetPhase = 'READY';
        this.direction = this.greetFace;
        this.bobY *= 0.8;
        // 兩隻都就位 → 同一刻開聊（對話框此刻才出現）
        if (this.greetPartner?.greetPhase === 'READY') {
            this.beginChat();
            this.greetPartner.beginChat();
        }
    }

    // 就位面對面後開聊：冒音符或愛心（兩隻各自擲骰，不一定同款）。
    // 對話框被婉拒時（bubblePosition=none 或色違閃光保護期）就靜靜相望
    beginChat() {
        this.greetPhase = 'CHAT';
        this.greetTimer = this.greetDuration;
        this.direction = this.greetFace;
        if (!this.showEmote(Math.random() < 0.5 ? 'note' : 'heart', this.greetDuration)) {
            this.hideEmote();
        }
    }

    // 結束寒暄回去散步。turnAway = 聊完轉身走開（被打斷時不轉，直接辦正事）；
    // 掉頭與寒暄都進冷卻——結束時兩隻還在彼此的 personalSpace 裡，
    // 沒有冷卻的話下一幀就會再互相觸發
    endGreet(turnAway = false) {
        if (this.state !== 'GREETING') return;
        this.state = 'WALKING';
        this.greetPhase = null;
        this.greetPartner = null;
        this.hideEmote();
        if (turnAway) this.direction *= -1;
        this.avoidCooldown = randomInt(1500, 3000);
        this.greetCooldown = randomInt(8000, 15000);
    }

    // 寒暄被打斷（被果實叫走、被遙控送走）：自己收場、也放對方自由，
    // 別讓對方對著空氣講完整段話
    breakGreet() {
        this.greetPartner?.endGreet();
        this.endGreet();
    }

    // 行進方向的前方太近有同伴就掉頭；掉頭後進入冷卻，
    // 避免在牆角或人群中來回抖動
    avoidCrowding(others) {
        if (this.avoidCooldown > 0) return;
        for (const other of others) {
            if (other === this) continue;
            if (other.state === 'HELD') continue; // 被抓在半空的不算路障
            const dx = other.x - this.x;
            if (Math.abs(dx) < CONFIG.personalSpace && Math.sign(dx) === this.direction) {
                // 偶遇打招呼：雙方都有空的話，小機率不掉頭，
                // 改停下來面對面寒暄一下再各走各的。
                // 站位以兩隻中心的中點為基準往外讓開：
                // 中心距 = 半身寬相加 + 空隙，身體才不會疊在一起；
                // 目標都夾回活動範圍，貼著邊界相遇也讓得開
                // 夜裡不太有心情社交（除 Zzz 以外的對話框都跟著壓低）
                if (this.canGreet() && other.canGreet()
                    && Math.random() < greetChanceNow()) {
                    const duration = randomInt(1600, 2600);
                    const wa = this.img.offsetWidth || CONFIG.baseSize * this.sizeScale;
                    const wb = other.img.offsetWidth || CONFIG.baseSize * other.sizeScale;
                    const mid = (this.centerX() + other.centerX()) / 2;
                    const sep = (wa + wb) / 2 + GREET_GAP; // 站定後的中心距
                    const side = Math.sign(dx); // 對方在我的哪一側
                    const clampX = (tx, w) => {
                        const minX = window.innerWidth * CONFIG.bounds.min;
                        const maxX = Math.max(minX, window.innerWidth * CONFIG.bounds.max - w);
                        return Math.min(Math.max(tx, minX), maxX);
                    };
                    this.startGreet(other, side, duration,
                        clampX(mid - side * sep / 2 - wa / 2, wa));
                    other.startGreet(this, -side, duration,
                        clampX(mid + side * sep / 2 - wb / 2, wb));
                    break;
                }
                this.direction *= -1;
                this.avoidCooldown = randomInt(1500, 3000);
                break;
            }
        }
    }

    idle(deltaTime) {
        // 發呆時緩緩落回地面，不要硬生生定格在半空中
        this.bobY *= 0.8;
        if (this.bobY < 0.1) this.bobY = 0;

        // 發呆亂跳：站穩在地上時，機率性原地開心跳一下
        // （落地才擲骰，不會在半空中連鎖二段跳；夜裡幾乎不跳了）
        if (this.jumpY === 0 && this.jumpV === 0
            && Math.random() < idleJumpChanceNow()) {
            this.jump();
        }

        this.idleTimer -= deltaTime;
        if (this.idleTimer <= 0) {
            this.state = 'WALKING';
            this.hideEmote(); // 開始走路就收起對話框（保護期中的閃光除外）
            // 隨機決定是否轉向
            if (Math.random() > 0.5) {
                this.direction *= -1;
            }
        }
    }

    updateDOM() {
        // 位置（container）與翻面（sprite 圖片）分開處理：
        // - 位置每一幀都在變，直接設定、不套緩動，才不會有飄移感
        // - 翻面用「瞬間鏡像」，補間 scaleX 會經過 0 導致被壓扁成一條線
        //   （2D 像素遊戲的角色轉向本來就是瞬間翻面，這樣反而最自然）
        this.el.style.transform = `translate3d(${this.x}px, 0, 0)`;

        // 對話框顯示中要換邊時（轉向、或走到畫面邊緣得翻到內側），
        // 跟著換邊並鏡像尾巴。判斷純算術，同一側就不動 DOM
        if (this.bubbleName && this.bubble.style.display !== 'none') {
            const bubbleSide = this.desiredBubbleSide();
            if (bubbleSide !== this.bubbleSide) this.placeBubble(bubbleSide);
        }

        // 原圖面向左邊：direction 1 (向右) -> scaleX(-1) 鏡像
        const scale = this.direction === 1 ? -1 : 1;
        // 走路跳步 + 點擊跳躍 + 被抓在手上的高度，三者疊加後的離地高度
        const lift = this.bobY + this.jumpY + this.holdY;
        // 掙扎的傾角接在最後（沒在掙扎時不寫，字串維持原樣）
        const tilt = this.struggleAngle ? ` rotate(${this.struggleAngle.toFixed(1)}deg)` : '';
        this.img.style.transform = `scaleX(${scale}) translateY(${-lift}px)${tilt}`;

        // 名牌與對話框都掛在 container 上，而 container 只吃水平位移——
        // 離地高度寫在 sprite 自己的 transform 裡，所以這兩塊浮層得自己補上，
        // 不然抓起來拖到半空時字會留在原地（實測差 100px，身體直接穿過自己的名字）。
        // 只吃「刻意的離地」（被抓、跳躍），不吃走路跳步：3px 的彈跳讓整條字
        // 跟著抖是雜訊不是活潑——這條線跟影子的 airRatio 是同一條。
        // 歸零時把 inline 值清掉（名牌）或寫回底稿（對話框），
        // 讓 CSS 的原始擺位接手，字串也就跟沒有這段時完全一樣
        const overlayLift = this.jumpY + this.holdY;
        if (this.nametag) {
            this.nametag.style.transform = overlayLift
                ? `translateX(-50%) translateY(${-overlayLift}px)`
                : '';
        }
        if (this.bubbleBase !== null && this.bubble.style.display !== 'none') {
            this.bubble.style.transform = overlayLift
                ? `${this.bubbleBase} translateY(${-overlayLift}px)`
                : this.bubbleBase;
        }

        // 水裡的那個照抄面向與高度，Y 軸翻過來（掙扎的傾角不抄：
        // 被抓在手上時 lift 早就把倒影沉到水面以下、裁光了）
        if (this.reflection) {
            this.reflection.style.transform = reflectTransform(scale, lift);
        }

        // 跳起來時影子縮小、變淡，強化離地的感覺
        // （走路跳步以自身跳高為滿格；離地高度以 20px 為滿格，取較高者）。
        // 太陽再把它拉長、推向反側、調濃淡（正午與夜晚就是原本那圈腳下影子）
        const airRatio = Math.min(
            Math.max(this.bobY / this.hopHeight, (this.jumpY + this.holdY) / 20), 1);
        this.shadow.style.transform = sunShadowTransform(this.shadowW, 1 - airRatio * 0.3);
        this.shadow.style.opacity = (1 - airRatio * 0.4) * sun.alpha;

        // 調整 Z-index 根據 X 軸位置（避免負值造成排序問題）。
        // 被抓在手上的那隻疊到最前面（客串 10000 之上、果實 20000 之下）——
        // 手上的東西被別人擋住很出戲
        this.el.style.zIndex = this.state === 'HELD'
            ? 15000
            : Math.max(0, Math.floor(this.x));
    }
}
