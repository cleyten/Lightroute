// The "Save this route" dialog: a name field plus three rows (Share a link /
// Export / Publish to community) and a Save button. The rows delegate to the
// existing btnShare/btnExport/btnPublish click handlers in main.ts — this
// module only owns the one piece of DOM behavior specific to the dialog
// itself: the inline "TCX" link sits inside the Export row's own clickable
// area, so it needs to stop the click from also firing the row (which
// exports GPX).
import type { DialogSheetHandle } from './dialogSheet';

export function wireAltFormatButton(altFormatButton: HTMLButtonElement): void {
  altFormatButton.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

/** Opens the dialog and moves focus to the name field, as a real dialog should. */
export function openSaveExportSheet(dialog: DialogSheetHandle, nameInput: HTMLInputElement): void {
  dialog.open();
  nameInput.focus();
}
