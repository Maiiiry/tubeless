/**
 * Optimal string alignment distance: insertions, deletions, substitutions, and
 * adjacent transpositions each cost one. Returns `limit + 1` once the distance
 * provably exceeds `limit`, so callers can reject distant candidates cheaply.
 */
function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        value = Math.min(value, previousPrevious[j - 2]! + 1);
      }
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Candidates plausibly meant by a mistyped `input`, closest first.
 *
 * Matching is case-insensitive. A candidate qualifies when its edit distance is
 * at most one third of the longer string (minimum 1), or when a 3+ character
 * input is a prefix of it. Ties keep candidate order. Exact matches are excluded
 * because they are not mistakes.
 */
export function closestMatches(input: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = input.toLowerCase();
  const scored: { candidate: string; distance: number; order: number }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate) || candidate === input) continue;
    seen.add(candidate);
    const hay = candidate.toLowerCase();
    const maxDistance = Math.max(1, Math.floor(Math.max(needle.length, hay.length) / 3));
    const distance = editDistance(needle, hay, maxDistance);
    if (distance <= maxDistance) {
      scored.push({ candidate, distance, order: order++ });
    } else if (needle.length >= 3 && hay.startsWith(needle)) {
      // Prefixes rank after every true near-miss.
      scored.push({ candidate, distance: maxDistance + 1, order: order++ });
    }
  }
  return scored
    .sort((left, right) => left.distance - right.distance || left.order - right.order)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

/**
 * A `Did you mean …?` sentence for the closest candidates, or `undefined` when
 * nothing is close. `quote` renders each candidate (default: JSON string).
 */
export function didYouMean(
  input: string,
  candidates: Iterable<string>,
  quote: (candidate: string) => string = (candidate) => JSON.stringify(candidate)
): string | undefined {
  const matches = closestMatches(input, candidates).map(quote);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return `Did you mean ${matches[0]}?`;
  return `Did you mean ${matches.slice(0, -1).join(", ")} or ${matches.at(-1)}?`;
}
