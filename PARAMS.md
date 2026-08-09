# URL 參數 API

嵌入 PokéStroll 時,可以在網址後面用 query string 客製行為,**不用改任何程式或設定檔**:

```html
<iframe src="https://rd7-ai-gw-02.i17game.net/poke-stroll/?count=5&baseSize=120"
        style="position:fixed; bottom:0; left:0; width:100%; height:200px;
               border:none; pointer-events:none;"></iframe>
```

不帶參數就使用預設值。本機直接開檔案也支援(`file:///...pokemon_footer_widget.html?count=10`)。

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
| `shinyBurstDuration` | int | 100 ~ 10000 | `1400` | 色違登場星星特效的飛散+淡出總時長 ms |
| `bubblePosition` | enum | `top` / `side` / `none` | `side` | 對話框位置:`top` 頭頂正上方、`side` 面向方向的側邊(整框推到身體外側,尾巴鏡像成朝內指回本體;轉向時自動換邊,走到畫面邊緣快被裁掉時也會自動翻到內側)、`none` 完全不顯示(空間有限的頁面適用) |
| `bubbleLayer` | enum | `front` / `behind` | `front` | 對話框在本體的上層(`front`,像遊戲裡角色講話的對話框,會遮到一點身體)還是下層(`behind`,完全不遮本體)。**注意**:只在同一隻的本體之間分層,右邊鄰居的身體仍可能蓋到你的對話框(每隻的堆疊層級是按 X 座標排的) |
| `bubbleSideGap` | int | -20 ~ 50 | `2` | 只在 `bubblePosition=side` 生效:本體邊緣與對話框之間的左右空隙。單位是**點陣圖像素**,會乘上對話框放大倍率(小/中 2x、大 3x),所以 `2` 實際是 4px / 6px。`0` = 貼齊身體邊緣;**負數 = 往身體上疊**(約 `-10` 回到舊版半重疊的樣子)。也會一併影響「快出畫面翻到內側」的判斷 |
| `hopHeight` | float | 0 ~ 50 | `3` | 走路跳步的基礎高度 px |
| `hopVariance` | float | 0 ~ 50 | `2` | 個體間的跳步高度差異上限 |
| `hopFrequency` | float | 0 ~ 1 | `0.005` | 跳步頻率(越小跳越慢) |
| `personalSpace` | int | 0 ~ 1000 | `56` | 同伴間最小距離 px,太近會掉頭 |
| `baseSize` | int | 16 ~ 512 | `128` | 「大」體型的顯示高度 px(中 = 0.8 倍、小 = 0.6 倍) |
| `shadowWidthRatio` | float | 0 ~ 2 | `0.9` | 影子寬度相對寶可夢寬度的比例 |

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
| 對話框離身體遠一點 / 貼緊一點 | `?bubbleSideGap=6` / `?bubbleSideGap=0` |
| 全員色違遊行 | `?shinyChance=1&count=10` |
| 回到正作原生的色違機率 | `?shinyChance=0.000244` |
| 過動兒模式(常發呆、狂跳) | `?idleChance=0.03&idleJumpChance=0.02` |
| 色違煙火放好放滿 | `?shinyChance=1&shinyBurstDuration=3000` |
| 巨大化 | `?baseSize=160&count=2` |
| 只在畫面右半邊活動 | `?boundsMin=0.5&boundsMax=0.95` |
