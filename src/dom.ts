// Every element handle the app holds, resolved once at startup.
//
// These are non-null asserted on purpose: all of them are static markup in
// index.html, so a missing one is a build-time mistake, not a runtime
// condition worth branching on. Keeping them in one place makes it obvious
// which ids the code depends on, and keeps main.ts free of eighty
// querySelector lines.

const el = <T extends Element>(selector: string): T =>
  document.querySelector<T>(selector)!;

const all = <T extends Element>(selector: string): T[] => [
  ...document.querySelectorAll<T>(selector),
];

// Route detail: a full-screen mobile view and a floating desktop panel, both
// built entirely by routeDetailView.ts (see its file comment) rather than
// exposing a fixed sub-element schema here.
export const routeDetailMobile = el<HTMLElement>('#route-detail-mobile');
export const routeDetailPanel = el<HTMLElement>('#route-detail-panel');

// Mobile planner screens (plannerScreen.ts): plan / generating / candidates / build.
export const screenPlan = el<HTMLElement>('#screen-plan');
export const screenGenerating = el<HTMLElement>('#screen-generating');
export const screenCandidates = el<HTMLElement>('#screen-candidates');
export const screenBuild = el<HTMLElement>('#screen-build');
export const btnCancelGenerate = el<HTMLButtonElement>('#btn-cancel-generate');
export const candidateDotsEl = el<HTMLElement>('#candidate-dots');
export const btnCandidatesBack = el<HTMLButtonElement>('#btn-candidates-back');
export const candidatesHeadingEl = el<HTMLElement>('#candidates-heading');
export const candidatesHeadingText = el<HTMLElement>('#candidates-heading-text');
export const btnChangeCandidates = el<HTMLButtonElement>('#btn-change-candidates');
export const btnBookmarkLoop = el<HTMLButtonElement>('#btn-bookmark-loop');
export const btnUseLoop = el<HTMLButtonElement>('#btn-use-loop');
export const buildDistance = el<HTMLElement>('#build-distance');
export const buildAscend = el<HTMLElement>('#build-ascend');
export const buildPoints = el<HTMLElement>('#build-points');
export const controlsEl = el<HTMLElement>('#controls');
export const buildActionsEl = el<HTMLElement>('#build-actions');
export const btnBuildBack = el<HTMLButtonElement>('#btn-build-back');
export const btnCloseLoop = el<HTMLButtonElement>('#btn-close-loop');
export const btnBuildDone = el<HTMLButtonElement>('#btn-build-done');

// Route controls
export const btnUndo = el<HTMLButtonElement>('#btn-undo');
export const btnClear = el<HTMLButtonElement>('#btn-clear');
export const btnReverse = el<HTMLButtonElement>('#btn-reverse');
export const btnExport = el<HTMLButtonElement>('#btn-export');
export const btnExportTcx = el<HTMLButtonElement>('#btn-export-tcx');
export const btnSave = el<HTMLButtonElement>('#btn-save');
export const btnShare = el<HTMLButtonElement>('#btn-share');
export const routeNameInput = el<HTMLInputElement>('#route-name');
export const savedList = el<HTMLUListElement>('#saved-list');

// Community: Discover/Your-library segment (librarySheet.ts)
export const communitySegmentEl = el<HTMLElement>('#community-segment');
export const communityDiscoverEl = el<HTMLElement>('#community-discover');
export const communityLibraryEl = el<HTMLElement>('#community-library');
export const libraryTabButtons = all<HTMLButtonElement>('.library-tab');
export const publishedList = el<HTMLUListElement>('#published-list');
export const accountAvatar = el<HTMLElement>('#account-avatar');

// Bike, traffic and hills
export const bikeButtons = all<HTMLButtonElement>('#bike-type button');
export const hillsButtons = all<HTMLButtonElement>('#hills-type button');
export const trafficLabel = el<HTMLElement>('#traffic-label');
export const trafficSelect = el<HTMLSelectElement>('#traffic-select');

// Round trip
export const roundtripMin = el<HTMLInputElement>('#roundtrip-min');
export const roundtripMax = el<HTMLInputElement>('#roundtrip-max');
export const rangeValue = el<HTMLElement>('#range-value');
export const rangeTrack = el<HTMLElement>('#range-track');
export const btnRoundtrip = el<HTMLButtonElement>('#btn-roundtrip');
export const loopOptionsEl = el<HTMLElement>('#loop-options');
export const windChipEl = el<HTMLElement>('#wind-chip');


// Search, location and import
export const searchInput = el<HTMLInputElement>('#search-input');
export const searchResults = el<HTMLUListElement>('#search-results');
export const btnLocate = el<HTMLButtonElement>('#btn-locate');
export const btnImportGpx = el<HTMLButtonElement>('#btn-import-gpx');
export const gpxFileInput = el<HTMLInputElement>('#gpx-file-input');

// Cafés/water are fetched automatically now (see fetchPoisIfNeeded in
// main.ts) and shown only in routeDetailView.ts's Stops tab, which builds
// its own DOM — there is no #cafes/#water find-along-route UI left to
// resolve handles for.

// Tabs. The mobile bottom bar mirrors the top tabs; both drive setActiveTab.
export const mainTabs = el<HTMLElement>('#main-tabs');
export const mainTabButtons = all<HTMLButtonElement>('#main-tabs .main-tab');
export const bottomTabButtons = all<HTMLButtonElement>('#bottom-nav .bottom-tab');
export const plannerPanel = el<HTMLElement>('#tab-planner');
export const communityPanel = el<HTMLElement>('#tab-community');

// Community: account and the emailed-code sign-in flow
export const accountSignedOut = el<HTMLElement>('#account-signed-out');
export const accountSignedIn = el<HTMLElement>('#account-signed-in');
export const accountEmail = el<HTMLInputElement>('#account-email');
export const btnSignin = el<HTMLButtonElement>('#btn-signin');
export const accountCode = el<HTMLInputElement>('#account-code');
export const btnVerify = el<HTMLButtonElement>('#btn-verify');
export const emailRow = el<HTMLElement>('#email-row');
export const codeRow = el<HTMLElement>('#code-row');
export const signinHint = el<HTMLElement>('#signin-hint');
export const btnSigninBack = el<HTMLButtonElement>('#btn-signin-back');
/** Captured before any flow overwrites it, so the form can be reset. */
export const DEFAULT_SIGNIN_HINT = signinHint.textContent ?? '';
export const accountName = el<HTMLElement>('#account-name');
export const btnSignout = el<HTMLButtonElement>('#btn-signout');
export const authorField = el<HTMLElement>('#author-field');
export const authorNameInput = el<HTMLInputElement>('#author-name');

// Community: library
export const btnPublish = el<HTMLButtonElement>('#btn-publish');
export const communitySortButtons = all<HTMLButtonElement>('#community-sort button');
export const communityBikeButtons = all<HTMLButtonElement>('#community-bike button');
export const communityHillsButtons = all<HTMLButtonElement>('#community-hills button');
export const communityDistMin = el<HTMLInputElement>('#community-dist-min');
export const communityDistMax = el<HTMLInputElement>('#community-dist-max');
export const communityDistValue = el<HTMLElement>('#community-dist-value');
export const communityDistTrack = el<HTMLElement>('#community-dist-track');
export const communityList = el<HTMLUListElement>('#community-list');

// Sort & Filter dialog (sortFilterSheet.ts / dialogSheet.ts)
export const btnOpenFilters = el<HTMLButtonElement>('#btn-open-filters');
export const sortFilterBackdrop = el<HTMLElement>('#sort-filter-backdrop');
export const sortFilterSheetEl = el<HTMLElement>('#sort-filter-sheet');
export const btnResetFilters = el<HTMLButtonElement>('#btn-reset-filters');
export const btnApplyFilters = el<HTMLButtonElement>('#btn-apply-filters');

// Plan setting dialog (planRows.ts / dialogSheet.ts)
export const planSettingBackdrop = el<HTMLElement>('#plan-setting-backdrop');
export const planSettingSheetEl = el<HTMLElement>('#plan-setting-sheet');
export const btnPlanSettingDone = el<HTMLButtonElement>('#btn-plan-setting-done');

// Save/Export dialog (saveExportSheet.ts / dialogSheet.ts)
export const btnOpenSaveExport = el<HTMLButtonElement>('#btn-open-save-export');
export const saveExportBackdrop = el<HTMLElement>('#save-export-backdrop');
export const saveExportSheetEl = el<HTMLElement>('#save-export-sheet');
