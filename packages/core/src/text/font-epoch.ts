/**
 * Font-load reactivity — ported from `canvas-lite-markdown.tsx`.
 *
 * Custom fonts (Architects Daughter, Inconsolata, etc.) load asynchronously
 * — `ctx.measureText` returns fallback metrics until they settle, which
 * means initial layouts would be wrong if we trusted them. The font-epoch
 * mechanism:
 *
 *   1. On first subscribe, attach listeners to document.fonts.ready and
 *      'loadingdone'.
 *   2. When fonts settle, bump an integer epoch and notify subscribers.
 *   3. Subscribers (measure cache clears itself; the renderer repaints).
 *      The bitmap cache keys on the epoch, so it invalidates implicitly.
 *   4. The renderer re-paints (one frame of "jump" as fonts settle, then
 *      stable forever).
 *
 * This module is a leaf event-emitter — it imports nothing from the rest
 * of the text pipeline, so subscribers (measure) depend on it rather than
 * the other way round (avoids an import cycle with the font registry).
 */
const fontEpochListeners = new Set<(epoch: number) => void>()
let fontEpoch = 0
let fontTrackingInitialized = false

const emitFontEpoch = (): void => {
  for (const listener of fontEpochListeners) listener(fontEpoch)
}

/**
 * Bumps the epoch and notifies subscribers. Called when web fonts settle
 * and by `configureFonts()`. The measure cache clears itself on this
 * signal; the bitmap cache keys on `getFontEpoch()` so it invalidates
 * implicitly.
 */
export const bumpFontEpoch = (): void => {
  fontEpoch += 1
  emitFontEpoch()
}

const initFontTracking = (): void => {
  if (fontTrackingInitialized) return
  // Don't latch when there's no document (Node / pre-hydration eval) — a
  // later call once the DOM exists must still get to attach the listeners.
  // Matters now that measure.ts subscribes at import time, not the
  // renderer at browser runtime.
  if (typeof document === 'undefined' || !('fonts' in document)) return
  fontTrackingInitialized = true

  const fontSet = document.fonts
  let didSettleInitialFonts = false

  fontSet.ready
    .then(() => {
      if (didSettleInitialFonts) return
      didSettleInitialFonts = true
      bumpFontEpoch()
    })
    .catch(() => {
      /* ignore */
    })

  fontSet.addEventListener?.('loadingdone', () => {
    if (!didSettleInitialFonts) didSettleInitialFonts = true
    bumpFontEpoch()
  })
}

/**
 * Subscribe to font-epoch bumps. Lazy-initializes the document.fonts
 * listeners on first call. Returns an unsubscribe.
 */
export const subscribeFontEpoch = (listener: (epoch: number) => void): (() => void) => {
  initFontTracking()
  fontEpochListeners.add(listener)
  return () => {
    fontEpochListeners.delete(listener)
  }
}

/**
 * Current epoch — included in bitmap-cache keys so they invalidate when
 * custom fonts settle.
 */
export const getFontEpoch = (): number => fontEpoch
