/**
 * Browser-mode tests for the DOM clipboard-event path (copy / cut /
 * paste). The library moved off keydown + async navigator.clipboard —
 * which WebKit (Safari / WKWebView) silently blocks — onto the DOM
 * clipboard events (synchronous DataTransfer inside the user gesture),
 * with a per-store in-memory fallback used ONLY when the transfer is
 * empty (a WKWebView quirk) so it never hijacks an external paste.
 *
 * Two layers are covered:
 *   1. The core DataTransfer helpers, called directly.
 *   2. The <Canvas> event wiring, via observable store effects.
 * Note: a *synthetic* ClipboardEvent in chromium doesn't reflect writes
 * made inside the handler back to the DataTransfer we pass in, so the
 * write path is asserted through the helper (1) and the empty-transfer
 * fallback (2), not by reading a dispatched event's DataTransfer.
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
    // JSON rides in text/plain so intra-app paste round-trips in WebKit.
    expect(JSON.parse(dt.getData('text/plain')).kind).toBe('canvas-harness/clipboard')

    const read = readClipboardFromDataTransfer(store, dt)
    expect(read?.nodes).toHaveLength(1)
    expect(read?.nodes[0]?.content).toBe('hello')
  })

  test('an EMPTY transfer falls back to this store’s in-memory clipboard', () => {
    const store = setupStore()
    store.setSelection([asNodeId('n1')])
    writeSelectionToDataTransfer(store, new DataTransfer()) // seeds memory
    const read = readClipboardFromDataTransfer(store, new DataTransfer())
    expect(read?.nodes[0]?.content).toBe('hello')
  })

  test('external plain text is NOT hijacked by a prior copy', () => {
    const store = setupStore()
    store.setSelection([asNodeId('n1')])
    writeSelectionToDataTransfer(store, new DataTransfer()) // seeds memory
    const external = new DataTransfer()
    external.setData('text/plain', 'copied from another app')
    // Transfer holds real (non-canvas) content → must not return memory.
    expect(readClipboardFromDataTransfer(store, external)).toBeNull()
  })

  test('foreign JSON is not treated as a canvas payload', () => {
    const store = setupStore()
    store.setSelection([asNodeId('n1')])
    writeSelectionToDataTransfer(store, new DataTransfer()) // seeds memory
    const external = new DataTransfer()
    external.setData('text/plain', '{"foo":1}')
    expect(readClipboardFromDataTransfer(store, external)).toBeNull()
  })

  test('the in-memory fallback is per-store (no cross-canvas bleed)', () => {
    const a = setupStore()
    a.setSelection([asNodeId('n1')])
    const b = setupStore()
    writeSelectionToDataTransfer(a, new DataTransfer()) // seeds A only
    // B never copied → an empty transfer yields nothing (not A's node).
    expect(readClipboardFromDataTransfer(b, new DataTransfer())).toBeNull()
    expect(readClipboardFromDataTransfer(a, new DataTransfer())?.nodes).toHaveLength(1)
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
