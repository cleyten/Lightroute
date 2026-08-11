// The Sort & Filter dialog's own small pieces: the "Show N routes" button
// label and resetting the filter controls to their defaults. The dialog's
// open/close/backdrop mechanics are dialogSheet.ts; the actual sort/filter
// *logic* (filteredCommunityRoutes, the click handlers on each pill) stays
// in main.ts exactly as it was before this became a dialog — this module
// only reaches for the DOM elements it needs, not the filter state itself.

export function setApplyButtonCount(button: HTMLButtonElement, count: number): void {
  button.textContent = `Show ${count} route${count === 1 ? '' : 's'}`;
}

/** Clicks each group's default/"all" button and resets the distance range. */
export function resetFilterControls(
  sortDefault: HTMLButtonElement,
  bikeDefault: HTMLButtonElement,
  hillsDefault: HTMLButtonElement,
  distMin: HTMLInputElement,
  distMax: HTMLInputElement,
): void {
  sortDefault.click();
  bikeDefault.click();
  hillsDefault.click();
  distMin.value = distMin.min;
  distMax.value = distMax.max;
  distMin.dispatchEvent(new Event('input', { bubbles: true }));
  distMax.dispatchEvent(new Event('input', { bubbles: true }));
}
