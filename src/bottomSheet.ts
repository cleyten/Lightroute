// On phones the control panel is a draggable sheet over a full-screen map.
// Dragging the handle snaps it between peek / half / full; tapping cycles up.
// Everything here is inert on desktop, where the panel is a floating sidebar
// and the inline transform must never leak onto it.

export interface BottomSheetHandle {
  /** Raises the sheet from peek to half, if it's currently at peek. No-op on desktop. */
  raiseToHalf(): void;
}

export function initBottomSheet(): BottomSheetHandle | null {
  const sheetEl = document.querySelector<HTMLElement>('#sidebar');
  const handleEl = document.querySelector<HTMLElement>('#sheet-handle');
  if (!sheetEl || !handleEl) return null;

  const fab = document.querySelector<HTMLElement>('#gps-fab');
  const locateEl = document.querySelector<HTMLButtonElement>('#btn-locate');

  const isMobile = (): boolean => window.matchMedia('(max-width: 700px)').matches;

  // Default to half (not peek): search/generate and the community list should
  // be visible without dragging first, and the map shouldn't dominate the
  // screen on load.
  let snap = 1; // 0 = peek, 1 = half, 2 = full

  // Tracked alongside `snap` rather than parsed back out of the inline style,
  // so the drag maths never depends on reading a CSS string.
  let offsetY: number | null = null;

  // Offsets in px to translate the sheet down by, per snap level.
  // Peek shows the handle + top of the panel; half ~48% of the viewport;
  // full is the whole 92vh sheet.
  function offsets(): number[] {
    const h = sheetEl!.offsetHeight;
    const peekVisible = 112;
    return [Math.max(0, h - peekVisible), Math.round(h * 0.48), 0];
  }

  function currentY(): number {
    return offsetY ?? offsets()[snap];
  }

  function translateTo(y: number): void {
    offsetY = y;
    sheetEl!.style.transform = `translateY(${y}px)`;
  }

  function apply(index: number, animate = true): void {
    snap = Math.max(0, Math.min(2, index));
    sheetEl!.style.transition = animate ? '' : 'none';
    translateTo(offsets()[snap]);
    handleEl!.setAttribute('aria-expanded', String(snap > 0));
  }

  /** Clears inline styles on desktop so the sheet transform never leaks there. */
  function reset(): void {
    if (isMobile()) {
      apply(snap, false);
    } else {
      offsetY = null;
      sheetEl!.style.transform = '';
      sheetEl!.style.transition = '';
    }
  }

  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  handleEl.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    dragging = true;
    startY = e.clientY;
    startOffset = currentY();
    sheetEl.style.transition = 'none';
    try {
      handleEl.setPointerCapture(e.pointerId);
    } catch {
      // Not available in every environment; dragging still works without it,
      // it just stops tracking if the pointer leaves the handle.
    }
  });

  handleEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = sheetEl.offsetHeight;
    translateTo(Math.min(Math.max(0, startOffset + (e.clientY - startY)), h - 80));
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = '';
    const y = currentY();
    // A tap (barely moved) cycles peek -> half -> full -> peek.
    if (Math.abs(y - startOffset) < 6) {
      apply(snap >= 2 ? 0 : snap + 1);
      return;
    }
    // Otherwise settle on whichever snap point the sheet was released nearest.
    const offs = offsets();
    let best = 0;
    let bestDist = Infinity;
    offs.forEach((o, i) => {
      const d = Math.abs(o - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    apply(best);
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);

  // Keyboard: Enter/Space cycles up, arrows step between snap levels.
  handleEl.addEventListener('keydown', (e) => {
    if (!isMobile()) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      apply(snap >= 2 ? 0 : snap + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      apply(snap + 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      apply(snap - 1);
    }
  });

  if (fab && locateEl) {
    fab.addEventListener('click', () => locateEl.click());
  }

  window.addEventListener('resize', reset);

  // When the PWA comes back to the foreground (or is restored from the page
  // cache), iOS can leave the web view scrolled with the sheet transform stale
  // — the map ends up unreachable. Reset any errant page scroll and re-assert
  // the sheet's snap position.
  const restore = (): void => {
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    reset();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') restore();
  });
  window.addEventListener('pageshow', restore);

  reset();

  return {
    raiseToHalf() {
      if (isMobile() && snap === 0) apply(1);
    },
  };
}
