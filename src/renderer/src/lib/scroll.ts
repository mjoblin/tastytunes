/**
 * Scroll the element's nearest scroll container so the element sits near the
 * top with one previous row visible above it for context — a "reading
 * position" that maximizes visibility of what comes next.
 */
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

export function scrollToWithContext(el: HTMLElement | null, gapPx = 8): void {
  if (!el) return
  const container = el.closest('.overflow-y-auto') as HTMLElement | null
  if (!container) return
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  // Only reserve room for the previous row when both rows actually fit in the
  // viewport; on very short windows the current row goes straight to the top.
  const bothRowsFit = 2 * eRect.height + gapPx <= container.clientHeight
  const contextOffset = bothRowsFit ? eRect.height + gapPx : 0
  container.scrollTo({
    top: container.scrollTop + (eRect.top - cRect.top) - contextOffset,
    behavior: 'smooth'
  })
}
