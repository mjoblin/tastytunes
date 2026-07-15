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
export function scrollToWithContext(el: HTMLElement | null, gapPx = 8, context = 1): void {
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
    behavior: document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth'
  })
}
