// Elevation profile chart (distance vs. elevation) rendered with Chart.js.
import { Chart } from 'chart.js/auto';
import { cumulativeDistances } from './geo';
import type { Climb } from './climbs';

let chart: Chart | null = null;

/**
 * Draws the elevation profile. `onHover` receives the index into the
 * ORIGINAL coordinates array so the caller can highlight that point on the
 * map. Stretches inside a detected climb are drawn in orange.
 */
export function renderElevationChart(
  canvas: HTMLCanvasElement,
  coordinates: [number, number, number][],
  onHover: (coordinateIndex: number) => void,
  climbs: Climb[] = [],
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

  // Climb ranges in km along the track, for per-segment coloring.
  const climbRanges = climbs.map((c) => [c.startKm, c.startKm + c.lengthM / 1000]);
  const inClimb = (km: number) =>
    climbRanges.some(([from, to]) => km >= from && km <= to);

  chart?.destroy();
  chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          data,
          borderColor: '#2424e8',
          backgroundColor: 'rgba(36, 36, 232, 0.15)',
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.1,
          segment: {
            borderColor: (ctx) =>
              inClimb((ctx.p0 as { parsed: { x: number } }).parsed.x) ? '#e8571a' : '#2424e8',
            backgroundColor: (ctx) =>
              inClimb((ctx.p0 as { parsed: { x: number } }).parsed.x)
                ? 'rgba(232, 87, 26, 0.18)'
                : 'rgba(36, 36, 232, 0.15)',
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
          ticks: { maxTicksLimit: 6, callback: (v) => `${v} km` },
        },
        y: {
          ticks: { maxTicksLimit: 5, callback: (v) => `${v} m` },
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
