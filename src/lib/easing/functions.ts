/**
 * Easing Functions Library
 * Based on easings.net standards
 */

export type EasingFunction = (t: number) => number;

const createAsymmetricEase = (easeIn: EasingFunction, easeOut: EasingFunction): EasingFunction => {
  return (t: number): number => {
    if (t <= 0.5) {
      return 0.5 * easeIn(t * 2);
    }
    return 0.5 + 0.5 * easeOut((t - 0.5) * 2);
  };
};

const baseEasing = {
  linear: (t: number): number => t,
  easeInQuad: (t: number): number => t * t,
  easeOutQuad: (t: number): number => t * (2 - t),
  easeInOutQuad: (t: number): number =>
    t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  easeInCubic: (t: number): number => t * t * t,
  easeOutCubic: (t: number): number => {
    const t1 = t - 1;
    return t1 * t1 * t1 + 1;
  },
  easeInOutCubic: (t: number): number =>
    t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeInQuart: (t: number): number => t * t * t * t,
  easeOutQuart: (t: number): number => {
    const t1 = t - 1;
    return 1 - t1 * t1 * t1 * t1;
  },
  easeInOutQuart: (t: number): number =>
    t < 0.5
      ? 8 * t * t * t * t
      : 1 - Math.pow(-2 * t + 2, 4) / 2,
  easeInQuint: (t: number): number => t * t * t * t * t,
  easeOutQuint: (t: number): number => {
    const t1 = t - 1;
    return 1 + t1 * t1 * t1 * t1 * t1;
  },
  easeInOutQuint: (t: number): number =>
    t < 0.5
      ? 16 * t * t * t * t * t
      : 1 - Math.pow(-2 * t + 2, 5) / 2,
  easeInSine: (t: number): number =>
    1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t: number): number =>
    Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t: number): number =>
    -(Math.cos(Math.PI * t) - 1) / 2,
  easeInExpo: (t: number): number =>
    t === 0 ? 0 : Math.pow(2, 10 * t - 10),
  easeOutExpo: (t: number): number =>
    t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  easeInOutExpo: (t: number): number =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? Math.pow(2, 20 * t - 10) / 2
          : (2 - Math.pow(2, -20 * t + 10)) / 2,
  easeInCirc: (t: number): number =>
    1 - Math.sqrt(1 - Math.pow(t, 2)),
  easeOutCirc: (t: number): number =>
    Math.sqrt(1 - Math.pow(t - 1, 2)),
  easeInOutCirc: (t: number): number =>
    t < 0.5
      ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,
} as const;

const hybridEasing = {
  easeInExpoOutCubic: createAsymmetricEase(baseEasing.easeInExpo, baseEasing.easeOutCubic),
  easeInQuartOutQuad: createAsymmetricEase(baseEasing.easeInQuart, baseEasing.easeOutQuad),
} as const;

export const easing = {
  ...baseEasing,
  ...hybridEasing,
} as const;

export function getEasingFunction(name: string): EasingFunction {
  const func = easing[name as keyof typeof easing];
  if (!func) { console.warn(`Easing function "${name}" not found, using linear`); return easing.linear; }
  return func;
}

export function getAllEasingNames(): string[] {
  return Object.keys(easing);
}
