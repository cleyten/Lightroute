// On phones the control panel is a draggable sheet over a full-screen map.
// Dragging the handle snaps it between peek / half / full; tapping cycles up.
// Everything here is inert on desktop, where the panel is a floating sidebar
// and the inline transform must never leak onto it.

export interface BottomSheetHandle {
  /** Raises the sheet from peek to half, if it's currently at peek. No-op on desktop. */
  raiseToHalf(): void;
  /**
   * Re-applies the current snap point. Needed whenever the sheet's contents
   * change height, because the middle snap is measured from that content: without
   * it, switching screens leaves the sheet at the offset computed for the
   * previous screen, which is how the candidate carousel's primary button ended
   * up behind the bottom tab bar.
   */
  refresh(): void;
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

  /**
   * How much of the sheet the middle snap should expose.
   *
   * Content-driven rather than a fixed fraction of the sheet. A flat 48% was
   * wrong in both directions: it cut the Plan screen's primary button off below
   * the fold (so a route could not be started without going full height, which
   * then hid the map entirely), while wasting map area on the shorter screens.
   * Clamped at both ends so the sheet always shows something useful and never
   * swallows the whole map.
   */
  function desiredVisibleHeight(h: number): number {
    const bodyEl = document.querySelector<HTMLElement>('#sheet-body');
    if (!bodyEl) return Math.round(h * 0.48);
    // Sum the direct children rather than reading scrollHeight: the body is
    // stretched to fill the sheet, so its scrollHeight never drops below its own
    // box height and would always report a nearly-full sheet. Hidden children
    // (the inactive tab panel, the screens that are not showing) measure 0.
    const children = [...bodyEl.children] as HTMLElement[];
    const content =
      handleEl!.offsetHeight +
      children.reduce((sum, child) => sum + child.offsetHeight, 0) +
      // Slack for the children's own margins, which offsetHeight excludes.
      20;
    // The upper clamp has to clear the tallest screen's primary button (the
    // candidate carousel's "Use this loop"), or that button lands behind the
    // bottom tab bar. It still leaves a strip of map showing.
    return Math.max(Math.round(h * 0.34), Math.min(content, Math.round(h * 0.9)));
  }

  // Offsets in px to translate the sheet down by, per snap level: peek shows the
  // handle plus a sliver, half fits the current content, full is the whole sheet.
  function offsets(): number[] {
    const h = sheetEl!.offsetHeight;
    const peekVisible = 112;
    const peek = Math.max(0, h - peekVisible);
    const half = Math.min(peek, Math.max(0, h - desiredVisibleHeight(h)));
    return [peek, half, 0];
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

  const bodyEl = document.querySelector<HTMLElement>('#sheet-body');

  let dragging = false;
  /** A touch started on the content while it was scrolled to the top: it
   *  becomes a sheet drag only once the finger actually moves down, so an
   *  upward swipe still scrolls the content normally. */
  let armedFromBody = false;
  let startY = 0;
  let startOffset = 0;
  /** Movement (px) before an armed content touch is treated as a sheet drag. */
  const PROMOTE_THRESHOLD = 8;

  function beginDrag(clientY: number): void {
    dragging = true;
    armedFromBody = false;
    startY = clientY;
    startOffset = currentY();
    sheetEl!.style.transition = 'none';
  }

  handleEl.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    beginDrag(e.clientY);
  });

  // Swiping down on the content lowers the sheet, the way every native bottom
  // sheet behaves. Without this the only way to lower it was the handle, and a
  // grab even slightly too high landed on the map and panned it instead.
  bodyEl?.addEventListener('pointerdown', (e) => {
    if (!isMobile() || dragging) return;
    if (bodyEl.scrollTop > 0) return; // mid-scroll: leave the content alone
    armedFromBody = true;
    startY = e.clientY;
    startOffset = currentY();
  });

  // On window, not on the handle: pointer capture is unreliable on some iOS
  // versions, and without it a drag used to die the moment the finger left the
  // 28px handle.
  window.addEventListener('pointermove', (e) => {
    if (armedFromBody && !dragging) {
      const dy = e.clientY - startY;
      // Only a downward swipe takes over; upward still scrolls the content.
      if (dy > PROMOTE_THRESHOLD) beginDrag(startY);
      else if (dy < -PROMOTE_THRESHOLD) armedFromBody = false;
    }
    if (!dragging) return;
    const h = sheetEl.offsetHeight;
    translateTo(Math.min(Math.max(0, startOffset + (e.clientY - startY)), h - 80));
  });

  const endDrag = (fromHandle: boolean) => (): void => {
    armedFromBody = false;
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = '';
    const y = currentY();
    if (Math.abs(y - startOffset) < 6) {
      // A tap on the handle cycles peek -> half -> full -> peek. A tap on the
      // content must not: it is almost certainly aimed at a control.
      if (fromHandle) apply(snap >= 2 ? 0 : snap + 1);
      else apply(snap);
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
  handleEl.addEventListener('pointerup', endDrag(true));
  window.addEventListener('pointerup', endDrag(false));
  window.addEventListener('pointercancel', endDrag(false));

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
    refresh() {
      if (!isMobile()) return;
      // Let the new content lay out before measuring it.
      requestAnimationFrame(() => {
        offsetY = null;
        apply(snap);
      });
    },
  };
}
