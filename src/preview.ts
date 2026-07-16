// A tiny geographically-scaled sketch of a route, drawn from its waypoints, for
// the community list. It is NOT the routed geometry (that would need a BRouter
// call per route); just the waypoint outline, which is enough to recognise a
// route's overall shape at a glance.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function buildRoutePreviewSvg(
  waypoints: [number, number][],
  closed: boolean,
  size = 48,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('route-preview');
  svg.setAttribute('aria-hidden', 'true');
  if (waypoints.length < 2) return svg;

  const pad = 5;
  // Scale longitude by cos(latitude) so the shape isn't stretched horizontally.
  const kx = Math.cos((waypoints[0][1] * Math.PI) / 180);
  const pts = waypoints.map(([lng, lat]) => [lng * kx, lat] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1e-6;
  const spanY = Math.max(...ys) - minY || 1e-6;
  const inner = size - 2 * pad;
  const scale = inner / Math.max(spanX, spanY);
  const offX = pad + (inner - spanX * scale) / 2;
  const offY = pad + (inner - spanY * scale) / 2;
  const project = ([x, y]: [number, number]): string => {
    const px = offX + (x - minX) * scale;
    // Flip Y: latitude grows up, SVG y grows down.
    const py = size - (offY + (y - minY) * scale);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  };

  const points = pts.map(project);
  if (closed) points.push(project(pts[0]));
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
  return svg;
}
