import { describe, expect, test } from 'vitest'
import { createInkGeometry, hitTestInkWorld, interpolateInkSamples, readInkData } from '../src/ink'
import { type Node, asNodeId } from '../src/types'

describe('ink geometry', () => {
  test('interpolates sparse input without gaps and preserves pressure', () => {
    const samples = interpolateInkSamples(
      { x: 0, y: 0, pressure: 0.2 },
      { x: 10, y: 0, pressure: 0.8 },
      2,
    )

    expect(samples).toHaveLength(5)
    expect(samples[0]).toMatchObject({ x: 2, y: 0 })
    expect(samples[0]!.pressure).toBeCloseTo(0.32)
    expect(samples.at(-1)).toEqual({ x: 10, y: 0, pressure: 0.8 })
  })

  test('stores only points + size and derives a compact local geometry', () => {
    const geometry = createInkGeometry(
      [
        { x: 20, y: 30, pressure: 0.25 },
        { x: 40, y: 45, pressure: 0.75 },
      ],
      6,
    )

    expect(geometry).not.toBeNull()
    expect(geometry!.w).toBeGreaterThan(0)
    expect(geometry!.h).toBeGreaterThan(0)
    expect(geometry!.ink.points).toHaveLength(2)
    expect(geometry!.ink).not.toHaveProperty('outline')
  })

  test('reads canonical ink data and rejects malformed points', () => {
    const geometry = createInkGeometry([{ x: 10, y: 10, pressure: 0.5 }], 4)!
    const node = makeNode(geometry)
    expect(readInkData(node)).toBe(geometry.ink)

    const malformed: Node = {
      ...node,
      data: { ink: { ...geometry.ink, points: [[Number.NaN, 0, 0.5]] } },
    }
    expect(readInkData(malformed)).toBeNull()
  })

  test('hit-tests the pressure centerline instead of the full node bounds', () => {
    const geometry = createInkGeometry(
      [
        { x: 10, y: 20, pressure: 0.5 },
        { x: 50, y: 20, pressure: 0.5 },
      ],
      4,
    )!
    const node = makeNode(geometry)

    expect(hitTestInkWorld(node, { x: 30, y: 20 })).toBe(true)
    expect(hitTestInkWorld(node, { x: 30, y: 60 })).toBe(false)
  })
})

const makeNode = (geometry: NonNullable<ReturnType<typeof createInkGeometry>>): Node => ({
  id: asNodeId('ink-1'),
  type: 'ink',
  x: geometry.x,
  y: geometry.y,
  w: geometry.w,
  h: geometry.h,
  angle: 0,
  z: 1,
  groups: [],
  data: { ink: geometry.ink },
})
