export {
  buildInkOutline,
  createInkGeometry,
  distanceToSegment,
  drawInkDraft,
  drawInkNode,
  hitTestInkLocal,
  hitTestInkWorld,
  interpolateInkSamples,
  readInkData,
  traceSmoothInkOutline,
} from './geometry'
export { inkNodeDef } from './node'
export type {
  InkDraft,
  InkEraserDraft,
  InkGeometry,
  InkNodeData,
  InkPoint,
  InkSample,
  InkStrokeData,
} from './types'
