// Shared open/close/backdrop/Escape behavior for the two mockup dialogs that
// sit over a dimmed backdrop rather than being just another sheet screen:
// Sort & Filter and Save/Export. Both reuse this instead of hand-rolling the
// same three event listeners twice.

export interface DialogSheetHandle {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function initDialogSheet(dialogEl: HTMLElement, backdropEl: HTMLElement): DialogSheetHandle {
  let openState = false;

  function doOpen(): void {
    openState = true;
    backdropEl.hidden = false;
    dialogEl.hidden = false;
  }

  function doClose(): void {
    openState = false;
    backdropEl.hidden = true;
    dialogEl.hidden = true;
    // These sheets carry text inputs (route name, place search). iOS shifts the
    // visual viewport up to clear the on-screen keyboard and does not always
    // shift it back, which leaves the whole page scrolled and its top edge
    // clipped. Dropping focus dismisses the keyboard, and the scroll reset
    // undoes the shift if it stuck. Same defence as bottomSheet.ts's restore().
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }

  // pointerdown, not click: iOS Safari does not reliably fire click on a bare
  // non-interactive <div>, so tap-to-dismiss silently did nothing on iPhone.
  // pointerdown also feels more immediate than waiting for a full tap.
  backdropEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    doClose();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openState) doClose();
  });

  return {
    open: doOpen,
    close: doClose,
    get isOpen() {
      return openState;
    },
  };
}
