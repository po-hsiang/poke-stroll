// ---------------------------------------------------------
// postMessage 遙控 (Remote Control)
// ---------------------------------------------------------
// 父頁面（或 OBS 的 wrapper 頁）隔著 iframe 疆界下指令：
//   frame.contentWindow.postMessage({ ns: 'poke-stroll', cmd: 'poke' }, '*')
// 防線是「指令白名單 + 參數夾範圍 + 節流」而非 origin 驗證：
// 指令全是無害的視覺效果，最壞情況是有人在他自己的頁面上讓皮卡丘跳舞。
// 每道指令都回執（{ ns, re, ok, ... }），串接文件見 PARAMS.md / params.html
const REMOTE_NS = 'poke-stroll';
const remoteStamps = []; // 最近一秒內已處理的指令時戳（節流滑動窗）

const REMOTE_COMMANDS = {
    // 客串一隻：帶 id 指定誰路過（不限飛行系，遙控的卡比獸也能飛），
    // 不帶 id 就照常抽池（含傳說機率那一層）
    spawn(msg) {
        // rAF 停著時生成只會凍在半空，跟排程器同一套背景分頁防護
        if (document.hidden) return { ok: false, reason: 'page hidden' };
        // delivery: true → 這趟改派信使鳥叼果實空投（果實關著就送不成）
        if (msg.delivery) {
            if ((CONFIG.berry ?? 'on') === 'off') return { ok: false, reason: 'berry is off' };
            getSizeScale(DELIVERY_ID).then(scale =>
                cameos.push(new Cameo(DELIVERY_ID, scale, { delivery: true })));
            return { ok: true, id: DELIVERY_ID };
        }
        if (msg.id !== undefined) {
            const id = Math.round(Number(msg.id));
            if (!Number.isFinite(id) || id < 1 || id > 1025) {
                return { ok: false, reason: 'id must be 1~1025' };
            }
            getSizeScale(id).then(scale => cameos.push(new Cameo(id, scale)));
            return { ok: true };
        }
        if (!window.POKE_FLYING?.length && !window.POKE_LEGENDARY?.length) {
            return { ok: false, reason: 'cameo pools not loaded' };
        }
        spawnFlyby();
        return { ok: true };
    },
    // 開心跳一下 + 冒愛心：帶 id 只戳該圖鑑編號的成員，不帶就全員
    poke(msg) {
        const targets = (msg.id !== undefined
            ? pokemons.filter(p => p.id === Math.round(Number(msg.id)))
            : pokemons
        ).filter(p => p.state !== 'HELD'); // 抓在手上的戳不動，回執也不算牠
        targets.forEach(p => p.poke());
        return { ok: true, count: targets.length };
    },
    // 色違星星立刻重播。先清掉原本的重播計時器再放，
    // 排程鏈維持單一條，不會越 burst 越密
    burst() {
        const shinies = pokemons.filter(p => p.isShiny);
        shinies.forEach(p => { clearTimeout(p.burstTimer); p.celebrateShiny(); });
        return { ok: true, count: shinies.length };
    },
    // 加入一隻「常駐」成員（會留下來散步，不是路過的客串）：
    // 帶 id 指定誰入隊，不帶就照 minId/maxId 抽（一樣吃 team 與夜行偏好，
    // 見 js/roster.js——半夜補進來的那一隻也該是夜行系）。
    // 上限跟 count 參數同一個天花板，指令灌不爆隊伍
    join(msg) {
        if (pokemons.length >= (QUERY_PARAMS.count?.max ?? 50)) {
            return { ok: false, reason: 'party is full' };
        }
        let id;
        if (msg.id !== undefined) {
            id = Math.round(Number(msg.id));
            if (!Number.isFinite(id) || id < 1 || id > 1025) {
                return { ok: false, reason: 'id must be 1~1025' };
            }
        } else {
            id = pickOne(CONFIG.minId, CONFIG.maxId);
        }
        // 出生跑道隨機挑一條，跟開頁時的排隊邏輯同一套座標系
        getSizeScale(id).then(scale => pokemons.push(new Pokemon(
            id, app, scale, randomInt(0, Math.max(0, CONFIG.count - 1)), groundLevel)));
        return { ok: true, id };
    },
    // 送走一隻常駐成員：帶 id 指定送誰（同編號多隻就送最晚入隊的），
    // 不帶就隨機挑。最後一隻不送——空蕩蕩的頁尾看起來像壞掉
    leave(msg) {
        if (pokemons.length <= 1) {
            return { ok: false, reason: 'last one standing' };
        }
        let idx;
        if (msg.id !== undefined) {
            idx = pokemons.map(p => p.id).lastIndexOf(Math.round(Number(msg.id)));
            if (idx < 0) return { ok: false, reason: 'id not found' };
        } else {
            idx = randomInt(0, pokemons.length - 1);
        }
        const [victim] = pokemons.splice(idx, 1);
        clearTimeout(victim.burstTimer); // 色違的星星重播鏈一併收掉
        if (victim.targetBerry) removeBerry(victim.targetBerry); // 別留孤兒果實
        victim.breakGreet(); // 寒暄到一半被送走：放對方自由
        releaseDrag(victim);  // 正被抓在手上就先鬆手，游標別拖著除名的元素
        victim.el.remove();
        return { ok: true, id: victim.id };
    },
    // 天降果實：隨機位置掉 count 顆（不帶就隨機顆數）。
    // 「一隻只追一顆」的配對制天然就是上限——最多掉「有空的成員數」顆
    feed(msg) {
        if ((CONFIG.berry ?? 'on') === 'off') return { ok: false, reason: 'berry is off' };
        // 掉落與吃相全靠 rAF 演，背景分頁只會凍在半空，跟 spawn 同一套防護
        if (document.hidden) return { ok: false, reason: 'page hidden' };
        // 參數先驗完再看場面：count 不合法就直說，別報成「在忙」
        let asked = null;
        if (msg.count !== undefined) {
            asked = Math.round(Number(msg.count));
            if (!Number.isFinite(asked) || asked < 1) {
                return { ok: false, reason: 'count must be >= 1' };
            }
        }
        const free = pokemons.filter(p => p.canTakeBerry()).length;
        if (!free) return { ok: false, reason: 'everyone is busy' };
        const want = asked === null ? randomInt(1, free) : Math.min(asked, free);
        let dropped = 0;
        for (let i = 0; i < want; i++) {
            // 高度取畫面上半段，掉落過程才看得見；
            // X 全寬亂撒，搆不到的位置 throwBerry 會自己釘回可達範圍
            const h = window.innerHeight;
            if (throwBerry(randomInt(0, Math.max(0, window.innerWidth - 1)),
                           randomInt(Math.round(h * 0.5), Math.round(h * 0.9)))) dropped++;
        }
        return { ok: true, count: dropped };
    },
    // 盤點常駐陣容（查詢用，不動畫面）：每隻的圖鑑編號、繁中名、是否色違、
    // 體型倍率（0.6 小 / 0.8 中 / 1 大）。外部程式要做陣容面板、
    // 投票名單之類的整合，資料從這裡拿——名字一併給，串接方不必自己再備一張對照表
    // （nametag: 'off' 也照給：關的是畫面上那塊牌子，不是資料）
    roster() {
        return {
            ok: true,
            count: pokemons.length,
            roster: pokemons.map(p => ({
                id: p.id, name: pokeName(p.id), shiny: p.isShiny, size: p.sizeScale,
            })),
        };
    },
};

function handleRemoteMessage(e) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || msg.ns !== REMOTE_NS) return; // 不是寄給我們的信，別拆
    if ((CONFIG.remote ?? 'on') === 'off') return; // 總開關關閉：連回執都不給，像沒這功能
    const reply = payload => {
        // 回執讓串接方能除錯與確認送達；對方視窗可能已經關了，失敗就算了
        try { e.source && e.source.postMessage({ ns: REMOTE_NS, re: msg.cmd ?? null, ...payload }, '*'); }
        catch (err) { /* 靜默 */ }
    };
    const fn = REMOTE_COMMANDS[msg.cmd];
    if (!fn) {
        console.warn(`[PokéFooter] 未知的遙控指令：${msg.cmd}`);
        return reply({ ok: false, reason: 'unknown cmd' });
    }
    // 節流：滑動窗超額就整道丟棄（高頻洗版時保住渲染效能）
    const t = Date.now();
    while (remoteStamps.length && t - remoteStamps[0] >= 1000) remoteStamps.shift();
    if (remoteStamps.length >= (CONFIG.remoteRateLimit ?? 10)) {
        return reply({ ok: false, reason: 'rate limited' });
    }
    remoteStamps.push(t);
    reply(fn(msg));
}
window.addEventListener('message', handleRemoteMessage);
