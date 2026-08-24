import { getStroke } from 'perfect-freehand'
import { worldToNodeLocal } from '../edges'
import type { Node, Vec2 } from '../types'
import type { InkGeometry, InkNodeData, InkSample, InkStrokeData } from './types'

const MIN_NODE_SIZE = 1

/** Fill sparse browser samples so fast stylus motion stays visually continuous. */
export const interpolateInkSamples = (
  from: InkSample,
  to: InkSample,
  maxSpacing: number,
): InkSample[] => {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.min(64, Math.max(1, Math.ceil(distance / Math.max(0.1, maxSpacing))))
  const result: InkSample[] = []
  for (let step = 1; step <= steps; step++) {
    const t = step / steps
    result.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      pressure: from.pressure + (to.pressure - from.pressure) * t,
    })
  }
  return result
}

/** Trace a closed outline with midpoint quadratic curves instead of visible segments. */
export const traceSmoothInkOutline = (
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<readonly [number, number]>,
): void => {
  const first = points[0]
  if (!first) return
  if (points.length < 3) {
    ctx.moveTo(first[0], first[1])
    for (let i = 1; i < points.length; i++) {
      const point = points[i]
      if (point) ctx.lineTo(point[0], point[1])
    }
    return
  }

  const second = points[1]!
  ctx.moveTo((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
  for (let i = 1; i <= points.length; i++) {
    const control = points[i % points.length]!
    const next = points[(i + 1) % points.length]!
    ctx.quadraticCurveTo(
      control[0],
      control[1],
      (control[0] + next[0]) / 2,
      (control[1] + next[1]) / 2,
    )
  }
  ctx.closePath()
}

/** Produce a pressure-aware polygon for one freehand stroke. */
export const buildInkOutline = (
  samples: ReadonlyArray<InkSample>,
  size: number,
): Array<[number, number]> => {
  if (samples.length === 0) return []
  return getStroke(
    samples.map(point => [point.x, point.y, point.pressure]),
    {
      size,
      thinning: 0.68,
      smoothing: 0.58,
      streamline: 0.42,
      simulatePressure: false,
      last: true,
    },
  ).map(([x, y]) => [x, y])
}

/**
 * Normalize a completed world-space trace into local points plus bounds.
 * The derived outline is deliberately not persisted; renderers rebuild it
 * from `points + size` so synced scenes stay compact.
 */
export const createInkGeometry = (
  samples: ReadonlyArray<InkSample>,
  size: number,
): InkGeometry | null => {
  const outline = buildInkOutline(samples, size)
  if (outline.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of outline) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const w = Math.max(MIN_NODE_SIZE, maxX - minX)
  const h = Math.max(MIN_NODE_SIZE, maxY - minY)
  return {
    x: minX,
    y: minY,
    w,
    h,
    ink: {
      type: 'ink',
      version: 1,
      size,
      points: samples.map(({ x, y, pressure }) => [x - minX, y - minY, pressure]),
      intrinsicWidth: w,
      intrinsicHeight: h,
    },
  }
}

/** Read validated engine geometry from a built-in ink node. */
export const readInkData = (node: Node): InkStrokeData | null => {
  if (node.type !== 'ink' || !node.data || typeof node.data !== 'object') return null
  const raw = (node.data as Partial<InkNodeData>).ink
  if (
    !raw ||
    raw.type !== 'ink' ||
    raw.version !== 1 ||
    !Number.isFinite(raw.size) ||
    raw.size <= 0 ||
    !Array.isArray(raw.points) ||
    !raw.points.every(
      point =>
        Array.isArray(point) && point.length === 3 && point.every(value => Number.isFinite(value)),
    ) ||
    !Number.isFinite(raw.intrinsicWidth) ||
    raw.intrinsicWidth <= 0 ||
    !Number.isFinite(raw.intrinsicHeight) ||
    raw.intrinsicHeight <= 0
  ) {
    return null
  }
  return raw
}

const outlineCache = new WeakMap<InkStrokeData, Array<[number, number]>>()

const outlineFromInk = (ink: InkStrokeData): Array<[number, number]> => {
  const cached = outlineCache.get(ink)
  if (cached) return cached
  const outline = buildInkOutline(
    ink.points.map(([x, y, pressure]) => ({ x, y, pressure })),
    ink.size,
  )
  outlineCache.set(ink, outline)
  return outline
}

/** Paint a committed ink node in node-local space. */
export const drawInkNode = (ctx: CanvasRenderingContext2D, node: Node): void => {
  const ink = readInkData(node)
  if (!ink) return
  const outline = outlineFromInk(ink)
  if (outline.length === 0) return
  const scaleX = node.w / Math.max(MIN_NODE_SIZE, ink.intrinsicWidth)
  const scaleY = node.h / Math.max(MIN_NODE_SIZE, ink.intrinsicHeight)
  ctx.save()
  ctx.scale(scaleX, scaleY)
  ctx.fillStyle = node.style?.strokeColor ?? '#1f2937'
  ctx.globalAlpha = Math.max(0, Math.min(1, (node.style?.opacity ?? 100) / 100))
  ctx.beginPath()
  traceSmoothInkOutline(ctx, outline)
  ctx.fill()
  ctx.restore()
}

/** Paint a world-space in-progress stroke on the renderer's interactive surface. */
export const drawInkDraft = (
  ctx: CanvasRenderingContext2D,
  samples: ReadonlyArray<InkSample>,
  size: number,
  color: string,
  opacity = 100,
): void => {
  const outline = buildInkOutline(samples, size)
  if (outline.length === 0) return
  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity / 100))
  ctx.beginPath()
  traceSmoothInkOutline(ctx, outline)
  ctx.fill()
  ctx.restore()
}

export const distanceToSegment = (point: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** Pressure-centerline hit test used by selection and whole-stroke erasing. */
export const hitTestInkLocal = (node: Node, localPoint: Vec2, extraRadius = 0): boolean => {
  const ink = readInkData(node)
  if (!ink || ink.points.length === 0 || node.w <= 0 || node.h <= 0) return false
  if (
    localPoint.x < -extraRadius ||
    localPoint.y < -extraRadius ||
    localPoint.x > node.w + extraRadius ||
    localPoint.y > node.h + extraRadius
  ) {
    return false
  }

  const scaleX = node.w / Math.max(MIN_NODE_SIZE, ink.intrinsicWidth)
  const scaleY = node.h / Math.max(MIN_NODE_SIZE, ink.intrinsicHeight)
  const intrinsicPoint = { x: localPoint.x / scaleX, y: localPoint.y / scaleY }
  const intrinsicExtra = extraRadius / Math.max(MIN_NODE_SIZE, Math.min(scaleX, scaleY))
  const radius = ink.size / 2 + intrinsicExtra + 2
  const first = ink.points[0]
  if (!first) return false
  if (ink.points.length === 1) {
    return Math.hypot(intrinsicPoint.x - first[0], intrinsicPoint.y - first[1]) <= radius
  }

  for (let i = 1; i < ink.points.length; i++) {
    const previous = ink.points[i - 1]
    const current = ink.points[i]
    if (!previous || !current) continue
    const a = { x: previous[0], y: previous[1] }
    const b = { x: current[0], y: current[1] }
    if (distanceToSegment(intrinsicPoint, a, b) <= radius) return true
  }
  return false
}

/** Hit-test one world point against a rotated/scaled ink node. */
export const hitTestInkWorld = (node: Node, worldPoint: Vec2, extraRadius = 0): boolean =>
  hitTestInkLocal(node, worldToNodeLocal(worldPoint, node), extraRadius)
