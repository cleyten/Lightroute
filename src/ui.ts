// Small presentation helpers shared across the app: the status bar, the
// collapsible section toggles, and the segmented-button active state.

import { statusBarEl, statusEl } from './dom';

export function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
  syncStatusBar();
}

/**
 * Counted rather than boolean: several things can be in flight at once (a
 * reroute plus a café search, say), and the first one to finish must not clear
 * the indicator while the others are still running.
 */
let busyCount = 0;

export function setBusy(busy: boolean): void {
  busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
  syncStatusBar();
}

function syncStatusBar(): void {
  statusBarEl.dataset.state = busyCount > 0
    ? 'busy'
    : statusEl.textContent
      ? 'message'
      : 'idle';
}

// Routing, search and the community library all need the network. Cached map
// tiles keep the map itself usable offline, which makes the failure mode
// confusing: everything looks fine until an action silently fails with a raw
// "Failed to fetch". Say it plainly instead.
window.addEventListener('offline', () => {
  setStatus('You are offline. The map still works, but routing and search do not.', true);
});
window.addEventListener('online', () => {
  if (statusEl.classList.contains('error')) setStatus('Back online.');
});

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Wires a chevron toggle button to show/hide the content it controls, collapsed
 * by default. Used for "Bike, traffic & hills" and "Sort & filter" so the
 * primary action (search/generate, the route list) sits above the fold on
 * mobile instead of being pushed down by settings most visits don't change.
 */
export function initDisclosure(toggleSelector: string, bodySelector: string): void {
  const toggle = document.querySelector<HTMLButtonElement>(toggleSelector);
  const body = document.querySelector<HTMLElement>(bodySelector);
  if (!toggle || !body) return;
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    body.hidden = expanded;
  });
}

/** Marks one button in a segmented control active, clearing the others. */
export function setActiveInGroup(
  buttons: HTMLButtonElement[],
  active: HTMLButtonElement,
): void {
  buttons.forEach((button) => {
    const on = button === active;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  });
}
