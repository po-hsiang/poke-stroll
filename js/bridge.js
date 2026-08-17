// ---------------------------------------------------------
// 指令橋接 (Bridge)
// widget 的遙控介面是 postMessage——那是瀏覽器內的通道，外部程式碰不到
// （不同行程、沒有共同的瀏覽器語境）。bridge.html 就是那道門：
// 對外連一個訊息來源，把收到的文字或 JSON 翻成遙控指令，對內丟進 iframe。
//
// widget 本體完全不用改、也不知道指令從哪來——來源相關的規則全關在這一層，
// 這正是 PARAMS.md 那段 wrapper 範例的成品版：不必自己寫，帶網址參數就能用。
//
//   bridge.html?ws=wss://your-service.example/stream
//   bridge.html?poll=https://your-service.example/latest.json&pollInterval=3000
//
// 來源想送什麼格式都行，三種都收：
//   1. JSON 指令   {"cmd":"feed","count":2}
//   2. JSON 文字   {"sender":"svc-a","text":"...!feed 2..."}
//   3. 純文字一行  「...!feed 2...」
// 文字模式只認「前綴 + 已知指令」這個組合（預設 !feed / !poke / …），
// 所以整行包在別的協定裡（前面有時戳、路由前綴之類）也挑得出來，
// 又不會把隨便一個驚嘆號當成指令。
// ---------------------------------------------------------

// 可橋接的指令。drop 不是 widget 的指令，是「spawn 的空投版」的好記別名
const BRIDGE_CMDS = ['spawn', 'poke', 'burst', 'join', 'leave', 'feed', 'roster', 'drop'];
const BRIDGE_NS = 'poke-stroll';
// 斷線重連的退避：1、2、4… 秒，最多等到 30 秒就不再往上加。
// 來源掛掉一整晚也不會變成每秒重連的攻城槌
const BRIDGE_BACKOFF_MS = 1000;
const BRIDGE_BACKOFF_MAX = 30000;

// 網址參數 → 橋接設定。看不懂的值一律退回預設，開著就是能用
function parseBridgeConfig(search) {
    const qs = new URLSearchParams(search);
    // 沒帶就用預設。注意不能只看 Number()——Number(null) 是 0 而不是 NaN，
    // 少了這一行 raw 檢查，每個沒帶的數字參數都會靜靜地變成 0
    const num = (name, def, min, max) => {
        const raw = qs.get(name);
        if (raw === null || raw.trim() === '') return def;
        const v = Number(raw);
        return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : def;
    };
    const allowRaw = (qs.get('allow') ?? '').split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => BRIDGE_CMDS.includes(s));
    return {
        ws: qs.get('ws') ?? null,
        poll: qs.get('poll') ?? null,
        pollInterval: num('pollInterval', 3000, 500, 600000),
        // 連上之後要先送出的行（| 分隔）：有些文字協定得先報到才會開始送資料
        hello: (qs.get('hello') ?? '').split('|').filter(Boolean),
        prefix: qs.get('prefix') || '!',
        // 沒帶 allow 就是全開；帶了但全部看不懂，也當作沒帶（不要靜靜地全鎖）
        allow: new Set(allowRaw.length ? allowRaw : BRIDGE_CMDS),
        cooldown: num('cooldown', 3000, 0, 600000),
        // 傳給 widget 的參數：bridge.html?q=theme%3Dgrass 就是橋接 + 草地主題
        query: (qs.get('q') ?? '').replace(/^\?/, ''),
        status: (qs.get('status') ?? 'on').toLowerCase() === 'off' ? 'off' : 'on',
    };
}

// 指令名 + 一個參數 → 遙控訊息。不在白名單上的回 null；
// 參數看不懂就當作沒帶（widget 端本來就有「不帶就隨機」的行為）
function bridgeCommand(name, arg, cfg) {
    if (!BRIDGE_CMDS.includes(name) || !cfg.allow.has(name)) return null;
    const n = Number(arg);
    const num = arg !== undefined && arg !== null && arg !== '' && Number.isFinite(n)
        ? Math.round(n) : null;
    if (name === 'drop') return { cmd: 'spawn', delivery: true };
    if (name === 'feed') return num !== null && num >= 1 ? { cmd: 'feed', count: num } : { cmd: 'feed' };
    if (name === 'spawn' || name === 'poke' || name === 'join' || name === 'leave') {
        return num !== null && num >= 1 && num <= 1025 ? { cmd: name, id: num } : { cmd: name };
    }
    return { cmd: name }; // burst / roster 不吃參數
}

// 一行文字 → 遙控訊息。掃出第一個「前綴 + 已知指令」的詞，下一個詞當參數。
// 挑不出來就回 null——大部分的行本來就不是指令，安靜跳過才對
function parseBridgeLine(text, cfg) {
    if (typeof text !== 'string' || !text) return null;
    const words = text.trim().split(/\s+/);
    const at = words.findIndex(w =>
        w.startsWith(cfg.prefix)
        && BRIDGE_CMDS.includes(w.slice(cfg.prefix.length).toLowerCase()));
    if (at < 0) return null;
    return bridgeCommand(words[at].slice(cfg.prefix.length).toLowerCase(), words[at + 1], cfg);
}

// 來源送來的一則訊息 → { sender, msg }。sender 只用來算冷卻，沒有就不算。
// JSON 或純文字都收；解析不出指令時 msg 是 null
function bridgeMessageToCommand(raw, cfg) {
    let data = raw;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        data = null;
        if (trimmed.startsWith('{')) {
            try { data = JSON.parse(trimmed); } catch (e) { data = null; }
        }
        // 不是 JSON（或 JSON 壞掉）就當一行文字處理
        if (!data || typeof data !== 'object') {
            return { sender: null, msg: parseBridgeLine(raw, cfg) };
        }
    }
    if (!data || typeof data !== 'object') return { sender: null, msg: null };
    const sender = typeof data.sender === 'string' ? data.sender
        : typeof data.user === 'string' ? data.user : null;
    if (typeof data.text === 'string') return { sender, msg: parseBridgeLine(data.text, cfg) };
    if (typeof data.cmd === 'string') {
        const name = data.cmd.trim().toLowerCase();
        return { sender, msg: bridgeCommand(name, name === 'feed' ? data.count : data.id, cfg) };
    }
    return { sender, msg: null };
}

// 同一個來源的冷卻。widget 端也有節流，但那是「全場」的額度——
// 這一層讓額度不會被單一個來源一口氣吃光。沒有 sender 就不擋
function makeBridgeGate(cooldownMs) {
    const seen = new Map();
    return {
        allow(sender, at) {
            if (!cooldownMs || !sender) return true;
            const last = seen.get(sender);
            if (last !== undefined && at - last < cooldownMs) return false;
            seen.set(sender, at);
            // 名單不無限長大：滿了就清掉早就過冷卻的
            if (seen.size > 500) {
                for (const [k, v] of seen) if (at - v >= cooldownMs) seen.delete(k);
            }
            return true;
        },
        size: () => seen.size,
    };
}

// ---------------------------------------------------------
// 執行期：連線、轉譯、投遞。由 bridge.html 在 DOM 就緒後呼叫，
// 上面那些純函式不碰 DOM，所以測試可以單獨拿來驗
// ---------------------------------------------------------
function startBridge() {
    const cfg = parseBridgeConfig(location.search);
    const frame = document.getElementById('frame');
    const statusEl = document.getElementById('status');
    const helpEl = document.getElementById('help');
    const gate = makeBridgeGate(cfg.cooldown);
    const modeLabel = cfg.ws ? '已連線' : '輪詢中';
    let sent = 0;

    if (cfg.status === 'off') statusEl.style.display = 'none';
    const setStatus = (state, text) => {
        if (cfg.status === 'off') return;
        statusEl.dataset.state = state;
        statusEl.textContent = text;
    };

    frame.src = './pokemon_footer_widget.html' + (cfg.query ? '?' + cfg.query : '');

    // 沒設定來源：這一頁自己說明用法，不要開著一個什麼都不做的空白頁
    if (!cfg.ws && !cfg.poll) {
        helpEl.hidden = false;
        setStatus('idle', '未設定訊息來源');
        return;
    }

    // 轉譯 + 投遞。回執由 bridge.html 的 message 監聽器接
    const deliver = raw => {
        const { sender, msg } = bridgeMessageToCommand(raw, cfg);
        if (!msg) return;
        if (!gate.allow(sender, Date.now())) return;
        frame.contentWindow.postMessage({ ns: BRIDGE_NS, ...msg }, '*');
        sent++;
        setStatus('live', `${modeLabel} · 送出 ${sent} 道 · 最近：${msg.cmd}${msg.id ? ' ' + msg.id : ''}`);
    };

    if (cfg.ws) {
        let backoff = BRIDGE_BACKOFF_MS;
        const connect = () => {
            setStatus('wait', '連線中…');
            let sock;
            try {
                sock = new WebSocket(cfg.ws);
            } catch (e) {
                // 網址格式就不對（協定寫錯之類）：重連也不會變好，直說
                setStatus('down', `連線位址無效：${cfg.ws}`);
                return;
            }
            sock.onopen = () => {
                backoff = BRIDGE_BACKOFF_MS; // 連上了，退避歸零
                cfg.hello.forEach(line => sock.send(line));
                setStatus('live', '已連線');
            };
            sock.onmessage = ev => {
                for (const line of String(ev.data).split(/\r?\n/)) {
                    if (!line) continue;
                    // 保活：許多文字協定會定期送 PING，沒回就把你踢掉
                    if (line.startsWith('PING')) { sock.send('PONG' + line.slice(4)); continue; }
                    deliver(line);
                }
            };
            sock.onclose = () => {
                setStatus('down', `已斷線，${Math.round(backoff / 1000)} 秒後重連…`);
                setTimeout(connect, backoff);
                backoff = Math.min(backoff * 2, BRIDGE_BACKOFF_MAX);
            };
            // onerror 之後一定會來 onclose，重連的排程交給它一個地方做就好
            sock.onerror = () => sock.close();
        };
        connect();
        return;
    }

    // 輪詢模式：連不上 WebSocket 的環境（或來源本來就只有一個 JSON 檔）用這個。
    // no-store 是必要的——不然瀏覽器會很樂意一直回同一份快取
    const tick = () => {
        fetch(cfg.poll, { cache: 'no-store' })
            .then(r => r.json())
            .then(data => {
                setStatus('live', `${modeLabel} · 送出 ${sent} 道`);
                (Array.isArray(data) ? data : [data]).forEach(deliver);
            })
            .catch(() => setStatus('down', '讀取失敗，下一輪再試'))
            .then(() => setTimeout(tick, cfg.pollInterval));
    };
    tick();
}
