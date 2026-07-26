// Elevation profile chart (distance vs. elevation) rendered with Chart.js,
// colored continuously by grade (steepness) rather than a flat single color.
// Kept deliberately Chart.js-only (no DOM-only helpers) so the whole module
// can be code-split and lazy-loaded — see main.ts's loadChartModule().
import { Chart } from 'chart.js/auto';
import { cumulativeDistances } from './geo';
import { GRADE_STOPS } from './gradelegend';

let chart: Chart | null = null;

function gradeColor(pct: number): string {
  for (const stop of GRADE_STOPS) {
    if (pct <= stop.max) return stop.color;
  }
  return GRADE_STOPS[GRADE_STOPS.length - 1].color;
}

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${hex}${a}`;
}

/** Grade (percent) of a chart segment: x is km, y is meters elevation. */
function segmentGradePct(p0: unknown, p1: unknown): number {
  const a = (p0 as { parsed: { x: number; y: number } }).parsed;
  const b = (p1 as { parsed: { x: number; y: number } }).parsed;
  const runM = (b.x - a.x) * 1000;
  if (runM <= 0) return 0;
  return ((b.y - a.y) / runM) * 100;
}

/**
 * Draws the elevation profile. `onHover` receives the index into the
 * ORIGINAL coordinates array so the caller can highlight that point on the
 * map. Each segment is colored by its grade (steepness), from a cool tone for
 * descents through green/amber/orange/red for progressively steeper climbs.
 */
export function renderElevationChart(
  canvas: HTMLCanvasElement,
  coordinates: [number, number, number][],
  onHover: (coordinateIndex: number) => void,
): void {
  // Downsample long tracks; the chart stays readable and fast.
  const stride = Math.max(1, Math.ceil(coordinates.length / 600));
  const indices: number[] = [];
  for (let i = 0; i < coordinates.length; i += stride) indices.push(i);
  if (indices[indices.length - 1] !== coordinates.length - 1) {
    indices.push(coordinates.length - 1);
  }

  const distances = cumulativeDistances(coordinates);
  const data = indices.map((i) => ({
    x: distances[i] / 1000,
    y: coordinates[i][2] ?? 0,
  }));

  // Read theme colors from CSS variables so the axes adapt to light/dark mode.
  const css = getComputedStyle(document.documentElement);
  const tickColor = css.getPropertyValue('--color-muted').trim() || '#6f6c62';
  const gridColor = css.getPropertyValue('--color-border').trim() || '#e4dfd3';

  chart?.destroy();
  chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          data,
          borderColor: '#2f5bff',
          backgroundColor: 'rgba(47, 91, 255, 0.15)',
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.1,
          segment: {
            borderColor: (ctx) => gradeColor(segmentGradePct(ctx.p0, ctx.p1)),
            backgroundColor: (ctx) => withAlpha(gradeColor(segmentGradePct(ctx.p0, ctx.p1)), 0.2),
          },
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `${(items[0].parsed.x ?? 0).toFixed(1)} km`,
            label: (item) => `${Math.round(item.parsed.y ?? 0)} m`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          ticks: { maxTicksLimit: 6, callback: (v) => `${v} km`, color: tickColor },
          grid: { color: gridColor },
          border: { color: gridColor },
        },
        y: {
          ticks: { maxTicksLimit: 5, callback: (v) => `${v} m`, color: tickColor },
          grid: { color: gridColor },
          border: { color: gridColor },
        },
      },
      onHover: (_event, elements) => {
        if (elements.length > 0) onHover(indices[elements[0].index]);
      },
    },
  });
}

export function clearElevationChart(): void {
  chart?.destroy();
  chart = null;
}
