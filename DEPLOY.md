# 部署指南(容器化 / GCP + Traefik)

純靜態站(nginx:alpine),無後端、無資料庫、無環境機密。`.env` 直接進版控,主機上 `git pull` 即用。

## 本機建置與測試

```bash
# 建置(版本號與 .env 的 VERSION 一致)
docker build -t asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.6.0 .

# 本機試跑
docker run --rm -p 8080:80 asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.6.0
# 瀏覽器 / OBS 瀏覽器來源開 http://localhost:8080/ 即可看到 widget
```

## 推上 Google Artifact Registry

```bash
docker push asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.6.0
```

## 雲端主機部署

```bash
docker pull asia-east1-docker.pkg.dev/blue-whale-408802/bluewhale-engine/poke-stroll:0.6.0
docker compose up -d
```

改版時:改 `.env` 的 `VERSION` → 重新 build/push/pull → `docker compose up -d` 換新容器。

## 部署後的網址

| 用途 | 網址 |
|------|------|
| 直接觀看 / iframe 嵌入 | `https://rd7-ai-gw-02.i17game.net/poke-stroll/` |
| 完整檔名(等價) | `https://rd7-ai-gw-02.i17game.net/poke-stroll/pokemon_footer_widget.html` |

## 同仁 iframe 嵌入範例

```html
<iframe src="https://rd7-ai-gw-02.i17game.net/poke-stroll/"
        style="position:fixed; bottom:0; left:0; width:100%; height:200px;
               border:none; pointer-events:none;"></iframe>
```

想要不同的生成數量、體型、固定陣容?在網址後掛 query string 即可,例如
`/poke-stroll/?count=5&ids=25,133,6`,各專案互不影響。完整參數見 [PARAMS.md](PARAMS.md)。

## 設計筆記(為什麼這樣設)

- **不發佈 ports**:Traefik 與容器同在 `ipa_service_net`,從 docker network 內直達容器的 80,不需要把埠發佈到主機——發佈出去等於多一條繞過閘道的直連通道。本機測試走 `docker run -p 8080:80`(見上方指令),完全不經 compose,不受影響。
- **尾斜線 301**:compose 裡多一組 `redirectregex` middleware,把 `/poke-stroll`(無尾斜線)導向 `/poke-stroll/`。頁面內 `./config.js` 等相對路徑以「目錄」為基準,少了尾斜線資源會被瀏覽器解析到網站根路徑而 404。API 服務不在乎這個,靜態頁必須處理。
- **可嵌入性**:nginx 預設不送 `X-Frame-Options` / `frame-ancestors`,任何網站都能 iframe。若日後要限制,再加 header 白名單即可。
- **寶可夢圖片來源**:sprite 是「訪客的瀏覽器」直接向 `raw.githubusercontent.com` 抓的,和我們的主機無關;身高/屬性對照表已烘進 image,不打外部 API。
- **調整動畫參數**:`config.js` 烘在 image 裡,改參數需要重新 build。刻意不掛 volume——這站沒有主機端狀態,image 即全部,回滾 = 換 tag。
