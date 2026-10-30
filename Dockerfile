# 釘定版本而非浮動的 nginx:alpine：半年後重 build 也是同一顆 nginx，結果可重現
FROM nginx:1.29-alpine

# 快取策略、gzip 與即時天氣的代轉（內容見 nginx.conf 註解）。
# 放進 templates/ 而不是直接蓋 conf.d：啟動時 entrypoint 用 envsubst 把授權碼等
# 環境變數填進去才落地成 default.conf——image 裡不放任何機密，key 由 compose 的
# .env.secret 在執行期給（見 DEPLOY.md）
COPY nginx.conf /etc/nginx/templates/default.conf.template
# - LOCAL_RESOLVERS：讓 entrypoint 從 /etc/resolv.conf 讀出 DNS 位址給 resolver 用
#   （compose 的 docker network 是 127.0.0.11，本機 docker run 是主機的 DNS，不寫死）
# - ENVSUBST_FILTER：只換這幾個變數，nginx 自己的 $uri 之類原樣保留
# - CWA_STATION_ID：五股測站（興珍里所在的五股區只有這一站），換地點只要改環境變數
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER='^(CWA_|NGINX_LOCAL_RESOLVERS)' \
    CWA_STATION_ID=C0AI00
# 沒給授權碼（本機試跑、CI）也要讓 template 展得開：先補成空字串，nginx 見空就回 503，
# widget 退回擲骰。用 entrypoint 腳本補而不是 ENV 預設值：ENV 會把「放 key 的位置」
# 烘進 image 的設定裡，也會被 docker build 的機密檢查點名
RUN printf 'export CWA_API_KEY="${CWA_API_KEY:-}"\n' > /docker-entrypoint.d/19-cwa-key-default.envsh \
 && chmod +x /docker-entrypoint.d/19-cwa-key-default.envsh

# 純靜態站：widget 本體 + 設定/對照表 + js/ 主程式 + 給嵌入方看的互動參數文件
# + 展示著陸頁 + 指令橋接頁，README、截圖等不進 image
COPY pokemon_footer_widget.html config.js pokemon_heights.js pokemon_types.js pokemon_names.js pokemon_cameo.js params.html home.html bridge.html /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/

# 根路徑直接出 widget：iframe 嵌 https://<gateway>/poke-stroll/ 即可，
# 原檔名 /poke-stroll/pokemon_footer_widget.html 也同時保留可用。
# 注意：著陸頁（home.html）刻意「不」搶這個位置——已經上線的嵌入方與 OBS 來源
# 指的都是根路徑，換成一頁介紹文，人家的頁尾就變成一整頁店面了
RUN cp /usr/share/nginx/html/pokemon_footer_widget.html /usr/share/nginx/html/index.html

# 宣告服務埠：Traefik 的埠自動偵測與 docker ps 的可讀性都靠它
EXPOSE 80
