// The wordmark lives in two different places depending on the breakpoint: at
// the top of the sidebar on desktop, and floating over the map as a pill on
// phones (the Lightmile Stack mockup's layout).
//
// This has to move the element in the DOM rather than just restyle it. #sidebar
// carries a transform for the sheet drag, and a transformed ancestor becomes the
// containing block for position:fixed descendants, so no amount of CSS can lift
// a child of the sheet out and pin it to the viewport. Reparenting keeps the
// same element, so every listener already bound to it (the theme toggle) stays
// attached.

export function initBrandPlacement(onMoved?: () => void): void {
  const brand = document.querySelector<HTMLElement>('#brand');
  const app = document.querySelector<HTMLElement>('#app');
  const sheetBody = document.querySelector<HTMLElement>('#sheet-body');
  const map = document.querySelector<HTMLElement>('#map');
  if (!brand || !app || !sheetBody || !map) return;

  const mobile = window.matchMedia('(max-width: 700px)');

  function place(): void {
    if (mobile.matches) {
      if (brand!.parentElement === app) return;
      // After #map so it paints above the basemap without needing a high z-index.
      map!.after(brand!);
    } else {
      if (brand!.parentElement === sheetBody) return;
      sheetBody!.prepend(brand!);
    }
    onMoved?.();
  }

  place();
  mobile.addEventListener('change', place);
}
