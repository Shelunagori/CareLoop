/**
 * Robust statistics for cadence.
 *
 * Median and MAD rather than mean and standard deviation, because with four to
 * twelve observations a single outlier - a fortnight away at Christmas - drags
 * a mean badly and inflates a standard deviation enough to suppress every
 * future signal. These are the estimators that behave at the sample sizes this
 * product actually has.
 */

/** Median of a non-empty list. Even counts average the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Median Absolute Deviation: median(|x - median(x)|).
 *
 * This is NOT mean absolute deviation. For [2,7,7,8] the median is 7, the
 * absolute deviations are [5,0,0,1], and the MAD is 0.5 - the median of those
 * deviations. Their mean would be 1.5, so a skewed series is what actually
 * distinguishes the two.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) throw new Error("MAD of an empty list");
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}
