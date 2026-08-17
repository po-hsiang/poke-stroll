// ---------------------------------------------------------
// 陣容 (Roster)
// 「這一批要抽誰」的唯一入口。三層優先序，由高到低：
//   1. ids=25,133   完全指定，連抽都不抽（在 js/params.js 就處理掉了）
//   2. team=fire    只抽這些屬性——明講的意圖，蓋過下面那一層
//   3. nightRoster  夜間偏抽夜行系（機率性，每個名額各擲一次骰）
//
// 屬性查的是 pokemon_types.js 的「主屬性」（slot 1），因為那張表只存主屬性
// （它本來是給影子染色用的）。所以副屬性算不進來：team=flying 抽得到的是
// 主屬性就是飛行的那十來隻（暴風雪鳥、鐵殼昆蟲那類），大比鳥（一般/飛行）
// 不在其中——這是資料的邊界，不是 bug，文件也照這個說法寫。
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

// 指定屬性在 [min, max] 之間的所有編號
function typePool(types, min, max) {
    const table = window.POKE_TYPES;
    if (!table) return []; // 對照表沒載到（獨立檔案，可能被拿掉）就當作沒有名單
    const want = new Set(types);
    const pool = [];
    for (let id = min; id <= max; id++) {
        if (want.has(table[id])) pool.push(id);
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

// 夜間偏抽夜行系的機率。白天是 0。
// 用「夜色濃度過半」當門檻而不是直接拿濃度當機率：陣容只在生成的那一刻抽
// 一次，而黃昏那段濃度還在爬——說「天黑之後就偏抽」比說「偏抽的機率跟著
// 天色連續變化」好解釋得多，也才對得上 nightFade 調出來的入夜時刻
function nightBias() {
    const chance = Math.min(Math.max(CONFIG.nightRoster ?? 0, 0), 1);
    if (chance <= 0) return 0;
    return nightLevel() >= 0.5 ? chance : 0;
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
        const pool = typePool(NOCTURNAL_TYPES, min, max);
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
