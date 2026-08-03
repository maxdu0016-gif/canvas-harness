import type { CanvasStore } from '../store'
import type { EdgeId, NodeId } from '../types'
import {
  type DeserializeOptions,
  type SerializedClipboard,
  deserializeClipboard,
  isCanvasHarnessClipboard,
  serializeSelection,
} from './serialize'

export type {
  DeserializeOptions,
  SerializedClipboard,
} from './serialize'
export { deserializeClipboard, isCanvasHarnessClipboard, serializeSelection } from './serialize'

const MIME_NATIVE = 'application/x-canvas-harness+json'
const MIME_TEXT = 'text/plain'

// In-memory fallback clipboard. Guarantees intra-app copy/paste works
// even when the system clipboard is unavailable or blocked — e.g.
// WebKit (Safari / WKWebView), where the async `navigator.clipboard`
// read is restricted, or a denied permission. The system clipboard
// stays the primary channel (cross-app / cross-tab); this is the net.
let memoryClipboard: SerializedClipboard | null = null

const textFallback = (clip: SerializedClipboard): string =>
  clip.nodes
    .map(n => n.content ?? '')
    .filter(s => s.length > 0)
    .join('\n')

/**
 * Copies the current selection to the system clipboard. Writes both a
 * native MIME (`application/x-canvas-harness+json`) and a `text/plain`
 * fallback (concatenated node contents) so paste works in non-canvas
 * destinations too.
 *
 * The `<Canvas>` component already wires this to Cmd/Ctrl+C — call
 * directly only if you're building a custom copy button.
 *
 * @example
 * <button onClick={() => copy(store)}>Copy</button>
 */
export const copy = async (store: CanvasStore): Promise<SerializedClipboard> => {
  const clip = serializeSelection(store)
  memoryClipboard = clip
  await writeClipboard(clip)
  return clip
}

/**
 * Copy + remove the selection in one undoable batch. Same as
 * Cmd/Ctrl+X.
 *
 * @example
 * <button onClick={() => cut(store)}>Cut</button>
 */
export const cut = async (store: CanvasStore): Promise<SerializedClipboard> => {
  const clip = await copy(store)
  store.batch(() => {
    for (const n of clip.nodes) store.removeNode(n.id)
    for (const e of clip.edges) store.removeEdge(e.id)
  })
  return clip
}

/**
 * Paste from the system clipboard (or a supplied payload). Every node
 * + edge gets a fresh id; edge endpoints rewire to the new ids; the
 * resulting nodes + edges become the new selection. Wrapped in one
 * undoable batch.
 *
 * Positioning, in precedence order:
 *   1. `opts.offset` — relative offset, used as-is.
 *   2. `opts.at` — absolute target; the paste's bbox center lands here.
 *   3. The store's current cursor (`interactionState.pointer`) — the
 *      paste lands centered under the cursor. This is the default
 *      `paste(store)` behavior on a Cmd+V keybind.
 *   4. Fallback `(20, 20)` relative offset when nothing else is known
 *      (e.g. fresh session with no pointermove yet).
 *
 * Returns the new node ids on success, or `null` if the clipboard
 * didn't contain a canvas-harness payload.
 *
 * @example
 * <button onClick={() => paste(store)}>Paste</button>
 *
 * @example
 * // Programmatic paste at a specific world point:
 * paste(store, savedClip, { at: { x: 300, y: 200 }, select: false })
 */
export const paste = async (
  store: CanvasStore,
  payload?: SerializedClipboard,
  opts?: DeserializeOptions,
): Promise<(NodeId | EdgeId)[] | null> => {
  // System clipboard first (cross-app), then the in-memory fallback —
  // so intra-app paste still works when the system read is blocked.
  const clip = payload ?? (await readClipboard()) ?? memoryClipboard
  if (!clip) return null
  // Cursor-as-default: when the caller didn't specify positioning,
  // and the store has tracked the pointer at least once, paste at
  // the cursor's world position. deserializeClipboard handles the
  // bbox-center math.
  let effective = opts
  if (!opts?.offset && !opts?.at) {
    const pointer = store.getInteractionState().pointer
    if (pointer) {
      effective = { ...opts, at: { x: pointer.worldX, y: pointer.worldY } }
    }
  }
  const ids = deserializeClipboard(store, clip, effective)
  return ids
}

/**
 * Copy the current selection into a `DataTransfer` — the WebKit-safe
 * path, called from the DOM `copy`/`cut` events (which run inside the
 * user gesture and expose a synchronous `DataTransfer`, unlike the
 * restricted async `navigator.clipboard`). Also stashes an in-memory
 * copy so paste works even when the system clipboard drops our payload.
 *
 * `<Canvas>` wires this to Cmd/Ctrl+C. Call directly only for a custom
 * copy handler on a `copy`/`cut` event.
 */
export const writeSelectionToDataTransfer = (
  store: CanvasStore,
  data: DataTransfer,
): SerializedClipboard => {
  const clip = serializeSelection(store)
  memoryClipboard = clip
  const json = JSON.stringify(clip)
  try {
    // Some engines reject a custom MIME on DataTransfer; the JSON also
    // rides in `text/plain`, so a rejection here is non-fatal.
    data.setData(MIME_NATIVE, json)
  } catch {
    // Ignore — text/plain below carries the payload.
  }
  data.setData(MIME_TEXT, textFallback(clip) || json)
  return clip
}

/**
 * Read a canvas-harness payload from a `DataTransfer` (the DOM `paste`
 * event). Prefers the native MIME, then a JSON `text/plain` payload,
 * then the in-memory fallback (intra-app paste when the system
 * clipboard didn't carry our data). Returns null if none match.
 */
export const readClipboardFromDataTransfer = (data: DataTransfer): SerializedClipboard | null => {
  const native = data.getData(MIME_NATIVE)
  if (native) {
    try {
      const parsed = JSON.parse(native)
      if (isCanvasHarnessClipboard(parsed)) return parsed
    } catch {
      // Fall through to text/plain.
    }
  }
  const text = data.getData(MIME_TEXT)
  if (text?.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (isCanvasHarnessClipboard(parsed)) return parsed
    } catch {
      // Fall through to the in-memory fallback.
    }
  }
  return memoryClipboard
}

const writeClipboard = async (clip: SerializedClipboard): Promise<void> => {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  const json = JSON.stringify(clip)
  const text = textFallback(clip)
  // navigator.clipboard.write expects ClipboardItem; not all engines
  // support arbitrary mime types. We dual-write best-effort.
  type ClipboardItemCtor = new (data: Record<string, Blob>) => ClipboardItem
  const W = (globalThis as { ClipboardItem?: ClipboardItemCtor }).ClipboardItem
  if (W && navigator.clipboard.write) {
    try {
      const item = new W({
        [MIME_NATIVE]: new Blob([json], { type: MIME_NATIVE }),
        [MIME_TEXT]: new Blob([text], { type: MIME_TEXT }),
      })
      await navigator.clipboard.write([item])
      return
    } catch {
      // Fall through to text-only writeText.
    }
  }
  if (navigator.clipboard.writeText) await navigator.clipboard.writeText(json)
}

const readClipboard = async (): Promise<SerializedClipboard | null> => {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return null
  // Prefer the native MIME via clipboard.read; fall back to readText.
  if (navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (item.types.includes(MIME_NATIVE)) {
          const blob = await item.getType(MIME_NATIVE)
          const text = await blob.text()
          const parsed = JSON.parse(text)
          if (isCanvasHarnessClipboard(parsed)) return parsed
        }
      }
    } catch {
      // Fall through to readText.
    }
  }
  if (navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim().startsWith('{')) return null
      const parsed = JSON.parse(text)
      if (isCanvasHarnessClipboard(parsed)) return parsed
    } catch {
      return null
    }
  }
  return null
}
