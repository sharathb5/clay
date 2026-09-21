/**
 * Classification scoring against sealed human gold.
 * No rationale grading. No embeddings. No composite score.
 */

import type { Classification } from "../agent-replay/types.ts";

const CLASSIFICATIONS: Classification[] = [
  "strong_fit",
  "medium_fit",
  "weak_fit",
  "unclear",
];

export function emptyClassificationCounts(): Record<Classification, number> {
  return {
    strong_fit: 0,
    medium_fit: 0,
    weak_fit: 0,
    unclear: 0,
  };
}

export function classificationMatchesGold(
  predicted: Classification | null,
  gold: Classification,
): boolean {
  return predicted !== null && predicted === gold;
}

export function modalClassification(
  counts: Record<Classification, number>,
): Classification | null {
  let best: Classification | null = null;
  let bestCount = 0;
  for (const c of CLASSIFICATIONS) {
    const n = counts[c];
    if (n > bestCount) {
      best = c;
      bestCount = n;
    } else if (n === bestCount && n > 0) {
      // Tie: no unique modal.
      best = null;
    }
  }
  return bestCount === 0 ? null : best;
}

export function modalShare(
  counts: Record<Classification, number>,
  totalRuns: number,
): number | null {
  if (totalRuns <= 0) return null;
  let bestCount = 0;
  for (const c of CLASSIFICATIONS) {
    if (counts[c] > bestCount) bestCount = counts[c];
  }
  if (bestCount === 0) return null;
  return Math.round((bestCount / totalRuns) * 1000) / 10;
}

export function distinctClassificationCount(
  counts: Record<Classification, number>,
): number {
  return CLASSIFICATIONS.filter((c) => counts[c] > 0).length;
}

export function accuracyRate(correct: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((correct / total) * 1000) / 10;
}
