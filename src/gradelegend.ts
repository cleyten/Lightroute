// Grade-color thresholds. Split out from chart.ts (which pulls in the heavy
// chart.js/auto bundle) so this tiny, static, Chart.js-independent piece can
// stay in the app's eagerly-loaded main chunk while the chart itself is
// code-split and lazy-loaded (see main.ts's loadChartModule()).

/** Grade thresholds (percent, upper bound inclusive) and their colors, mild to steep. */
export const GRADE_STOPS: { max: number; color: string; label: string }[] = [
  { max: 0, color: '#4a90d9', label: 'Descent' },
  { max: 3, color: '#63a922', label: '0–3%' },
  { max: 6, color: '#d9a72e', label: '3–6%' },
  { max: 9, color: '#e8571a', label: '6–9%' },
  { max: 12, color: '#c62828', label: '9–12%' },
  { max: Infinity, color: '#7a1414', label: '12%+' },
];

/**
 * Grade (percent) to a `GRADE_STOPS` color. The one place this mapping is
 * made, so the elevation chart, the mini elevation bars, and climb badges
 * can't drift out of sync with each other or with the legend above.
 */
export function gradeColor(pct: number): string {
  for (const stop of GRADE_STOPS) {
    if (pct <= stop.max) return stop.color;
  }
  return GRADE_STOPS[GRADE_STOPS.length - 1].color;
}
