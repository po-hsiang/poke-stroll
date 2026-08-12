# 部署指南(容器化 / GCP + Traefik)

純靜態站(nginx:alpine),無後端、無資料庫、無環境機密。`.env` 直接進版控,主機上 `git pull` 即用。

## 本機建置與測試

```bash
# 建置(版本號與 .env 的 VERSION 一致)
docker build -t asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.29.0 .

# 本機試跑
docker run --rm -p 8080:80 asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.29.0
# 瀏覽器 / OBS 瀏覽器來源開 http://localhost:8080/ 即可看到 widget
```

## 推上 Google Artifact Registry

```bash
docker push asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.29.0
```

## 雲端主機部署

```bash
docker pull asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.29.0
docker compose up -d
```

改版時:改 `.env` 的 `VERSION` → 重新 build/push/pull → `docker compose up -d` 換新容器。

## 版本治理

`.env` 的 `VERSION` 是**唯一的版本事實來源**,CI 會把它落實成 git tag:

- push 到 main 時,CI 檢查 `VERSION` 是 `x.y.z` 格式、**不可倒退、不可重用**,
  是新版號就**自動補上 `vX.Y.Z` tag**——人只要記得 bump `VERSION`,不用記得打 tag。
- 沒 bump 版號的 push(改文件之類)也合法,CI 只確認既有 tag 落在這條歷史上。
- 想看某一版的程式碼:`git switch --detach v0.17.0`;完整版本史:`git tag -l 'v*' | sort -V`。
- 歷史版本 v0.1.0 ~ v0.17.0 已一次回填(打在每個版號第一次出現的 commit 上)。

## 部署後的網址

| 用途 | 網址 |
|------|------|
| 直接觀看 / iframe 嵌入 | `https://rd7-ai-gw-02.i17game.net/poke-stroll/` |
| 完整檔名(等價) | `https://rd7-ai-gw-02.i17game.net/poke-stroll/pokemon_footer_widget.html` |
| 參數互動文件(丟給嵌入方同仁) | `https://rd7-ai-gw-02.i17game.net/poke-stroll/params.html` |

## 同仁 iframe 嵌入範例

```html
<iframe src="https://rd7-ai-gw-02.i17game.net/poke-stroll/"
        style="position:fixed; bottom:0; left:0; width:100%; height:200px;
               border:none; pointer-events:none;"></iframe>
```

想要不同的生成數量、體型、固定陣容?在網址後掛 query string 即可,例如
`/poke-stroll/?count=5&ids=25,133,6`,各專案互不影響。完整參數見 [PARAMS.md](PARAMS.md)。

## CI

每個 push / PR 會自動跑 `.github/workflows/ci.yml`:單元測試(`node test/widget.test.js`)+
Docker 建置 + 容器冒煙測試(每個靜態檔 200、快取標頭正確、README 不在 image 裡)。
紅燈就別 push image 上 GAR。

## 設計筆記(為什麼這樣設)

- **快取策略(nginx.conf)**:widget HTML 與 `config.js` 給 `no-cache`——不是「不快取」,而是每次都帶 ETag 協商(304 很便宜),改版部署後訪客重新整理立刻拿到新版,不會有新舊版混用的混沌期;兩張圖鑑對照表幾乎不變,快取一天。
- **釘定基底版本**:`FROM nginx:1.29-alpine` 而非浮動的 `nginx:alpine`,半年後重 build 也是同一顆 nginx。要升版就改 Dockerfile,讓升版是「看得見的 diff」。
- **healthcheck + restart**:`wget --spider` 打本機 80(busybox 內建,免裝 curl);`restart: unless-stopped` 放頂層而非 `deploy.restart_policy`(後者非 Swarm 支援度不一),主機重開機容器自動回來。
- **Traefik 埠改 v2 正式寫法**:舊範本的 `traefik.basic.port` 是 v1 語法,v2 閘道不吃,先前能動全靠自動偵測 EXPOSE 埠;已改成 `traefik.http.services.<name>.loadbalancer.server.port` 明示。
- **不發佈 ports**:Traefik 與容器同在 `ipa_service_net`,從 docker network 內直達容器的 80,不需要把埠發佈到主機——發佈出去等於多一條繞過閘道的直連通道。本機測試走 `docker run -p 8080:80`(見上方指令),完全不經 compose,不受影響。
- **尾斜線 301**:compose 裡多一組 `redirectregex` middleware,把 `/poke-stroll`(無尾斜線)導向 `/poke-stroll/`。頁面內 `./config.js` 等相對路徑以「目錄」為基準,少了尾斜線資源會被瀏覽器解析到網站根路徑而 404。API 服務不在乎這個,靜態頁必須處理。
- **可嵌入性**:nginx 預設不送 `X-Frame-Options` / `frame-ancestors`,任何網站都能 iframe。若日後要限制,再加 header 白名單即可。
- **寶可夢圖片來源**:sprite 是「訪客的瀏覽器」直接向 `raw.githubusercontent.com` 抓的,和我們的主機無關;身高/屬性對照表已烘進 image,不打外部 API。
- **調整動畫參數**:`config.js` 烘在 image 裡,改參數需要重新 build。刻意不掛 volume——這站沒有主機端狀態,image 即全部,回滾 = 換 tag。
