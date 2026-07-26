// Two stacked native range inputs acting as one min-max slider.
//
// Only the thumbs are clickable (the tracks are transparent, see .dual-range in
// style.css), so the visible track is a separate element painted with a
// gradient. Used for the round-trip distance range and the community library's
// length filter, which differ only in how they label the value.

export interface DualRangeOptions {
  min: HTMLInputElement;
  max: HTMLInputElement;
  /** Element showing the current range in words. */
  label: HTMLElement;
  /** Element whose background is painted to show the selected span. */
  track: HTMLElement;
  format: (min: number, max: number) => string;
  /** Called after each user change, once the values have been clamped. */
  onInput?: (min: number, max: number) => void;
}

/**
 * Wires the pair up and paints the initial state. Returns nothing: the inputs
 * remain the source of truth, so callers keep reading their `value` directly.
 */
export function initDualRange(options: DualRangeOptions): void {
  const { min: minEl, max: maxEl, label, track, format, onInput } = options;

  /** Keeps the thumbs from crossing, then repaints label and track. */
  function sync(moved: 'min' | 'max'): void {
    const step = Number(minEl.step) || 5;
    let min = Number(minEl.value);
    let max = Number(maxEl.value);

    // Push the *other* thumb rather than the one being dragged, so the slider
    // never fights the finger that is moving it.
    if (min > max - step) {
      if (moved === 'min') {
        min = max - step;
        minEl.value = String(min);
      } else {
        max = min + step;
        maxEl.value = String(max);
      }
    }

    label.textContent = format(min, max);

    const lo = Number(minEl.min);
    const hi = Number(minEl.max);
    const fromPct = ((min - lo) / (hi - lo)) * 100;
    const toPct = ((max - lo) / (hi - lo)) * 100;
    track.style.background =
      `linear-gradient(to right, var(--color-border) ${fromPct}%, ` +
      `var(--color-accent) ${fromPct}%, var(--color-accent) ${toPct}%, ` +
      `var(--color-border) ${toPct}%)`;
  }

  const handle = (moved: 'min' | 'max') => (): void => {
    sync(moved);
    onInput?.(Number(minEl.value), Number(maxEl.value));
  };

  minEl.addEventListener('input', handle('min'));
  maxEl.addEventListener('input', handle('max'));
  sync('min');
}
