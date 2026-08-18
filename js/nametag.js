// ---------------------------------------------------------
// 名牌 (Nametag)
// ---------------------------------------------------------
// 頭頂上的「No.25 皮卡丘」。少了這一塊，看到一隻很可愛的也問不出牠是誰——
// 認得出名字才有話題；編號則是給嵌入方看的，想把牠釘進陣容就是
// ?ids=25 的那個 25，滑鼠移上去就抄得到，不必回去翻圖鑑。
//
// 名字對照表在 pokemon_names.js（PokeAPI 的 zh-hant 官方譯名，1~1025）。
// 元素掛在 pokemon-container 裡（跟水面倒影同一套做法）：
// 位置、隱藏、移除都跟著本體走，不必另外照顧。
//
// 為什麼不做成像素字：對話框那些圖案是 canvas 一格一格畫出來的點陣圖，
// 那套做法要為每個字造字模——中文字沒辦法這樣搞。名牌因此走純文字排版，
// 靠深色藥丸底 + 淺色字維持辨識度（背景透明是這個 widget 的前提，
// 名字疊在誰家的網頁上都得看得清楚，所以底色不能省）。

// 圖鑑編號 → 顯示用的名字。查不到就退回「No.編號」，不開天窗
// （對照表沒載到、或哪天圖鑑又多了幾隻的情況）
function pokeName(id) {
    return window.POKE_NAMES?.[id] ?? `No.${id}`;
}

// 掛名牌。'off' 時連元素都不產生——OBS 掛整天，不必為關掉的功能付錢
function attachNametag(pokemon) {
    const mode = CONFIG.nametag ?? 'hover';
    if (mode === 'off') return;

    const tag = document.createElement('div');
    // on-hover：平常收著，滑鼠移到身上才浮出來（純 CSS，不吃每一幀）
    tag.className = 'nametag'
        + (mode === 'hover' ? ' on-hover' : '')
        + (pokemon.isShiny ? ' shiny' : ''); // 色違的名字用金色，跟星星特效同一組色
    // 字級不跟體型縮放：名字是拿來讀的，小隻的名字更小只會更難讀
    tag.style.fontSize = `${Math.min(Math.max(CONFIG.nametagSize ?? 11, 6), 40)}px`;

    // 編號與名字各自一個 span：編號壓暗一階退到後面，視線先落在名字上
    const dex = document.createElement('span');
    dex.className = 'dex';
    dex.textContent = `No.${pokemon.id}`;
    tag.appendChild(dex);
    const label = document.createElement('span');
    label.textContent = pokeName(pokemon.id);
    tag.appendChild(label);

    pokemon.nametag = tag;
    pokemon.el.appendChild(tag);
}
