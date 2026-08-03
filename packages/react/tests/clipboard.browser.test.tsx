/**
 * Browser-mode tests for the DOM clipboard-event path (copy / cut /
 * paste). The library moved off keydown + async navigator.clipboard —
 * which WebKit (Safari / WKWebView) silently blocks — onto the DOM
 * clipboard events (synchronous DataTransfer inside the user gesture)
 * plus an in-memory fallback so intra-app paste survives even when the
 * system clipboard drops our payload.
 *
 * Two layers are covered:
 *   1. The core DataTransfer helpers, called directly (round-trip).
 *   2. The <Canvas> event wiring, via observable store effects.
 * Note: a *synthetic* ClipboardEvent in chromium doesn't reflect writes
 * made inside the handler back to the DataTransfer we pass in, so the
 * write path is asserted through the helper (1) and the memory-fallback
 * paste (2), not by reading a dispatched event's DataTransfer.
 */
import {
  type CanvasStore,
  asClientId,
  asNodeId,
  createCanvasStore,
  readClipboardFromDataTransfer,
  writeSelectionToDataTransfer,
} from '@canvas-harness/core'
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'vitest'
import { Canvas, CanvasProvider } from '../src'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setupStore = (): CanvasStore => {
  const store = createCanvasStore({ clientId: asClientId('test') })
  store.addNode({
    id: asNodeId('n1'),
    type: 'rect',
    x: 100,
    y: 100,
    w: 80,
    h: 60,
    angle: 0,
    z: 0,
    groups: [],
    content: 'hello',
  })
  return store
}

const mountCanvas = async (store: CanvasStore) => {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px'
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
  await new Promise(resolve => setTimeout(resolve, 0))
  const wrap = container.querySelector('[data-canvas-host]') as HTMLDivElement
  if (!wrap) throw new Error('canvas host not found')
  return {
    wrap,
    cleanup: () => act(async () => root.unmount()).then(() => container.remove()),
  }
}

const clipboardEvent = (type: 'copy' | 'cut' | 'paste'): ClipboardEvent =>
  new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })

describe('DataTransfer helpers (engine-agnostic clipboard I/O)', () => {
  test('write then read round-trips the selection', () => {
    const store = setupStore()
    store.setSelection([asNodeId('n1')])
    const dt = new DataTransfer()

    const written = writeSelectionToDataTransfer(store, dt)
    expect(written.nodes).toHaveLength(1)
    // text/plain carries human-readable node text (for pasting into
    // non-canvas apps); the JSON payload rides in the custom MIME.
    expect(dt.getData('text/plain')).toBe('hello')

    // Round-trips back to a full clip (via the custom MIME where the
    // engine keeps it, else the in-memory fallback the write just seeded).
    const read = readClipboardFromDataTransfer(dt)
    expect(read?.nodes).toHaveLength(1)
    expect(read?.nodes[0]?.content).toBe('hello')
  })

  test('read falls back to the in-memory clipboard on an empty transfer', () => {
    const store = setupStore()
    store.setSelection([asNodeId('n1')])
    writeSelectionToDataTransfer(store, new DataTransfer()) // seeds memory
    // A later paste whose transfer carries nothing (the WKWebView case).
    const read = readClipboardFromDataTransfer(new DataTransfer())
    expect(read?.nodes[0]?.content).toBe('hello')
  })
})

describe('<Canvas> clipboard event wiring', () => {
  test('copy then paste re-creates the node with a fresh id', async () => {
    const store = setupStore()
    const m = await mountCanvas(store)
    store.setSelection([asNodeId('n1')])

    await act(async () => {
      m.wrap.dispatchEvent(clipboardEvent('copy'))
    })
    expect(store.getAllNodes()).toHaveLength(1)

    await act(async () => {
      m.wrap.dispatchEvent(clipboardEvent('paste'))
    })
    const nodes = store.getAllNodes()
    expect(nodes).toHaveLength(2)
    expect(nodes.filter(n => n.id === 'n1')).toHaveLength(1) // original kept
    expect(nodes.some(n => n.id !== 'n1' && n.content === 'hello')).toBe(true) // fresh id
    await m.cleanup()
  })

  test('cut removes the selection, and it pastes back', async () => {
    const store = setupStore()
    const m = await mountCanvas(store)
    store.setSelection([asNodeId('n1')])

    await act(async () => {
      m.wrap.dispatchEvent(clipboardEvent('cut'))
    })
    expect(store.getAllNodes()).toHaveLength(0)

    await act(async () => {
      m.wrap.dispatchEvent(clipboardEvent('paste'))
    })
    expect(store.getAllNodes()).toHaveLength(1)
    await m.cleanup()
  })
})
