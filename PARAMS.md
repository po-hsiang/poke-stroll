# URL 參數 API

嵌入 PokéStroll 時,可以在網址後面用 query string 客製行為,**不用改任何程式或設定檔**:

```html
<iframe src="https://rd7-ai-gw-02.i17game.net/poke-stroll/?count=5&baseSize=120"
        style="position:fixed; bottom:0; left:0; width:100%; height:200px;
               border:none; pointer-events:none; color-scheme:light;"></iframe>
```

> 🌓 `color-scheme:light` 是**透明背景的保險**:iframe 內外的配色方案不一致時,瀏覽器會在
> iframe 後面墊一塊不透明底(白或黑)。你的頁面若宣告過 `color-scheme: dark`,這一句能讓內外對齊。

不帶參數就使用預設值。本機直接開檔案也支援(`file:///...pokemon_footer_widget.html?count=10`)。

> 🕹️ **互動版文件**:部署站同捆一份 [`params.html`](https://rd7-ai-gw-02.i17game.net/poke-stroll/params.html)——
> 夜間模式介面,可搜尋、分類篩選、一鍵複製,頁面底部有**即時預覽軌**,每道食譜按一下就能看效果。
> 給嵌入方同仁直接丟這個網址就好(本 repo 是私人的,他們看不到這份 .md)。
> 本檔、該頁與程式內的參數白名單三方由 CI 自動檢查同步,不會漂移。

文件頁本身也能嵌進團隊 wiki 或開發者後台。跟嵌 widget 相反,文件要互動,**不要**加 `pointer-events:none`,高度給足(建議 80vh 且 ≥ 600px):

```html
<iframe src="https://rd7-ai-gw-02.i17game.net/poke-stroll/params.html"
        title="PokéStroll 參數文件"
        style="width:100%; height:80vh; min-height:600px; border:none;"
        loading="lazy"></iframe>
```

## 參數總表

| 參數 | 型別 | 允許範圍 | 預設 | 說明 |
|------|------|----------|------|------|
| `count` | int | 1 ~ 50 | `4` | 同時生成的寶可夢數量 |
| `minId` | int | 1 ~ 1025 | `1` | 隨機抽選的圖鑑編號下限 |
| `maxId` | int | 1 ~ 1025 | `649` | 隨機抽選的圖鑑編號上限(650 以後沒有動態 GIF,會退回靜態圖) |
| `ids` | int 清單 | 各 1 ~ 1025,最多 50 隻 | — | **固定生成清單**,逗號分隔(如 `ids=25,133,6`)。設了就無視 `count`/`minId`/`maxId` 的隨機抽選;允許重複編號 |
| `baseSpeed` | float | 0 ~ 10 | `0.25` | 基礎移動速度(px/幀,60fps 基準) |
| `speedVariance` | float | 0 ~ 10 | `0.25` | 個體間的速度差異上限 |
| `boundsMin` | float | 0 ~ 1 | `0.1` | 活動範圍左界(占畫面寬度比例) |
| `boundsMax` | float | 0 ~ 1 | `0.9` | 活動範圍右界(必須大於 `boundsMin`) |
| `idleChance` | float | 0 ~ 1 | `0.01` | 每一幀進入發呆狀態的機率 |
| `lookTimeMin` | int | 0 ~ 60000 | `2000` | 發呆時間下限(ms) |
| `lookTimeMax` | int | 0 ~ 60000 | `5000` | 發呆時間上限(ms) |
| `bubbleChance` | float | 0 ~ 1 | `0.33` | 發呆時冒出心情對話框的機率(八種圖案隨機) |
| `idleJumpChance` | float | 0 ~ 1 | `0.003` | 發呆時每一幀「原地開心跳一下」的機率(預設約半數發呆會跳個一兩下,`0` 關閉) |
| `shinyChance` | float | 0 ~ 1 | `1/100` | 每一隻**獨立**擲骰出現色違的機率(預設調得比正作的 1/4096 高很多,直播才熱鬧)。色違登場時必定亮出金色閃光對話框 + 星星四散特效,而且該對話框有 4 秒**保護期**,不會被登場後隨即發呆的心情或被戳的愛心蓋掉 |
| `shinyBurstDuration` | int | 100 ~ 10000 | `1400` | 色違星星特效的飛散+淡出總時長 ms |
| `shinyBurstDelayMin` | int | 1000 ~ 600000 | `15000` | 常駐色違的星星特效**定時重播**間隔下限 ms——登場放一輪後,每隔區間內的隨機秒數再放一輪,開頁沒看到或中途進來的觀眾也不會錯過 |
| `shinyBurstDelayMax` | int | 1000 ~ 600000 | `20000` | 重播間隔上限 ms(min > max 自動對調) |
| `bubblePosition` | enum | `top` / `side` / `none` | `side` | 對話框位置:`top` 頭頂正上方、`side` 面向方向的側邊(整框推到身體外側,尾巴移到靠本體那個下角、鏡像成朝內指回本體;轉向時自動換邊,走到畫面邊緣快被裁掉時也會自動翻到內側)、`none` 完全不顯示(空間有限的頁面適用) |
| `bubbleLayer` | enum | `front` / `behind` | `front` | 對話框在本體的上層(`front`,像遊戲裡角色講話的對話框,會遮到一點身體)還是下層(`behind`,完全不遮本體)。**注意**:只在同一隻的本體之間分層,右邊鄰居的身體仍可能蓋到你的對話框(每隻的堆疊層級是按 X 座標排的) |
| `bubbleSideGap` | int | -20 ~ 50 | `-5` | 只在 `bubblePosition=side` 生效:本體邊緣與對話框之間的左右空隙。單位是**點陣圖像素**,會乘上對話框放大倍率(小/中 2x、大 3x),所以 `-5` 實際是 -10px / -15px。**預設為負數 = 往身體上疊**,搭配 `bubbleLayer=front` 才像遊戲裡在講話;`0` = 貼齊身體邊緣;正數 = 整個框推到身體外面完全不重疊。也會一併影響「快出畫面翻到內側」的判斷 |
| `bubbleSideLift` | int | -50 ~ 100 | `2` | 只在 `bubblePosition=side` 生效:垂直微調 px。對話框底邊本來錨在**身高六成**處,這個值再往上加(負數往下)。單位是螢幕 px、不乘放大倍率——六成的錨點已經是等比例的,這裡只是收尾的幾個像素 |
| `hopHeight` | float | 0 ~ 50 | `3` | 走路跳步的基礎高度 px |
| `hopVariance` | float | 0 ~ 50 | `2` | 個體間的跳步高度差異上限 |
| `hopFrequency` | float | 0 ~ 1 | `0.005` | 跳步頻率(越小跳越慢) |
| `personalSpace` | int | 0 ~ 1000 | `56` | 同伴間最小距離 px,太近會掉頭 |
| `baseSize` | int | 16 ~ 512 | `128` | 「大」體型的顯示高度 px(中 = 0.8 倍、小 = 0.6 倍) |
| `shadowWidthRatio` | float | 0 ~ 2 | `0.9` | 影子寬度相對寶可夢寬度的比例 |
| `theme` | enum | `none` / `grass` / `water` / `snow` / `sand` / `rock` / `dirt` / `lava` | `none` | **主題地面**:在頁面最底鋪一條像素地面(高度見 `themeHeight`),寶可夢會站上去(依地形略微踩進表面:草蓋腳邊、雪會下陷、水泡到小腿、岩地平踩)。水域與熔岩會緩慢流動;貼片圖樣每次載入隨機生成。`none` = 關閉,維持透明背景 |
| `themeHeight` | int | 4 ~ 200 | `12` | 主題地面的高度 px。內部以 2px 像素格繪製,實際高度會取到最接近的偶數;只在 `theme` ≠ `none` 時有意義 |
| `flybyDelayMin` | int | 1000 ~ 600000 | `15000` | **客串事件**:距離下一次「擲骰時點」的間隔下限 ms |
| `flybyDelayMax` | int | 1000 ~ 600000 | `20000` | 擲骰間隔上限 ms(min > max 自動對調) |
| `flybyChance` | float | 0 ~ 1 | `0.25` | 每次擲骰真的觸發客串的機率(`0` = 整個機制關閉)。觸發時一隻寶可夢從畫面外**沿隨機斜線航道、浮浮沉沉地**高速橫越(這趟可能左 45% 飛到右 60%,下一趟右 70% 飛到左 50%),不加入常駐陣容;色違吃全頁 `shinyChance`,中了會拖金色星塵尾跡 |
| `flybyLegendaryChance` | float | 0 ~ 1 | `0.05` | 觸發時抽「**會飛的傳說池**」(9 隻:三聖鳥/洛奇亞/鳳王/烈空坐/雲三家)而非「飛行池」(73 隻飛行系,平均分佈)的機率。兩池全員任一屬性槽都含飛行——固拉多再傳說也不會飛,不會亂入天空 |
| `flybySpeed` | float | 1 ~ 100 | `5` | 橫越速度 px/幀(60fps 基準),實際每次 ±15% 隨機 |
| `remote` | enum | `on` / `off` | `on` | **postMessage 遙控**總開關:`off` = 完全不理會遙控訊息(連回執都不給)。指令與串接方法見下方「postMessage 遙控」一節 |
| `remoteRateLimit` | int | 1 ~ 100 | `10` | 遙控指令節流:每秒最多處理幾道,超額的直接丟棄並回執 `rate limited`(防聊天室洗版) |
| `berry` | enum | `on` / `off` | `on` | **丟果實餵食**總開關:點寶可夢「本體」= 戳戳互動;點「空白處」= 從點擊位置掉下一顆像素樹果,距離最近的那隻不論在做什麼都會跑過來,三口吃掉 + 冒愛心。一次只能有一顆,整套(掉落 → 跑來 → 吃 → 愛心)演完才能再丟;活動範圍外的點擊,果實會落在牠搆得到的最近位置。`off` = 點空白處無事發生 |

## 容錯規則

亂帶參數不會弄壞頁面,規則如下(都會在瀏覽器 console 留下警告):

- **不在表上的參數**:直接無視。
- **非數字或超出允許範圍**:忽略該參數,使用預設值。
- **`minId` > `maxId`** 或 **`lookTimeMin` > `lookTimeMax`**:自動對調。
- **`boundsMin` >= `boundsMax`**:整組退回預設 0.1 ~ 0.9。
- **`count` 超過可抽選的編號數量**:自動夾到 `maxId - minId + 1`(避免抽選卡死)。
- **`ids` 內的非法編號**:逐一剔除,全部非法才退回隨機抽選。

## 範例食譜

| 想要的效果 | 網址參數 |
|------------|----------|
| 專案吉祥物固定陣容(皮卡丘+伊布+噴火龍) | `?ids=25,133,6` |
| 五隻伊布 | `?ids=133,133,133,133,133` |
| 初代御三家世界 | `?minId=1&maxId=151&count=6` |
| 寶可夢大遊行 | `?count=20&baseSpeed=0.4` |
| 安靜穩重風(少動多發呆,不冒泡) | `?baseSpeed=0.1&idleChance=0.03&bubblePosition=none` |
| 對話框改回頭頂(側邊空間有限時) | `?bubblePosition=top` |
| 對話框不要疊在身體上 / 疊更多 | `?bubbleSideGap=2` / `?bubbleSideGap=-14` |
| 對話框再高一點 / 低一點 | `?bubbleSideLift=8` / `?bubbleSideLift=-4` |
| 對話框躲到寶可夢後面 | `?bubbleLayer=behind` |
| 全員色違遊行 | `?shinyChance=1&count=10` |
| 回到正作原生的色違機率 | `?shinyChance=0.000244` |
| 過動兒模式(常發呆、狂跳) | `?idleChance=0.03&idleJumpChance=0.02` |
| 色違煙火放好放滿 | `?shinyChance=1&shinyBurstDuration=3000` |
| 巨大化 | `?baseSize=160&count=2` |
| 只在畫面右半邊活動 | `?boundsMin=0.5&boundsMax=0.95` |
| 草地散步 | `?theme=grass` |
| 海邊戲水(可達鴨一家+乘龍) | `?theme=water&ids=54,55,116,131` |
| 熔岩試膽(小火龍一家) | `?theme=lava&ids=4,5,6` |
| 客串頻發(展示/測試用) | `?flybyChance=1&flybyDelayMin=2000&flybyDelayMax=4000` |
| 傳說時刻(每次都是傳說級路過) | `?flybyChance=1&flybyLegendaryChance=1&flybyDelayMin=3000&flybyDelayMax=5000` |

## postMessage 遙控

URL 參數是「載入時」的客製;`postMessage` 則是**執行中**的遙控——父頁面隨時能隔著 iframe 疆界下指令(讓觀眾用聊天室指令召喚寶可夢,就是靠這個)。postMessage 是瀏覽器原生的跨視窗通道,**不走網路、不受 CORS 限制**,跨網域 iframe 直接可用。

### 快速開始(嵌入方網頁)

```html
<iframe id="poke" src="https://rd7-ai-gw-02.i17game.net/poke-stroll/"
        style="position:fixed; bottom:0; left:0; width:100%; height:200px;
               border:none; pointer-events:none; color-scheme:light;"></iframe>
<script>
    const poke = document.getElementById('poke');
    function pokeCmd(cmd, extra = {}) {
        poke.contentWindow.postMessage({ ns: 'poke-stroll', cmd, ...extra }, '*');
    }
    // 例:客串一隻卡比獸高速飛過
    pokeCmd('spawn', { id: 143 });
</script>
```

### 訊息格式

送入的訊息必須是物件,且 `ns` 固定為 `'poke-stroll'`。沒有這個欄位的訊息**一律無視**——父頁面常有別的 iframe 與腳本在互傳訊息,不是寄給我們的信不拆:

```js
{ ns: 'poke-stroll', cmd: '<指令>', ...參數 }
```

### 指令表

| 指令 | 參數 | 效果 |
|------|------|------|
| `spawn` | `id`(選填,1 ~ 1025) | 客串一隻從畫面外高速橫越。帶 `id` 指定誰路過(**不限飛行系**,遙控的卡比獸也能飛);不帶就照常抽飛行池(含傳說機率那一層)。色違照全頁 `shinyChance` 擲骰 |
| `poke` | `id`(選填) | 開心跳一下 + 冒愛心(跟滑鼠點擊同一種互動)。帶 `id` 只戳該圖鑑編號的成員,不帶就全員 |
| `burst` | — | 場上所有**色違**立刻重播星星特效(重播排程會重排,不會越放越密);場上沒有色違就是 `count: 0` |

### 回執

每道指令都會回一則訊息給發送方,串接時可用來除錯與確認送達:

```js
window.addEventListener('message', e => {
    if (e.data?.ns !== 'poke-stroll' || !e.data.re) return;
    console.log(e.data); // 例:{ ns: 'poke-stroll', re: 'poke', ok: true, count: 2 }
});
```

| 欄位 | 說明 |
|------|------|
| `re` | 回應的是哪道指令 |
| `ok` | 是否已執行 |
| `count` | (`poke` / `burst`)實際作用到幾隻 |
| `reason` | `ok: false` 時的原因:`unknown cmd` / `id must be 1~1025` / `cameo pools not loaded` / `page hidden`(背景分頁不生成) / `rate limited` |

### 防護與限制

- **指令白名單**:不認識的指令回 `ok:false`;結構不對的訊息完全無視。
- **節流**:預設每秒最多 `remoteRateLimit`(10)道,超額整道丟棄——聊天室洗版也拖不垮渲染。
- **總開關**:`?remote=off` 後完全靜默(連回執都不給,像沒這功能)。
- 刻意**不驗 origin**:指令全是無害的視覺效果、無機密無狀態,最壞情況是有人在他自己的頁面上讓皮卡丘跳舞。要鎖就用 `remote=off` 整個關閉。

### 進階:接聊天室(OBS wrapper 模式)

聊天 bot 等**外部程式**碰不到 postMessage(不同行程、沒有共同的瀏覽器語境)。做法是讓 OBS 載入一頁薄薄的 wrapper,由它對外連 WebSocket 收聊天訊息、對內轉譯成 postMessage:

```html
<!-- wrapper.html:OBS 瀏覽器來源載入這一頁(widget 本體完全不用改) -->
<iframe id="poke" src="./pokemon_footer_widget.html"
        style="position:fixed; inset:0; width:100%; height:100%; border:none;"></iframe>
<script>
    const poke = document.getElementById('poke');
    // Twitch 允許匿名唯讀連聊天室,零申請零金鑰
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.onopen = () => {
        ws.send('NICK justinfan12345');   // justinfan+數字 = 官方保留的匿名帳號
        ws.send('JOIN #你的頻道名稱');
    };
    ws.onmessage = ev => {
        if (ev.data.startsWith('PING')) return ws.send('PONG :tmi.twitch.tv');
        // 觀眾打「!pokemon 143」→ 客串一隻卡比獸
        const m = ev.data.match(/PRIVMSG #\S+ :!pokemon (\d{1,4})/);
        if (m) poke.contentWindow.postMessage(
            { ns: 'poke-stroll', cmd: 'spawn', id: Number(m[1]) }, '*');
    };
</script>
```

widget 端已內建每秒節流;wrapper 想更嚴(單一觀眾冷卻、訂閱者限定)就在這一層做,平台相關的邏輯全關在 wrapper 裡,widget 永遠不知道 Twitch 存在。
