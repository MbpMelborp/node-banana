/**
 * The app's easing library: the named easings (easings.net), the bezier presets, and the curves that remap time (a
 * named easing, a cubic bezier, or points), shared by the Ease Curve node and the Edit video editor's clip speed.
 * Pure: it imports nothing outside this folder, so the server runs it too.
 */

export { easing, getAllEasingNames, getEasingFunction, type EasingFunction } from "./functions";
export {
  DEFAULT_CUSTOM_BEZIER,
  EASING_PRESETS,
  PRESET_BEZIERS,
  getEasingBezier,
  getPresetBezier,
  type EasingPresetName,
} from "./presets";
export { bezierCurve, createBezierEasing, isIdentityBezier } from "./bezier";
export { LINEAR_CURVE, MAX_SLOPE, isMonotoneEasing, presetCurve, windowCurve, type RemapCurve } from "./remap";
export {
  MAX_CURVE_POINTS,
  MIN_POINT_GAP,
  addRemapPoint,
  isIdentityPoints,
  moveRemapPoint,
  normalizePoints,
  pointsCurve,
  removeRemapPoint,
  toPoints,
  type CurvePoint,
} from "./points";
export { easingPolyline } from "./polyline";
export { easingLabel } from "./labels";
