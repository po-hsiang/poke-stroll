// ---------------------------------------------------------
// 陣容 (Roster)
// 「這一批要抽誰」的唯一入口。三層優先序，由高到低：
//   1. ids=25,133   完全指定，連抽都不抽（在 js/params.js 就處理掉了）
//   2. team=fire    只抽這些屬性——明講的意圖，蓋過下面那一層
//   3. nightRoster  深夜偏抽夜行系（機率性，每個名額各擲一次骰）
//
// 這兩層查屬性的方式「刻意不同」，別把它們統一掉：
//   team        主副屬性都算（POKE_TYPES + POKE_SUBTYPES）。「你算不算火系」
//               是成員資格題，噴火龍是火/飛行，兩邊都該算牠。飛行系尤其明顯：
//               主屬性是飛行的只有 9 隻，把副屬性算進來是 109 隻——不算副屬性
//               的 team=flying 根本湊不出一支隊伍。
//   nightRoster 只算主屬性。幽靈與惡多半本來就掛在主屬性槽（耿鬼、月精靈、
//               勾魂眼、瑪狃拉都是），漏掉的是班基拉斯（岩/惡）、洛托姆
//               （電/幽靈）這種「氣質上不算夜行」的；而且「夜行」是氣質不是
//               能力，主屬性才是那隻的主體。把副屬性也算進來只會讓夜晚變雜。
// ---------------------------------------------------------

// 十八種屬性的英文名 = pokemon_types.js 的值域，也就是 team 參數的允許值
const POKE_TYPE_NAMES = [
    'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
    'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
];

// 「夜行系」在原作裡沒有這個屬性，最接近的是幽靈與惡這兩種：
// 惡屬性（悪タイプ）和晝夜循環同在第二世代登場，牠們在原作的出沒時段也幾乎
// 都壓在天黑之後（黑暗鴉、月精靈、狃拉都得等晚上）。幽靈只有四十幾隻，
// 單獨用名單太薄——加上惡才撐得起「整晚都是這一味」的體感。
const NOCTURNAL_TYPES = ['ghost', 'dark'];

// 指定屬性在 [min, max] 之間的所有編號。
// slots = 'both'（預設，主副屬性任一命中就算）或 'primary'（只看主屬性）。
// 副屬性表是稀疏的——單屬性的查不到，undefined 不會等於任何屬性名，所以
// 不必特別擋。表沒載到（獨立檔案，可能被拿掉）就當作那一半不存在
function typePool(types, min, max, slots = 'both') {
    const primary = window.POKE_TYPES;
    if (!primary) return []; // 連主屬性都沒有就沒得挑了
    const sub = slots === 'both' ? window.POKE_SUBTYPES : null;
    const want = new Set(types);
    const pool = [];
    for (let id = min; id <= max; id++) {
        if (want.has(primary[id]) || (sub && want.has(sub[id]))) pool.push(id);
    }
    return pool;
}

// 整段編號範圍，一個都不挑
function rangePool(min, max) {
    const pool = [];
    for (let id = min; id <= max; id++) pool.push(id);
    return pool;
}

// 從候選名單抽 want 個不重複的編號，taken 裡的先排除。
// 洗牌取前面幾個（不是「抽到重複就重抽」）：名單比要的數量還少時
// 就只給得出那麼多，永遠不會卡在湊不滿的迴圈裡
function sampleUnique(pool, want, taken) {
    const avail = taken ? pool.filter(id => !taken.has(id)) : [...pool];
    const take = Math.min(Math.max(want, 0), avail.length);
    for (let i = 0; i < take; i++) {
        const j = randomInt(i, avail.length - 1);
        [avail[i], avail[j]] = [avail[j], avail[i]];
    }
    return avail.slice(0, take);
}

// 目前的主題隊伍（屬性名陣列，沒指定就是 null）。
// URL 帶進來的一定是陣列，但 config.js 是手改的檔案，寫成 team: 'fire'
// 也很自然——單一個字串就當成一種屬性，別讓它被拆成四個字母
function teamTypes() {
    const team = CONFIG.team;
    if (typeof team === 'string') return team ? [team] : null;
    return team?.length ? team : null;
}

// 深夜偏抽夜行系的機率。白天與睡前那幾個小時都是 0。
// 讀的是 deepNightLevel()（深夜窗口，預設 00:00 ~ 06:00）而不是天色那一條：
// 幽靈與惡是「夜深了才出來」的味道，傍晚天剛黑就整批換人太急。跟作息
// （js/circadian.js）同一個窗口，畫面上才是一件事——夜深了，出來的都是
// 這一味，而且大半站著睡。
// 用「濃度過半」當門檻而不是直接拿濃度當機率：陣容只在生成的那一刻抽一次，
// 而窗口開頭那段濃度還在爬——說「夜深之後就偏抽」比說「偏抽的機率跟著濃度
// 連續變化」好解釋得多，也才對得上 nightFade 調出來的時刻
function nightBias() {
    const chance = Math.min(Math.max(CONFIG.nightRoster ?? 0, 0), 1);
    if (chance <= 0) return 0;
    return deepNightLevel() >= 0.5 ? chance : 0;
}

// 開場陣容（或遙控 join 補人）要抽的編號。回傳的順序是隨機的——
// index 就是出生跑道，照抽選批次排會讓夜行系整排站在畫面同一側
function pickRoster(count, min, max) {
    if (count <= 0) return [];

    // team：只抽這些屬性。名單真的空的（例如 team=dark&maxId=151，
    // 惡屬性要到第二世代才有）就講清楚再退回全範圍，不要靜靜地生不出東西
    const team = teamTypes();
    if (team) {
        const pool = typePool(team, min, max);
        if (pool.length) return sampleUnique(pool, count);
        console.warn(`[PokéFooter] team=${team.join(',')} 在編號 ${min} ~ ${max} 之間沒有任何寶可夢，已改回隨機抽選`);
    }

    const bias = nightBias();
    if (bias > 0) {
        // 'primary'：夜行只認主屬性槽（理由見本檔開頭），跟 team 刻意不同
        const pool = typePool(NOCTURNAL_TYPES, min, max, 'primary');
        if (pool.length) {
            // 逐個名額擲骰，不是「整批換成夜行系」：晚上才會偶爾混進一隻
            // 不是夜行系的，那一隻反而讓整批看起來是抽出來的而不是排好的
            let want = 0;
            for (let i = 0; i < count; i++) if (Math.random() < bias) want++;
            const picked = sampleUnique(pool, want);
            const taken = new Set(picked);
            // 沒中的名額（以及夜行名單不夠的部分）照原本的全範圍補齊
            picked.push(...sampleUnique(rangePool(min, max), count - picked.length, taken));
            return sampleUnique(picked, picked.length); // 再洗一次，別讓夜行系全排在前面
        }
    }

    return sampleUnique(rangePool(min, max), count);
}

// 單抽一隻（遙控 join 沒指定 id 時）。走同一條路，
// 所以 team 與夜間偏好對「後來才入隊的」也一樣生效
function pickOne(min, max) {
    return pickRoster(1, min, max)[0] ?? randomInt(min, max);
}
