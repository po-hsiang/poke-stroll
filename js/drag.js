// ---------------------------------------------------------
// 滑鼠拖曳 (Drag)
// 三種按法各司其職，彼此不搶：
//   左鍵按本體  = 抓起來拖著走（按下的那一幀就跟手）
//   右鍵點本體  = 戳戳互動（跳一下 + 冒愛心）
//   左鍵點空白  = 丟一顆果實
// 抓取「沒有長按門檻」是刻意的：門檻期間身體不動、游標卻繼續走，
// 那段距離會被凍進偏移量裡，之後整段拖曳都差一截（0.30.0 的教訓）。
// 按下即抓，偏移量就是你按在身上的那一點，怎麼甩都跟手。
// 抓在手上的那隻等於暫時離場：不散步、不冒心情對話框、不寒暄、
// 戳不動，也不會被指派「新的」果實（canTakeBerry 一條規則管住三個入口）。
// 但追到一半的那顆不沒收：果實留在原地等牠，放手落地就回去續追——
// 代價是落地時依新的距離重擲賊鳥的骰，抓在手上的期間賊鳥也會
// 趁虛而入（細節見 release / beginSnatch / maybeMarkSnatch）。
// 游標拉出活動範圍時牠貼著邊界繼續掙扎，不會被拖出場外；
// 放開手就從當下高度自由落體回地面
// ---------------------------------------------------------
let dragTarget = null;    // 正被抓著的那一隻
let dragPointer = { x: 0, bottom: 0 }; // 游標位置（bottom 基準，與其他元素同座標系）
let swallowClick = false; // 拖曳結束後緊接著那一發 click 要吞掉

function trackPointer(e) {
    dragPointer = { x: e.clientX, bottom: window.innerHeight - e.clientY };
}

// 左鍵按在本體上：立刻抓起來
function beginDrag(p, e) {
    if ((CONFIG.drag ?? 'on') !== 'on') return;
    if ((e.button ?? 0) !== 0) return;         // 只認左鍵，右鍵留給戳戳互動
    if (dragTarget) return;                    // 一次只抓一隻（多指觸控時後來的那根不理）
    if (p.el.style.display === 'none') return; // 隱形的（載圖全滅）抓不到
    trackPointer(e);
    // 指標捕獲：游標滑出視窗外也還收得到後續事件，手不會莫名其妙鬆開
    p.el.setPointerCapture?.(e.pointerId);
    dragTarget = p;
    p.grab(dragPointer);
}

// 放開手（或事件被系統取消、視窗失焦）：抓著的那隻落地
function endDrag() {
    if (!dragTarget) return;
    dragTarget.release();
    dragTarget = null;
    swallowClick = true; // 放手那一下別又被解讀成丟果實
}

// 正被抓著的那隻被遙控 leave 送走時得先鬆手，
// 否則游標會繼續拖著一個已經從場上除名的元素
function releaseDrag(p) {
    if (dragTarget === p) {
        dragTarget.release();
        dragTarget = null;
    }
}

// 監聽掛在 document 上而不是每隻身上：游標移動速度快過重繪時會滑出本體，
// 掛在本體上就會中途斷線
document.addEventListener('pointermove', e => {
    trackPointer(e);
    dragTarget?.dragTo(dragPointer);
});
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
// 視窗失焦（Alt-Tab、切到 OBS 別的來源）：收不到 pointerup 的最後一道保險
window.addEventListener('blur', endDrag);
// 按下的那一刻先把「吞掉下一發 click」的旗子清乾淨：
// 上一輪若在視窗外放手、根本沒補那發 click，旗子不清會誤傷下一次點擊
document.addEventListener('pointerdown', () => { swallowClick = false; });
