/**
 * Brief gold outline pulse on the scroll target — click feedback for the
 * scroll-to-current buttons even when nothing needed to move.
 */
export function flashTarget(el: HTMLElement | null): void {
  if (!el) return
  el.classList.remove('target-flash')
  // restart the animation if it's already running
  void el.offsetWidth
  el.classList.add('target-flash')
  setTimeout(() => el.classList.remove('target-flash'), 900)
}

/**
 * Scroll the element's nearest scroll container so the element sits near the
 * top with the previous item visible above it for context — a "reading
 * position" that maximizes visibility of what comes next. `context` scales how
 * much of that previous item to reserve: 1 (a full row) for lists, 0.5 for
 * card grids, where a whole card of context pushes the target too far down.
 */
export function scrollToWithContext(
  el: HTMLElement | null,
  gapPx = 8,
  context = 1,
  behavior?: ScrollBehavior
): void {
  if (!el) return
  const container = el.closest('.overflow-y-auto') as HTMLElement | null
  if (!container) return
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  // Only reserve the context room when it actually fits in the viewport; on
  // very short windows the current item goes straight to the top.
  const fits = (1 + context) * eRect.height + gapPx <= container.clientHeight
  const contextOffset = fits ? context * eRect.height + gapPx : 0
  container.scrollTo({
    top: container.scrollTop + (eRect.top - cRect.top) - contextOffset,
    // jump instantly under reduced motion (settings.motion resolved on :root)
    behavior:
      behavior ??
      (document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth')
  })
}

/**
 * Center the element within its nearest scroll container — and ONLY that
 * container. Never reach for element.scrollIntoView here: it scrolls every
 * scrollable ancestor including the window (overflow:hidden merely hides
 * scrollbars — programmatic scrolling still works), so any stray document
 * overflow would let a follow-scroll displace the entire app with no way for
 * the user to scroll it back.
 */
export function scrollToCentered(el: HTMLElement | null, behavior?: ScrollBehavior): void {
  if (!el) return
  const container = el.closest('.overflow-y-auto') as HTMLElement | null
  if (!container) return
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  container.scrollTo({
    top: container.scrollTop + (eRect.top - cRect.top) - (cRect.height - eRect.height) / 2,
    behavior:
      behavior ??
      (document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth')
  })
}

/**
 * Keep the element visible in its nearest scroll container, nudging by the
 * smallest amount (the container-scoped equivalent of scrollIntoView's
 * block: 'nearest' — see scrollToCentered for why scrollIntoView is banned).
 */
export function scrollToVisible(el: HTMLElement | null, pad = 0): void {
  if (!el) return
  const container = el.closest('.overflow-y-auto') as HTMLElement | null
  if (!container) return
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  // `pad` is breathing room past the element's border box. Rings and glows
  // are box-shadows OUTSIDE that box, so a flush alignment scrolls the row
  // in and clips its gold ring at the scrollport edge — shipped visibly on
  // the tray panel's followed queue (user, 2026-08-04). Callers whose rows
  // wear rings pass the pad; the default keeps everyone else exact.
  if (eRect.top < cRect.top + pad) container.scrollTop += eRect.top - cRect.top - pad
  else if (eRect.bottom > cRect.bottom - pad) container.scrollTop += eRect.bottom - cRect.bottom + pad
}
