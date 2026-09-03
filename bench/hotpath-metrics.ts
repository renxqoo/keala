/** Statistics for same-round samples, not ratios of independently sorted data. */
export const positiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError(`${name} must be a positive integer`);
  return parsed;
};

export const median = (values: readonly number[]): number => {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("median requires nonempty finite samples");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export const comparePaired = (current: readonly number[], baseline: readonly number[]) => {
  if (current.length !== baseline.length || current.length === 0) {
    throw new TypeError("paired samples must have equal nonzero lengths");
  }
  if ([...current, ...baseline].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new TypeError("RPS samples must be finite and positive");
  }
  const ratios = current.map((value, index) => value / baseline[index]!);
  return {
    medianRatio: median(ratios),
    minRatio: Math.min(...ratios),
    maxRatio: Math.max(...ratios),
    pairedRatios: ratios,
    independentMedianRatio: median(current) / median(baseline),
  };
};
