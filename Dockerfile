# 釘定版本而非浮動的 nginx:alpine：半年後重 build 也是同一顆 nginx，結果可重現
FROM nginx:1.29-alpine

# 快取策略與 gzip（覆蓋 image 內建的 default.conf，內容見 nginx.conf 註解）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 純靜態站：只搬 widget 執行需要的四個檔案，README、截圖等不進 image
COPY pokemon_footer_widget.html config.js pokemon_heights.js pokemon_types.js /usr/share/nginx/html/

# 根路徑直接出 widget：iframe 嵌 https://<gateway>/poke-stroll/ 即可，
# 原檔名 /poke-stroll/pokemon_footer_widget.html 也同時保留可用
RUN cp /usr/share/nginx/html/pokemon_footer_widget.html /usr/share/nginx/html/index.html

# 宣告服務埠：Traefik 的埠自動偵測與 docker ps 的可讀性都靠它
EXPOSE 80
