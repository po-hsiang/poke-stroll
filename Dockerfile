FROM nginx:alpine

# 純靜態站：只搬 widget 執行需要的四個檔案，README、截圖等不進 image
COPY pokemon_footer_widget.html config.js pokemon_heights.js pokemon_types.js /usr/share/nginx/html/

# 根路徑直接出 widget：iframe 嵌 https://<gateway>/poke-stroll/ 即可，
# 原檔名 /poke-stroll/pokemon_footer_widget.html 也同時保留可用
RUN cp /usr/share/nginx/html/pokemon_footer_widget.html /usr/share/nginx/html/index.html
