/**
 * Browser-mode tests for WebKit trackpad pinch-zoom.
 *
 * WebKit (Safari / WKWebView) encodes a trackpad pinch as
 * `gesturestart`/`gesturechange`/`gestureend` (GestureEvent with a
 * cumulative `scale`) and does NOT emit the `ctrlKey` wheel that
 * Chromium does — so `usePanZoom` handles those gesture events
 * directly. Chromium (what this browser suite runs in) never fires
 * GestureEvent natively, but the handlers are wired via
 * `addEventListener('gesture*')`, so we drive them with synthetic
 * events. This validates the handler math + wiring, not real Safari
 * behaviour (that needs a manual Safari pass).
 *
 * Strategy: mount <Canvas tool="select">, dispatch a
 * gesturestart → gesturechange sequence on the canvas host, flush the
 * rAF the zoom is coalesced through, then read camera from the store.
 */
import { type CanvasStore, asClientId, createCanvasStore } from '@canvas-harness/core'
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'vitest'
import { Canvas, CanvasProvider } from '../src'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT_W = 800
const VIEWPORT_H = 600

const mountCanvas = async (store: CanvasStore) => {
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '0px'
  container.style.top = '0px'
  container.style.width = `${VIEWPORT_W}px`
  container.style.height = `${VIEWPORT_H}px`
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <StrictMode>
        <CanvasProvider store={store}>
          <Canvas tool="select" />
        </CanvasProvider>
      </StrictMode>,
    )
  })
  // Yield so child effects (renderer mount, pan-zoom listeners) attach.
  await new Promise(resolve => setTimeout(resolve, 0))
  const wrap = container.querySelector('[data-canvas-host]') as HTMLDivElement
  if (!wrap) throw new Error('canvas host not found')
  return {
    wrap,
    cleanup: () => act(async () => root.unmount()).then(() => container.remove()),
  }
}

/** Build a synthetic WebKit GestureEvent (jsdom/chromium have no ctor). */
const gestureEvent = (
  type: 'gesturestart' | 'gesturechange' | 'gestureend',
  scale: number,
  client: { x: number; y: number },
): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { scale, clientX: client.x, clientY: client.y })
  return e
}

/** Waits two rAF ticks so the coalesced zoom flush has definitely run. */
const nextFrames = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

describe('WebKit pinch-zoom (gesture events)', () => {
  test('gesturechange with scale > 1 zooms in toward the anchor', async () => {
    const store = createCanvasStore({ clientId: asClientId('test') })
    const m = await mountCanvas(store)
    const rect = m.wrap.getBoundingClientRect()
    const anchor = { x: rect.left + 200, y: rect.top + 150 }
    const startZoom = store.getCamera().z

    await act(async () => {
      m.wrap.dispatchEvent(gestureEvent('gesturestart', 1, anchor))
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.5, anchor))
    })
    await act(async () => {
      await nextFrames()
    })

    // scale 1 → 1.5 is a 1.5x zoom (within the per-frame clamp of 2x).
    expect(store.getCamera().z).toBeCloseTo(startZoom * 1.5, 5)
    await m.cleanup()
  })

  test('scale is treated as cumulative, not per-event (no double-apply)', async () => {
    const store = createCanvasStore({ clientId: asClientId('test') })
    const m = await mountCanvas(store)
    const rect = m.wrap.getBoundingClientRect()
    const anchor = { x: rect.left + 400, y: rect.top + 300 }
    const startZoom = store.getCamera().z

    // Two ticks of the SAME gesture: cumulative scale 1 → 1.2 → 1.44.
    // Net zoom must be 1.44x, not 1.2 * 1.44 (which is what applying
    // `scale` raw each tick would produce).
    await act(async () => {
      m.wrap.dispatchEvent(gestureEvent('gesturestart', 1, anchor))
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.2, anchor))
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.44, anchor))
      m.wrap.dispatchEvent(gestureEvent('gestureend', 1.44, anchor))
    })
    await act(async () => {
      await nextFrames()
    })

    expect(store.getCamera().z).toBeCloseTo(startZoom * 1.44, 5)
    await m.cleanup()
  })

  test('pinch enters the "zooming" interaction mode (drives motion LOD)', async () => {
    const store = createCanvasStore({ clientId: asClientId('test') })
    const m = await mountCanvas(store)
    const rect = m.wrap.getBoundingClientRect()
    const anchor = { x: rect.left + 100, y: rect.top + 100 }

    await act(async () => {
      m.wrap.dispatchEvent(gestureEvent('gesturestart', 1, anchor))
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.3, anchor))
    })
    await act(async () => {
      await nextFrames()
    })
    expect(store.getInteractionState().mode).toBe('zooming')
    await m.cleanup()
  })

  test('gesture events defer to the touch-pinch path when two touches are active', async () => {
    // iOS / iPadOS fire GestureEvents AND touch pointers for the same
    // pinch. With two touches down, the gesture path must NOT also apply
    // zoom (the pointer pinch path owns it) — otherwise zoom double-applies.
    const store = createCanvasStore({ clientId: asClientId('test') })
    const m = await mountCanvas(store)
    const rect = m.wrap.getBoundingClientRect()
    const anchor = { x: rect.left + 200, y: rect.top + 150 }
    const startZoom = store.getCamera().z

    // Synthetic pointers aren't real active pointers, so the hook's
    // setPointerCapture (fired when the 2nd touch lands) would throw.
    // Stub the capture API — irrelevant to what this test asserts.
    m.wrap.setPointerCapture = () => {}
    m.wrap.releasePointerCapture = () => {}
    m.wrap.hasPointerCapture = () => false

    const touchDown = (pointerId: number, x: number) =>
      m.wrap.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          pointerId,
          clientX: rect.left + x,
          clientY: rect.top + 150,
          bubbles: true,
          cancelable: true,
        }),
      )

    await act(async () => {
      touchDown(1, 180)
      touchDown(2, 220) // activeTouches.size === 2 → touch pinch owns zoom
      m.wrap.dispatchEvent(gestureEvent('gesturestart', 1, anchor))
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.5, anchor))
    })
    await act(async () => {
      await nextFrames()
    })

    // No touch *move* happened, so the pointer path zoomed 0; the gesture
    // path must have deferred → camera unchanged (no double-apply).
    expect(store.getCamera().z).toBeCloseTo(startZoom, 5)
    await m.cleanup()
  })

  test('a gesturechange with no preceding gesturestart seeds the base without jumping', async () => {
    // If gesturestart is missed/bailed, the first change must only seed
    // the cumulative-scale base (no zoom), so a stale base can't snap the
    // camera. The next change then derives a clean factor from that seed.
    const store = createCanvasStore({ clientId: asClientId('test') })
    const m = await mountCanvas(store)
    const rect = m.wrap.getBoundingClientRect()
    const anchor = { x: rect.left + 300, y: rect.top + 200 }
    const startZoom = store.getCamera().z

    await act(async () => {
      // No gesturestart. First change (scale 1.5) seeds base = 1.5.
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.5, anchor))
    })
    await act(async () => {
      await nextFrames()
    })
    expect(store.getCamera().z).toBeCloseTo(startZoom, 5) // seeded, not jumped

    await act(async () => {
      // Second change (scale 1.8) → factor 1.8 / 1.5 = 1.2.
      m.wrap.dispatchEvent(gestureEvent('gesturechange', 1.8, anchor))
    })
    await act(async () => {
      await nextFrames()
    })
    expect(store.getCamera().z).toBeCloseTo(startZoom * 1.2, 5)
    await m.cleanup()
  })
})
