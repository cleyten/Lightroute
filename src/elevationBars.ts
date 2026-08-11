// A lightweight, non-Chart.js elevation profile: a row of grade-colored
// <div>s. Used wherever the full interactive chart (chart.ts, Chart.js) would
// be overkill for what it costs to set up — candidate cards (many at once),
// the desktop sidebar. The full route detail keeps the real Chart.js chart
// (see chart.ts) for its hover-highlights-the-map behavior.
import { bucketElevation } from './elevationBuckets';

export function renderElevationBars(
  container: HTMLElement,
  coordinates: [number, number, number][],
  bucketCount = 18,
): void {
  container.innerHTML = '';
  for (const bucket of bucketElevation(coordinates, bucketCount)) {
    const bar = document.createElement('div');
    bar.style.flex = '1';
    bar.style.height = `${Math.round(bucket.heightFrac * 100)}%`;
    bar.style.background = bucket.color;
    container.append(bar);
  }
}
