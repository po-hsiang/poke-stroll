// ---------------------------------------------------------
// 作息 (Circadian)
// ---------------------------------------------------------
// 白天精神好、晚上想睡。天黑之後大家慢下來、站著不動的時間變長、
// 冒出來的多半是 Zzz；天亮之後恢復原本的活潑。
//
// 「幾點算晚上」不自己另定一套，直接讀 js/sun.js 的 nightLevel()——
// 那是全專案唯一的「天多黑了」，夜晚演出（js/night.js）與夜行陣容
// （js/roster.js）用的也是它。所以：
//   * 預設日出 06:00 / 日落 18:00，正好是「夜間 18:00 ~ 06:00」那段
//   * 日落「之後」才慢慢睡（nightFade 分鐘的斜坡），不是 18:00 一到就集體倒下
//   * 釘死時刻（?sunTime=23:00）也照樣生效，方便驗收
//
// 白天 = config.js 寫的那組數字，一個都不動；只有夜裡才乘上下面的倍率。
// 這是刻意的：參數表上的預設值必須就是使用者真正會看到的值，
// 不然「idleChance 我設 0.01」卻永遠不是 0.01，參數就不可信了。
//
// 不受作息影響的動作（睡得再熟也照做）：
//   發現果實 / 追果實 / 吃果實（seekBerry 用的是自己的小跑速度）、
//   被抓起來的掙扎抖動、被戳的開心跳、客串與空中搶食。
//   吃飯與被摸是外界找上牠，不是牠自己想動。

// 深夜（sleepiness = 1）時各項的倍率。> 1 = 變多／變久，< 1 = 變少／變小
const SLEEP_IDLE_BOOST  = 5;    // 進入發呆的機率：站著不動的時間大幅變多
const SLEEP_STILL_BOOST = 2.5;  // 每次發呆的時長：睡一次睡久一點
const SLEEP_ZZZ_CHANCE  = 0.7;  // 發呆時「直接睡著」的機率（不跟其他心情搶）
const SLEEP_MOOD_SCALE  = 0.25; // 其他心情對話框的機率
const SLEEP_MOVE_SCALE  = 0.45; // 散步速度（追果實不算）
const SLEEP_HOP_SCALE   = 0.4;  // 走路跳步的高度
const SLEEP_JUMP_SCALE  = 0.1;  // 發呆時原地開心跳一下的機率
const SLEEP_GREET_SCALE = 0.2;  // 偶遇停下來寒暄的機率

// 現在有多想睡：0 = 白天（完全照 config.js）、1 = 深夜。
// nightSleep 是總強度，0 就整套關閉（晚上跟白天一樣活潑）
function sleepiness() {
    const strength = Math.min(Math.max(CONFIG.nightSleep ?? 1, 0), 1);
    if (strength <= 0) return 0;
    return nightLevel() * strength;
}

// 在 1（白天原值）與 nightValue（深夜）之間依睡意線性內插
function circadianScale(nightValue) {
    return 1 + (nightValue - 1) * sleepiness();
}

// 各處要用的實際值。都寫成函式而不是快取的常數——時間會走，
// 掛著整晚的 OBS 來源要能自己從白天過渡到夜裡，不必重新載入
function idleChanceNow()     { return (CONFIG.idleChance ?? 0) * circadianScale(SLEEP_IDLE_BOOST); }
function idleTimeScale()     { return circadianScale(SLEEP_STILL_BOOST); }
function moveScale()         { return circadianScale(SLEEP_MOVE_SCALE); }
function hopScale()          { return circadianScale(SLEEP_HOP_SCALE); }
function idleJumpChanceNow() { return (CONFIG.idleJumpChance ?? 0) * circadianScale(SLEEP_JUMP_SCALE); }
function greetChanceNow()    { return (CONFIG.greetChance ?? 0) * circadianScale(SLEEP_GREET_SCALE); }
function moodChanceNow()     { return (CONFIG.bubbleChance ?? 0.5) * circadianScale(SLEEP_MOOD_SCALE); }

// 「這次發呆直接睡著」的機率。白天是 0——想睡的話 Zzz 本來就在
// 八種心情的抽選池裡，偶爾打個哈欠不需要特別安排；
// 夜裡才另外先擲這一次骰，讓 Zzz 不必跟其他心情搶那個名額
function sleepEmoteChance() {
    return SLEEP_ZZZ_CHANCE * sleepiness();
}
