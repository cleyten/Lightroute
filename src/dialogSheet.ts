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
  }

  backdropEl.addEventListener('click', doClose);
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
