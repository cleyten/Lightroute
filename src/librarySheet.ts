// The Community tab's Discover/Your-library segment (decision: no separate
// bottom-nav icon for the library, since the mockup's own nav only ever
// shows Plan/Community — see the redesign plan) and the restyled saved-route
// rows. Account block and Published-tab filtering stay in main.ts (they are
// thin wrappers around existing auth/community state, not worth a module).
import { buildRoutePreviewSvg } from './preview';
import { escapeHtml } from './ui';
import type { SavedRoute } from './storage';

export type LibrarySegment = 'discover' | 'library';

/**
 * Wires the Discover/Your-library segmented toggle. `onChange` fires with
 * the newly-active segment so the caller can show/hide the two panels.
 */
export function initLibrarySegment(
  container: HTMLElement,
  onChange: (segment: LibrarySegment) => void,
): void {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button[data-segment]')];
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const segment = button.dataset.segment as LibrarySegment;
      buttons.forEach((b) => {
        const active = b === button;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      onChange(segment);
    });
  });
}

function formatSavedDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return 'today';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export interface SavedListCallbacks {
  onLoad: (route: SavedRoute) => void;
  onDelete: (route: SavedRoute) => void;
}

/** Restyled saved-route rows: shape icon, name, "distance · bike · date", overflow delete. */
export function renderSavedList(
  container: HTMLElement,
  routes: SavedRoute[],
  callbacks: SavedListCallbacks,
): void {
  container.innerHTML = '';
  for (const route of routes) {
    const item = document.createElement('li');
    item.className = 'library-item';

    const preview = buildRoutePreviewSvg(route.waypoints, route.closed ?? false, 44);
    preview.classList.add('library-preview');

    const bikeLabel =
      route.bike === 'mtb' ? 'MTB' : route.bike.charAt(0).toUpperCase() + route.bike.slice(1);
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'library-name';
    label.title = 'Load this route';
    label.innerHTML =
      `<span class="library-title">${escapeHtml(route.name)}</span>` +
      `<span class="library-meta">${(route.distanceMeters / 1000).toFixed(1)} km · ${bikeLabel} · ${formatSavedDate(route.createdAt)}</span>`;
    label.addEventListener('click', () => callbacks.onLoad(route));

    const overflow = document.createElement('button');
    overflow.type = 'button';
    overflow.className = 'library-overflow';
    overflow.title = 'Delete this route';
    overflow.setAttribute('aria-label', 'Delete this route');
    overflow.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';
    overflow.addEventListener('click', () => callbacks.onDelete(route));

    item.append(preview, label, overflow);
    container.append(item);
  }
}
