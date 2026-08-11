// Candidate loop cards: a horizontally swipeable row on mobile (CSS handles
// the responsive switch to a vertical stack on desktop, so there is one DOM
// structure, not two). Selected card shows elevation bars, the surface bar
// and a caption; the rest show just the shape, title and headline stats.
// Feeds the Generating screen's incremental reveal, the Candidates screen,
// and the desktop sidebar list — see the redesign plan.
import { buildRoutePreviewSvg } from './preview';
import { renderElevationBars } from './elevationBars';
import { renderSurfaceBar, type SurfaceTotals } from './surface';
import { escapeHtml } from './ui';

export interface CandidateCardData {
  title: string;
  distanceKm: number;
  ascendM: number;
  timeHours: number;
  closed: boolean;
  /** [lng, lat] only, for the mini route-shape icon (preview.ts). */
  waypoints: [number, number][];
  /** Full geometry, for the elevation bars. */
  coordinates: [number, number, number][];
  surfaceTotals: SurfaceTotals | null;
  climbCount: number;
}

function formatTime(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function pavedCaption(totals: SurfaceTotals | null, climbCount: number): string | null {
  const parts: string[] = [];
  if (totals) {
    const pavedPct = Math.round((totals.paved / totals.totalMeters) * 100);
    const unpavedPct = Math.round(((totals.unpaved + totals.cobbles) / totals.totalMeters) * 100);
    parts.push(`${pavedPct}% paved`, `${unpavedPct}% unpaved`);
  }
  if (climbCount > 0) parts.push(`${climbCount} climb${climbCount > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function buildCard(card: CandidateCardData, selected: boolean, index: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `candidate-card${selected ? ' active' : ''}`;
  button.dataset.candidateIndex = String(index);

  const head = document.createElement('div');
  head.className = 'candidate-head';
  const icon = buildRoutePreviewSvg(card.waypoints, card.closed, 56);
  icon.classList.add('candidate-icon');
  const info = document.createElement('div');
  info.className = 'candidate-info';
  info.innerHTML =
    `<div class="candidate-title">${escapeHtml(card.title)}</div>` +
    `<div class="candidate-stats">` +
    `<span>${card.distanceKm.toFixed(1)}<span class="unit">km</span></span>` +
    `<span>${Math.round(card.ascendM)}<span class="unit">m</span></span>` +
    `<span>${formatTime(card.timeHours)}</span>` +
    `</div>`;
  head.append(icon, info);
  button.append(head);

  if (selected) {
    const bars = document.createElement('div');
    bars.className = 'candidate-bars';
    renderElevationBars(bars, card.coordinates, 18);
    button.append(bars);

    if (card.surfaceTotals) {
      const surface = document.createElement('div');
      surface.className = 'candidate-surface';
      renderSurfaceBar(surface, card.surfaceTotals, { showLegend: false });
      button.append(surface);
    }

    const caption = pavedCaption(card.surfaceTotals, card.climbCount);
    if (caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'candidate-caption';
      captionEl.textContent = caption;
      button.append(captionEl);
    }
  }

  return button;
}

/** A skeleton placeholder card, for slots still generating (see the Generating screen). */
function buildSkeletonCard(): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'candidate-card candidate-card-skeleton';
  card.innerHTML =
    `<div class="candidate-head">` +
    `<div class="sk candidate-icon-sk"></div>` +
    `<div class="candidate-info"><div class="sk" style="width:64%;height:15px;"></div>` +
    `<div class="sk" style="width:88%;height:12px;margin-top:9px;"></div></div>` +
    `</div>`;
  return card;
}

export function renderCandidateCards(
  container: HTMLElement,
  cards: CandidateCardData[],
  selectedIndex: number,
  onSelect: (index: number) => void,
  skeletonCount = 0,
): void {
  container.innerHTML = '';
  cards.forEach((card, i) => {
    const el = buildCard(card, i === selectedIndex, i);
    el.addEventListener('click', () => onSelect(i));
    container.append(el);
  });
  for (let i = 0; i < skeletonCount; i++) container.append(buildSkeletonCard());
}

/** Dot pagination for the mobile carousel; hidden by CSS on desktop. */
export function renderCandidateDots(container: HTMLElement, count: number, selectedIndex: number): void {
  container.innerHTML = '';
  if (count <= 1) return;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('i');
    dot.className = i === selectedIndex ? 'candidate-dot active' : 'candidate-dot';
    container.append(dot);
  }
}
