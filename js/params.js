// ---------------------------------------------------------
// 配置區
// 所有可調參數都在 config.js，身高對照表在 pokemon_heights.js
// ---------------------------------------------------------
const CONFIG = window.POKE_CONFIG;

// ---------------------------------------------------------
// URL 參數覆寫 (Query String Overrides)
// iframe 嵌入或直接開啟時可用 ?count=5&baseSize=120 客製，
// 不帶參數就吃 config.js 的預設值。完整參數文件見 PARAMS.md
// ---------------------------------------------------------
// 白名單 + 型別 + 範圍：不在表上的參數一律無視，
// 超出範圍或非數字的值忽略並在 console 提示，確保亂帶參數也弄不壞頁面
const QUERY_PARAMS = {
    count:            { path: ['count'],            type: 'int',   min: 1,  max: 50 },
    minId:            { path: ['minId'],            type: 'int',   min: 1,  max: 1025 },
    maxId:            { path: ['maxId'],            type: 'int',   min: 1,  max: 1025 },
    baseSpeed:        { path: ['baseSpeed'],        type: 'float', min: 0,  max: 10 },
    speedVariance:    { path: ['speedVariance'],    type: 'float', min: 0,  max: 10 },
    boundsMin:        { path: ['bounds', 'min'],    type: 'float', min: 0,  max: 1 },
    boundsMax:        { path: ['bounds', 'max'],    type: 'float', min: 0,  max: 1 },
    idleChance:       { path: ['idleChance'],       type: 'float', min: 0,  max: 1 },
    lookTimeMin:      { path: ['lookTime', 'min'],  type: 'int',   min: 0,  max: 60000 },
    lookTimeMax:      { path: ['lookTime', 'max'],  type: 'int',   min: 0,  max: 60000 },
    bubbleChance:     { path: ['bubbleChance'],     type: 'float', min: 0,  max: 1 },
    bubblePosition:   { path: ['bubblePosition'],   type: 'enum',  values: ['top', 'side', 'none'] },
    bubbleSideGap:    { path: ['bubbleSideGap'],    type: 'int',   min: -20, max: 50 },
    bubbleSideLift:   { path: ['bubbleSideLift'],   type: 'int',   min: -50, max: 100 },
    bubbleLayer:      { path: ['bubbleLayer'],      type: 'enum',  values: ['front', 'behind'] },
    idleJumpChance:   { path: ['idleJumpChance'],   type: 'float', min: 0,  max: 1 },
    shinyChance:      { path: ['shinyChance'],      type: 'float', min: 0,  max: 1 },
    shinyBurstDuration: { path: ['shinyBurstDuration'], type: 'int', min: 100, max: 10000 },
    shinyBurstScale:  { path: ['shinyBurstScale'],  type: 'float', min: 0.1, max: 5 },
    shinyBurstDelayMin: { path: ['shinyBurstDelay', 'min'], type: 'int', min: 1000, max: 600000 },
    shinyBurstDelayMax: { path: ['shinyBurstDelay', 'max'], type: 'int', min: 1000, max: 600000 },
    hopHeight:        { path: ['hopHeight'],        type: 'float', min: 0,  max: 50 },
    hopVariance:      { path: ['hopVariance'],      type: 'float', min: 0,  max: 50 },
    hopFrequency:     { path: ['hopFrequency'],     type: 'float', min: 0,  max: 1 },
    personalSpace:    { path: ['personalSpace'],    type: 'int',   min: 0,  max: 1000 },
    greetChance:      { path: ['greetChance'],      type: 'float', min: 0,  max: 1 },
    baseSize:         { path: ['baseSize'],         type: 'int',   min: 16, max: 512 },
    shadowWidthRatio: { path: ['shadowWidthRatio'], type: 'float', min: 0,  max: 2 },
    sunShadow:        { path: ['sunShadow'],        type: 'enum',  values: ['on', 'off'] },
    sunrise:          { path: ['sunrise'],          type: 'time',  min: 0,  max: 24 },
    sunset:           { path: ['sunset'],           type: 'time',  min: 0,  max: 24 },
    sunTime:          { path: ['sunTime'],          type: 'time',  min: 0,  max: 24, auto: true },
    shadowStretch:    { path: ['shadowStretch'],    type: 'float', min: 1,  max: 10 },
    ambientShadow:    { path: ['ambientShadow'],    type: 'float', min: 0,  max: 1 },
    overcastShadow:   { path: ['overcastShadow'],   type: 'float', min: 0,  max: 1 },
    theme:            { path: ['theme'],            type: 'enum',  values: ['none', 'random', 'grass', 'water', 'snow', 'sand', 'rock', 'dirt', 'lava'] },
    themeHeight:      { path: ['themeHeight'],      type: 'int',   min: 4,  max: 200 },
    weatherChance:    { path: ['weatherChance'],    type: 'float', min: 0,  max: 1 },
    weatherDensity:   { path: ['weatherDensity'],   type: 'float', min: 0.2, max: 5 },
    flybyDelayMin:    { path: ['flybyDelay', 'min'], type: 'int',  min: 1000, max: 600000 },
    flybyDelayMax:    { path: ['flybyDelay', 'max'], type: 'int',  min: 1000, max: 600000 },
    flybyChance:      { path: ['flybyChance'],      type: 'float', min: 0,  max: 1 },
    flybyLegendaryChance: { path: ['flybyLegendaryChance'], type: 'float', min: 0, max: 1 },
    flybyDeliveryChance:  { path: ['flybyDeliveryChance'],  type: 'float', min: 0, max: 1 },
    flybySpeed:       { path: ['flybySpeed'],       type: 'float', min: 1,  max: 100 },
    remote:           { path: ['remote'],           type: 'enum',  values: ['on', 'off'] },
    remoteRateLimit:  { path: ['remoteRateLimit'],  type: 'int',   min: 1,  max: 100 },
    berry:            { path: ['berry'],            type: 'enum',  values: ['on', 'off'] },
    snatchChance:     { path: ['snatchChance'],     type: 'float', min: 0,  max: 1 },
    snatchDistance:   { path: ['snatchDistance'],   type: 'int',   min: 0,  max: 2000 },
    snatchDiveRate:   { path: ['snatchDiveRate'],   type: 'float', min: 0.2, max: 10 },
    snatchFleeRate:   { path: ['snatchFleeRate'],   type: 'float', min: 0.2, max: 10 },
    snatchShrinkRate: { path: ['snatchShrinkRate'], type: 'float', min: 0,  max: 10 },
    snatchFadeRate:   { path: ['snatchFadeRate'],   type: 'float', min: 0,  max: 10 },
    drag:             { path: ['drag'],             type: 'enum',  values: ['on', 'off'] },
    dragStruggleRate: { path: ['dragStruggleRate'], type: 'float', min: 0,  max: 10 },
};

// 'HH:MM'（17:30）或小數時數（17.5）→ 小數時數。看不懂就回 NaN，
// 由呼叫端警告並忽略。給日出/日落/釘死時刻這類「時間」參數用
function parseTimeParam(raw) {
    const hhmm = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
        const m = Number(hhmm[2]);
        return m < 60 ? Number(hhmm[1]) + m / 60 : NaN;
    }
    return parseFloat(raw);
}

function applyQueryOverrides(config) {
    const qs = new URLSearchParams(location.search);

    for (const [name, spec] of Object.entries(QUERY_PARAMS)) {
        const raw = qs.get(name);
        if (raw === null) continue;
        let value;
        if (spec.type === 'enum') {
            value = raw.toLowerCase();
            if (!spec.values.includes(value)) {
                console.warn(`[PokéFooter] 忽略不合法的參數 ${name}=${raw}（允許值：${spec.values.join(' / ')}）`);
                continue;
            }
        } else if (spec.type === 'time') {
            // sunTime 額外收 auto = 跟著觀看端的本機時鐘（等同不帶這個參數）
            if (spec.auto && raw.trim().toLowerCase() === 'auto') {
                value = null;
            } else {
                value = parseTimeParam(raw);
                if (Number.isNaN(value) || value < spec.min || value > spec.max) {
                    console.warn(`[PokéFooter] 忽略不合法的參數 ${name}=${raw}（HH:MM 或小數時數，允許 ${spec.min} ~ ${spec.max}）`);
                    continue;
                }
            }
        } else {
            value = spec.type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
            if (Number.isNaN(value) || value < spec.min || value > spec.max) {
                console.warn(`[PokéFooter] 忽略不合法的參數 ${name}=${raw}（允許範圍 ${spec.min} ~ ${spec.max}）`);
                continue;
            }
        }
        let target = config;
        for (const key of spec.path.slice(0, -1)) target = target[key];
        target[spec.path[spec.path.length - 1]] = value;
    }

    // ids=25,133,6：固定生成清單（取代 count/minId/maxId 的隨機抽選）。
    // 允許重複編號（五隻伊布也是一種浪漫），上限 50 隻
    const ids = qs.get('ids');
    if (ids !== null) {
        const list = ids.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isInteger(n) && n >= 1 && n <= 1025)
            .slice(0, 50);
        if (list.length) {
            config.fixedIds = list;
            config.count = list.length; // 跑道數要跟實際隻數一致
        } else {
            console.warn('[PokéFooter] ids 參數沒有任何合法編號（1~1025），已忽略');
        }
    }

    // 參數彼此的合理性修正：
    // 順序顛倒就對調；count 超過可抽的編號數量會讓抽選迴圈卡死，必須夾住
    if (config.minId > config.maxId) [config.minId, config.maxId] = [config.maxId, config.minId];
    if (config.lookTime.min > config.lookTime.max) [config.lookTime.min, config.lookTime.max] = [config.lookTime.max, config.lookTime.min];
    if (config.flybyDelay && config.flybyDelay.min > config.flybyDelay.max) [config.flybyDelay.min, config.flybyDelay.max] = [config.flybyDelay.max, config.flybyDelay.min];
    if (config.shinyBurstDelay && config.shinyBurstDelay.min > config.shinyBurstDelay.max) [config.shinyBurstDelay.min, config.shinyBurstDelay.max] = [config.shinyBurstDelay.max, config.shinyBurstDelay.min];
    // 日出必須早於日落，否則「白天」這段區間不存在，投射影會整天不出現
    if (config.sunrise >= config.sunset) {
        console.warn('[PokéFooter] sunrise 必須早於 sunset，已改回預設 6 ~ 18');
        config.sunrise = 6;
        config.sunset = 18;
    }
    if (config.bounds.min >= config.bounds.max) {
        console.warn('[PokéFooter] boundsMin 必須小於 boundsMax，已改回預設 0.1 ~ 0.9');
        config.bounds = { min: 0.1, max: 0.9 };
    }
    // 活動範圍還得塞得下最大體型：太窄時邊界檢查會出現 maxX < minX 的矛盾。
    // 逐參數看都合法、組合起來卻出事的典型，載入時先擋一次
    // （update() 內另有逐幀保險，處理載入後縮放視窗等剩餘情況）。
    // 1.5 倍是「最寬的橫向系寶可夢」的經驗係數；已是預設範圍就不再動
    if ((config.bounds.max - config.bounds.min) * window.innerWidth < config.baseSize * 1.5
        && !(config.bounds.min === 0.1 && config.bounds.max === 0.9)) {
        console.warn('[PokéFooter] 活動範圍太窄，塞不下最大體型，已改回預設 0.1 ~ 0.9');
        config.bounds = { min: 0.1, max: 0.9 };
    }
    if (!config.fixedIds) {
        config.count = Math.min(config.count, config.maxId - config.minId + 1);
    }
}
