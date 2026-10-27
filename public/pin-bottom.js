/**
 * 卡片钉底控制器（设计语言统一：文章左栏 / 动态表单卡 / 时间线表单卡同款）：
 * - 卡片随页面滚动；底部到达视口底时 translateY 钉住（后续内容继续滚）
 * - 位移上限 = 参照容器高 - 卡片高（滚到页尾随内容离开，不悬空）
 * - Chrome 系 grid/flex item 的 sticky bottom 不生效（已知 bug），故 JS 实现
 * - 单列布局（≤960px，含移动端）：卡片与正文同列，钉住会遮正文——禁用
 */
import { qs } from "./utils.js";

export function setupCardPinBottom(cardSel, boundSel) {
  const card = qs(cardSel);
  const bound = qs(boundSel);
  if (!card || !bound) return;

  const singleCol = () => window.matchMedia("(max-width: 960px)").matches;

  let raf = null;
  const update = () => {
    raf = null;
    if (singleCol()) {
      card.style.transform = "";
      card.classList.remove("pin-bottom");
      return;
    }
    const vh = window.innerHeight;
    const dyMax = bound.offsetHeight - card.offsetHeight;
    if (dyMax <= 0) {
      card.style.transform = "";
      card.classList.remove("pin-bottom");
      return;
    }
    const naturalBottom = card.offsetTop + card.offsetHeight;
    const dy = Math.max(0, Math.min(window.scrollY + vh - naturalBottom, dyMax));
    if (dy > 0) {
      card.classList.add("pin-bottom");
      card.style.transform = `translateY(${dy}px)`;
    } else {
      card.classList.remove("pin-bottom");
      card.style.transform = "";
    }
  };
  const onScroll = () => {
    if (raf == null) raf = requestAnimationFrame(update);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();

  const teardown = () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    if (raf != null) cancelAnimationFrame(raf);
    card.style.transform = "";
    card.classList.remove("pin-bottom");
  };
  for (const sel of ["#btn-back", "#btn-save-post", "#btn-save-moment", "#btn-save-timeline",
    "#btn-delete-post", "#btn-delete-moment", "#btn-delete-timeline"]) {
    qs(sel)?.addEventListener("click", teardown, { once: true });
  }
  const mo = new MutationObserver(() => {
    if (!card.isConnected) {
      mo.disconnect();
      teardown();
    }
  });
  mo.observe(document.getElementById("main"), { childList: true, subtree: true });
}
