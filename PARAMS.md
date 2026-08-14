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
> 夜間模式介面,可搜尋、分類篩選、一鍵複製,還有**即時預覽區**,每道食譜按一下就能看效果。預覽區位置可挑:上下是橫軌、左右是對半分(測飛行軌跡的滿高畫面),預設在右半邊,也能整塊關掉。
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
| `shinyBurstDuration` | int | 100 ~ 10000 | `1500` | 色違星星特效的飛散+淡出總時長 ms |
| `shinyBurstScale` | float | 0.1 ~ 5 | `1.5` | 色違星星特效的**飛散範圍倍率**——星星從本體正中心向外炸開,這是炸多遠的倍率:`2` 範圍加倍、`0.5` 縮小一半。只調範圍,星星本身大小不變 |
| `shinyBurstDelayMin` | int | 1000 ~ 600000 | `15000` | 常駐色違的星星特效**定時重播**間隔下限 ms——登場放一輪後,每隔區間內的隨機秒數再放一輪,開頁沒看到或中途進來的人也不會錯過 |
| `shinyBurstDelayMax` | int | 1000 ~ 600000 | `20000` | 重播間隔上限 ms(min > max 自動對調) |
| `bubblePosition` | enum | `top` / `side` / `none` | `side` | 對話框位置:`top` 頭頂正上方、`side` 面向方向的側邊(整框推到身體外側,尾巴移到靠本體那個下角、鏡像成朝內指回本體;轉向時自動換邊,走到畫面邊緣快被裁掉時也會自動翻到內側)、`none` 完全不顯示(空間有限的頁面適用) |
| `bubbleLayer` | enum | `front` / `behind` | `front` | 對話框在本體的上層(`front`,像遊戲裡角色講話的對話框,會遮到一點身體)還是下層(`behind`,完全不遮本體)。**注意**:只在同一隻的本體之間分層,右邊鄰居的身體仍可能蓋到你的對話框(每隻的堆疊層級是按 X 座標排的) |
| `bubbleSideGap` | int | -20 ~ 50 | `-5` | 只在 `bubblePosition=side` 生效:本體邊緣與對話框之間的左右空隙。單位是**點陣圖像素**,會乘上對話框放大倍率(小/中 2x、大 3x),所以 `-5` 實際是 -10px / -15px。**預設為負數 = 往身體上疊**,搭配 `bubbleLayer=front` 才像遊戲裡在講話;`0` = 貼齊身體邊緣;正數 = 整個框推到身體外面完全不重疊。也會一併影響「快出畫面翻到內側」的判斷 |
| `bubbleSideLift` | int | -50 ~ 100 | `2` | 只在 `bubblePosition=side` 生效:垂直微調 px。對話框底邊本來錨在**身高六成**處,這個值再往上加(負數往下)。單位是螢幕 px、不乘放大倍率——六成的錨點已經是等比例的,這裡只是收尾的幾個像素 |
| `hopHeight` | float | 0 ~ 50 | `3` | 走路跳步的基礎高度 px |
| `hopVariance` | float | 0 ~ 50 | `2` | 個體間的跳步高度差異上限 |
| `hopFrequency` | float | 0 ~ 1 | `0.005` | 跳步頻率(越小跳越慢) |
| `personalSpace` | int | 0 ~ 1000 | `56` | 同伴間最小距離 px,太近會掉頭 |
| `greetChance` | float | 0 ~ 1 | `0.1` | **偶遇打招呼**:兩隻擦肩擠進 `personalSpace` 時,雙方都有空的話有這個機率不掉頭、改停下來寒暄——先各退到「彼此身寬 + 一點空隙」的站位(身體不會疊在一起),**面對面後才**冒出音符或愛心,聊個一兩秒再轉身走開。寒暄完有 8~15 秒冷卻,同一對不會原地無限寒暄;發呆中也能被搭話,餵食流程中不會。`0` = 關閉 |
| `baseSize` | int | 16 ~ 512 | `128` | 「大」體型的顯示高度 px(中 = 0.8 倍、小 = 0.6 倍) |
| `shadowWidthRatio` | float | 0 ~ 2 | `0.9` | 影子寬度相對寶可夢寬度的比例 |
| `theme` | enum | `none` / `random` / `grass` / `water` / `snow` / `sand` / `rock` / `dirt` / `lava` | `random` | **主題地面**:在頁面最底鋪一條像素地面(高度見 `themeHeight`),寶可夢會站上去(依地形略微踩進表面:草蓋腳邊、雪會下陷、水泡到小腿、岩地平踩)。水域與熔岩會緩慢流動;貼片圖樣每次載入隨機生成。`random` = 每次載入隨機抽一種(預設,隨機池 = 七種地形 + 無地板,狂按 F5 就是輪盤);`none` = 關閉,維持透明背景 |
| `themeHeight` | int | 4 ~ 200 | `6` | 主題地面的高度 px。內部以 2px 像素格繪製,實際高度會取到最接近的偶數;只在 `theme` ≠ `none` 時有意義 |
| `weatherChance` | float | 0 ~ 1 | `0.5` | **天氣**:每次載入擲一次骰,中了整頁就下著這場天氣——種類由主題地面決定:**雨**(草地/水域/岩地/土徑,斜斜細細長長的藍色雨絲)、**雪**(雪地,白色小點慢慢飄、左右搖曳)、**風沙**(沙灘,橫向沙痕順風橫掃)、**火星**(熔岩,橘黃小火星從低處上飄漸滅)。風向(雨的斜向、沙的走向)每次隨機一邊;粒子全用 CSS 動畫循環,不吃主迴圈效能。`theme=none` 沒有場景就沒有天氣;`0` = 永遠晴天 |
| `weatherDensity` | float | 0.2 ~ 5 | `1` | 天氣的**粒子密度倍率**:雨絲/雪花/沙痕/火星的數量 = 基準(依視窗寬換算)× 這個值。`2` = 傾盆大雨、`0.5` = 毛毛雨 |
| `flybyDelayMin` | int | 1000 ~ 600000 | `15000` | **客串事件**:距離下一次「擲骰時點」的間隔下限 ms |
| `flybyDelayMax` | int | 1000 ~ 600000 | `20000` | 擲骰間隔上限 ms(min > max 自動對調) |
| `flybyChance` | float | 0 ~ 1 | `0.25` | 每次擲骰真的觸發客串的機率(`0` = 整個機制關閉)。觸發時一隻寶可夢從畫面外**沿隨機斜線航道、浮浮沉沉地**高速橫越(這趟可能左 45% 飛到右 60%,下一趟右 70% 飛到左 50%),不加入常駐陣容;色違吃全頁 `shinyChance`,中了會拖金色星塵尾跡 |
| `flybyLegendaryChance` | float | 0 ~ 1 | `0.05` | 觸發時抽「**會飛的傳說池**」(9 隻:三聖鳥/洛奇亞/鳳王/烈空坐/雲三家)而非「飛行池」(73 隻飛行系,平均分佈)的機率。兩池全員任一屬性槽都含飛行——固拉多再傳說也不會飛,不會亂入天空 |
| `flybyDeliveryChance` | float | 0 ~ 1 | `0.2` | 觸發客串時改派「**信使鳥空投**」的機率:信使鳥叼著果實橫越,半路鬆爪掉下一顆,之後就是一般的餵食流程(最近且有空的成員冒驚嘆號跑去吃)。那一刻大家都在忙就整顆叼走不落地;`berry=off` 時不派這趟任務。`0` = 關閉 |
| `flybySpeed` | float | 1 ~ 100 | `5` | 橫越速度 px/幀(60fps 基準),實際每次 ±15% 隨機 |
| `remote` | enum | `on` / `off` | `on` | **postMessage 遙控**總開關:`off` = 完全不理會遙控訊息(連回執都不給)。指令與串接方法見下方「postMessage 遙控」一節 |
| `remoteRateLimit` | int | 1 ~ 100 | `10` | 遙控指令節流:每秒最多處理幾道,超額的直接丟棄並回執 `rate limited`(防高頻洗版) |
| `berry` | enum | `on` / `off` | `on` | **丟果實餵食**總開關:**左鍵**點「空白處」= 從點擊位置掉下一顆像素樹果,距離最近且**有空**的那隻會發現它——停下手邊的事、**原地跳一下**冒出驚嘆號,再跑過來三口吃掉 + 冒愛心。一隻只追一顆,流程中(發現 → 跑去 → 吃 → 愛心)不會發現其他果實,所以同時最多「常駐數量」(`count`)顆;活動範圍外的點擊,果實會落在牠搆得到的最近位置。`off` = 點空白處無事發生(本體的左鍵抓取與右鍵戳戳不受影響) |
| `snatchChance` | float | 0 ~ 1 | `0.25` | **空中搶食**:左鍵點空白處丟果實、被指派的那隻與果實落點的距離**超過 `snatchDistance`** 時,有這個機率被盯上——牠照常起跑(看不出異狀),跑完**一半路程**時一隻**飛行系**從果實那一側的畫面外進場,牠嚇得**原地停步跳一下**、再冒一次驚嘆號,賊鳥沿 **V 字軌跡**俯衝到底部叼走果實(還在半空也接得住),再沿進場俯衝角度的**鏡像**斜上遠走高飛:恆定速度、越飛越小、越飛越淡(透視感),彷彿真的飛遠了。目擊的那隻在被叼走那一刻換成**一團黑線**,沮喪個幾秒才回去散步;其他成員照常散步。與飛行系客串(`flybyChance`)互相獨立,兩者可同時在場;一次只演一場;只作用於「點擊丟果實」,遙控 `feed` 與信使鳥空投不受影響。**追果實的那隻被滑鼠抓走**時果實沒人護著,伏筆會**立刻兌現**——賊鳥直接出手,被抓著的苦主忙著掙扎,不驚嘆也不黑線;放手若還來得及落地撞見俯衝,照舊補演目擊戲。`0` = 關閉 |
| `snatchDistance` | int | 0 ~ 2000 | `150` | 搶食的**距離門檻** px:被指派的那隻與果實落點的水平距離**超過**這個值才擲 `snatchChance`。門檻內**絕對安全**——果實丟在腳邊護得住,丟得越遠越可能被半路攔截,餵食因此有了取捨。`0` = 每一顆都可能被搶 |
| `snatchDiveRate` | float | 0.2 ~ 10 | `1.6` | 賊鳥**進場俯衝的速度倍率**:實際速度 = 巡航速度(`flybySpeed`)× 這個值(每次 ±10% 隨機,與離場共用同一次抽選)。愈大衝得愈快;調很慢也沒關係,目擊者的等待保險絲會跟著航程自動拉長 |
| `snatchFleeRate` | float | 0.2 ~ 10 | `1.8` | 賊鳥**得手後遠走的速度倍率**:實際速度 = `flybySpeed` × 這個值,恆定速度直線飛。預設比進場快一點(1.8 > 1.6)= 得手後加速逃逸的手感 |
| `snatchShrinkRate` | float | 0 ~ 10 | `1` | 遠走時**縮小的倍速**:`1` = 基準(2.4 秒縮到 0.25 倍,透視曲線近快遠慢)、`2` = 兩倍快、`0.5` = 半速拉長餘韻、`0` = 不縮小。與變淡分開計時,可以只調其中一個 |
| `snatchFadeRate` | float | 0 ~ 10 | `1` | 遠走時**變淡的倍速**:`1` = 基準(2.4 秒淡到全透明,前段幾乎不淡、尾段一口氣收乾淨)、`2` = 兩倍快、`0` = 永不變淡(飛到出畫面為止)。**透明度淡完或飛出畫面,先到者收場** |
| `drag` | enum | `on` / `off` | `on` | **滑鼠拖曳**總開關:**左鍵按住本體**就把那一隻「抓起來」——**按下的那一刻立刻跟手**(刻意不設長按門檻:門檻期間身體不動、游標卻繼續走,那段距離會被凍進偏移量裡,整段拖曳都差一截),跟著游標走、在手上掙扎,放開手才自由落體回地面。抓在手上的那隻等於暫時離場:不散步、不冒對話框、不寒暄、戳不動,新的果實也不會指派給牠(點擊、遙控 `feed`、信使鳥空投三個入口一致——寧可整顆叼走)。**追到一半的那顆不沒收**:果實留在原地等牠,放手落地就**回去續追**——代價是落地時依「新的距離」**重擲搶食的骰**(`snatchChance`),被抓去遠方再放開,遠的距離就要面對遠的風險。游標拉出活動範圍時牠**貼著邊界繼續掙扎**,不會被拖出場外。`off` = 抓不起來,右鍵的戳戳互動不受影響 |
| `dragStruggleRate` | float | 0 ~ 10 | `2` | 抓在手上時掙扎動畫的**倍速**(`2` = 兩倍快,`0` = 抓著但不掙扎)。註:GIF 本身的播放速率瀏覽器不開放 JS 控制,所以掙扎感是 widget 自己畫的擺盪 + 上下抖動,這個值調的是那套動畫 |

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
| 雨中散步 | `?theme=water&weatherChance=1` |
| 大雪紛飛 | `?theme=snow&weatherChance=1&weatherDensity=2` |
| 永遠晴天(不要天氣) | `?weatherChance=0` |
| 海邊戲水(可達鴨一家+乘龍) | `?theme=water&ids=54,55,116,131` |
| 熔岩試膽(小火龍一家) | `?theme=lava&ids=4,5,6` |
| 客串頻發(展示/測試用) | `?flybyChance=1&flybyDelayMin=2000&flybyDelayMax=4000` |
| 傳說時刻(每次都是傳說級路過) | `?flybyChance=1&flybyLegendaryChance=1&flybyDelayMin=3000&flybyDelayMax=5000` |
| 信使鳥快遞頻發(每趟客串都空投果實) | `?flybyChance=1&flybyDeliveryChance=1&flybyDelayMin=2000&flybyDelayMax=4000` |
| 社交花蝴蝶(一擦肩就停下來寒暄) | `?greetChance=1&count=6` |
| 鳶口奪食(每次丟果實都被搶) | `?snatchChance=1&snatchDistance=0` |
| 慢動作搶食(俯衝慢、餘韻長) | `?snatchChance=1&snatchDistance=0&snatchDiveRate=0.8&snatchShrinkRate=0.5&snatchFadeRate=0.5` |
| 安心吃飯(永遠沒有賊鳥) | `?snatchChance=0` |
| 完全不要地面(關掉預設的隨機地面) | `?theme=none` |
| 掙扎更激烈(抓在手上扭得更兇) | `?dragStruggleRate=4` |
| 純觀賞(不給抓,右鍵仍可戳) | `?drag=off` |

## postMessage 遙控

URL 參數是「載入時」的客製;`postMessage` 則是**執行中**的遙控——父頁面隨時能隔著 iframe 疆界下指令(讓使用者從你的介面即時召喚寶可夢,就是靠這個)。postMessage 是瀏覽器原生的跨視窗通道,**不走網路、不受 CORS 限制**,跨網域 iframe 直接可用。

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
| `spawn` | `id`(選填,1 ~ 1025)<br>`delivery`(選填,true) | 客串一隻從畫面外高速橫越。帶 `id` 指定誰路過(**不限飛行系**,遙控的卡比獸也能飛);不帶就照常抽飛行池(含傳說機率那一層)。帶 `delivery: true` 改派**信使鳥空投**:叼著果實橫越、半路鬆爪掉下一顆(大家都在忙就整顆叼走;`berry=off` 回 `berry is off`)。色違照全頁 `shinyChance` 擲骰 |
| `poke` | `id`(選填) | 開心跳一下 + 冒愛心(跟滑鼠右鍵點本體同一種互動)。帶 `id` 只戳該圖鑑編號的成員,不帶就全員;**正被滑鼠抓在手上的戳不動**,回執的 `count` 也不算牠 |
| `burst` | — | 場上所有**色違**立刻重播星星特效(重播排程會重排,不會越放越密);場上沒有色違就是 `count: 0` |
| `join` | `id`(選填,1 ~ 1025) | 加入一隻**常駐**成員(會留下來散步,不是路過的客串)。帶 `id` 指定誰入隊,不帶就照 `minId` / `maxId` 隨機抽;回執的 `id` 告訴你誰來了。隊伍上限與 `count` 參數同一個天花板(50),滿了回 `party is full` |
| `leave` | `id`(選填) | 送走一隻常駐成員。帶 `id` 指定送誰(同編號多隻就送最晚入隊的),不帶就隨機挑;回執的 `id` 告訴你誰走了。**最後一隻不送**(回 `last one standing`);正在追的果實會一併收走,不留孤兒果實;正被滑鼠抓在手上的會先自動鬆手 |
| `feed` | `count`(選填,≥ 1) | 從天上隨機位置降下果實,掉法與點擊空白處丟果實同一套(最近且有空的成員冒驚嘆號跑去吃)。帶 `count` 指定顆數,不帶就隨機;上限都是「**有空的**常駐成員數」(一隻只追一顆;被滑鼠抓在手上的也不算有空),回執的 `count` 是實際掉了幾顆。大家都在忙回 `everyone is busy` |
| `roster` | — | **查詢**目前常駐陣容,不動畫面。回執帶 `count`(總數)與 `roster` 陣列,每隻是 `{ id, shiny, size }`(圖鑑編號 / 是否色違 / 體型倍率 0.6 小、0.8 中、1 大)。要做陣容面板、投票名單之類的整合,資料從這裡拿 |

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
| `count` | (`poke` / `burst`)實際作用到幾隻;(`feed`)實際掉了幾顆;(`roster`)常駐總數 |
| `id` | (`join` / `leave`)實際加入 / 送走的圖鑑編號;(`spawn` 空投)信使鳥的編號 225 |
| `roster` | (`roster`)常駐陣容陣列,每隻 `{ id, shiny, size }` |
| `reason` | `ok: false` 時的原因:`unknown cmd` / `id must be 1~1025` / `id not found` / `cameo pools not loaded` / `page hidden`(背景分頁不演視覺效果) / `rate limited` / `party is full` / `last one standing` / `berry is off` / `everyone is busy` / `count must be >= 1` |

### 防護與限制

- **指令白名單**:不認識的指令回 `ok:false`;結構不對的訊息完全無視。
- **節流**:預設每秒最多 `remoteRateLimit`(10)道,超額整道丟棄——高頻灌指令也拖不垮渲染。
- **總開關**:`?remote=off` 後完全靜默(連回執都不給,像沒這功能)。
- 刻意**不驗 origin**:指令全是無害的視覺效果、無機密無狀態,最壞情況是有人在他自己的頁面上讓皮卡丘跳舞。要鎖就用 `remote=off` 整個關閉。

### 進階:接外部程式(wrapper 模式)

後台服務、bot 等**外部程式**碰不到 postMessage(不同行程、沒有共同的瀏覽器語境)。做法是讓 OBS 或任何頁面載入一頁薄薄的 wrapper,由它對外連 WebSocket 收事件、對內轉譯成 postMessage:

```html
<!-- wrapper.html:OBS 或任何頁面載入這一頁(widget 本體完全不用改) -->
<iframe id="poke" src="./pokemon_footer_widget.html"
        style="position:fixed; inset:0; width:100%; height:100%; border:none;"></iframe>
<script>
    const poke = document.getElementById('poke');
    // 對外連你自己的服務:後台推播、事件匯流排…任何 WebSocket 來源都行
    const ws = new WebSocket('wss://your-service.example/events');
    ws.onmessage = ev => {
        // 服務端推 {"cmd":"spawn","id":143} 之類的 JSON 事件,轉譯成 postMessage;
        // wrapper 這層先過白名單,不認識的指令不轉發
        const m = JSON.parse(ev.data);
        if (['spawn', 'join', 'leave', 'feed', 'poke', 'burst', 'roster'].includes(m.cmd)) {
            poke.contentWindow.postMessage({ ns: 'poke-stroll', ...m }, '*');
        }
    };
</script>
```

widget 端已內建每秒節流;wrapper 想更嚴(單一使用者冷卻、權限限定)就在這一層做,事件來源相關的邏輯全關在 wrapper 裡,widget 完全不用知道指令從哪來。
