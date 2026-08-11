// Elevation profile chart (distance vs. elevation) rendered with Chart.js as
// a grade-colored bar chart (Lightmile Stack's look), one bar per bucket from
// elevationBuckets.ts. Kept deliberately Chart.js-only (no DOM-only helpers)
// so the whole module can be code-split and lazy-loaded — see main.ts's
// loadChartModule().
import { Chart } from 'chart.js/auto';
import { cumulativeDistances } from './geo';
import { bucketElevation, coordinateIndexAtDistance } from './elevationBuckets';

let chart: Chart | null = null;

/**
 * Draws the elevation profile as grade-colored bars. `onHover` receives the
 * index into the ORIGINAL coordinates array so the caller can highlight that
 * point on the map. `bucketCount` controls resolution (the full-screen route
 * detail view wants more bars than a compact candidate card).
 */
export function renderElevationChart(
  canvas: HTMLCanvasElement,
  coordinates: [number, number, number][],
  onHover: (coordinateIndex: number) => void,
  bucketCount = 40,
): void {
  const distances = cumulativeDistances(coordinates);
  const totalKm = (distances[distances.length - 1] ?? 0) / 1000;
  const buckets = bucketElevation(coordinates, bucketCount);
  const data = buckets.map((bucket, i) => ({
    x: totalKm * ((i + 0.5) / buckets.length),
    y: bucket.heightFrac,
    color: bucket.color,
    elevationM: bucket.elevationM,
  }));

  // Read theme colors from CSS variables so the axes adapt to light/dark mode.
  const css = getComputedStyle(document.documentElement);
  const tickColor = css.getPropertyValue('--color-muted').trim() || '#6f6c62';
  const gridColor = css.getPropertyValue('--color-border').trim() || '#e4dfd3';

  chart?.destroy();
  chart = new Chart(canvas, {
    type: 'bar',
    data: {
      datasets: [
        {
          data,
          backgroundColor: data.map((d) => d.color),
          borderWidth: 0,
          borderRadius: 1,
          categoryPercentage: 1,
          barPercentage: 0.94,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `${(items[0].parsed.x ?? 0).toFixed(1)} km`,
            label: (item) => `${Math.round((item.raw as { elevationM: number }).elevationM)} m`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: totalKm,
          ticks: { maxTicksLimit: 6, callback: (v) => `${v} km`, color: tickColor },
          grid: { display: false },
          border: { color: gridColor },
        },
        y: {
          min: 0,
          max: 1,
          display: false,
          grid: { display: false },
          border: { display: false },
        },
      },
      onHover: (_event, elements) => {
        if (elements.length === 0) return;
        const km = data[elements[0].index].x;
        onHover(coordinateIndexAtDistance(distances, km * 1000));
      },
    },
  });
}

export function clearElevationChart(): void {
  chart?.destroy();
  chart = null;
}
