// The mobile planner's screen state machine: which of Plan / Generating /
// Candidates / Route detail / Build-your-own is in front. Mobile-only by
// design — desktop shows the sidebar form and the candidate list together,
// with no "screens" to switch between (see style.css: everything this module
// touches is forced visible above the 700px breakpoint via CSS, regardless
// of the `hidden` attribute this module sets).
export type PlannerScreen = 'plan' | 'generating' | 'candidates' | 'detail' | 'build';

export interface PlannerScreenElements {
  plan: HTMLElement;
  generating: HTMLElement;
  candidates: HTMLElement;
  detail: HTMLElement;
  build: HTMLElement;
}

let current: PlannerScreen = 'plan';
let elements: PlannerScreenElements | null = null;
let onChange: ((screen: PlannerScreen) => void) | null = null;

export function initPlannerScreens(
  els: PlannerScreenElements,
  changeCallback?: (screen: PlannerScreen) => void,
): void {
  elements = els;
  onChange = changeCallback ?? null;
  apply();
}

export function getPlannerScreen(): PlannerScreen {
  return current;
}

export function setPlannerScreen(screen: PlannerScreen): void {
  current = screen;
  apply();
  onChange?.(screen);
}

function apply(): void {
  if (!elements) return;
  (Object.keys(elements) as (keyof PlannerScreenElements)[]).forEach((key) => {
    elements![key].hidden = key !== current;
  });
  // A few pieces (#loop-options, #controls, #build-actions) are shared across
  // screens rather than duplicated per screen, so their own CSS keys off this
  // attribute instead of a dedicated hidden toggle. See style.css.
  document.getElementById('tab-planner')?.setAttribute('data-planner-screen', current);
}
