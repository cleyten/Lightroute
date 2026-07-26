// Round-trip generation, off the UI thread.
//
// Generating loops is the app's one genuinely heavy operation: eight ORS
// candidates, up to six BRouter heals each, and repeated O(n²) geometry passes
// over routes with thousands of points. On the main thread that froze the map
// and made even a progress animation stutter, so the whole pipeline runs here
// instead.
//
// This works because ors.ts and everything it imports touch only fetch and
// plain data, never the DOM. surface.ts does build elements, but only in its
// renderer, which this path never calls.

import { generateRoundTrips, type HillPreference, type RoundTripResult } from './ors';
import type { LngLat } from './routing';

export interface RoundTripRequest {
  start: LngLat;
  minMeters: number;
  maxMeters: number;
  bike: string;
  hills: HillPreference;
}

export type RoundTripResponse =
  | { type: 'progress'; done: number; total: number; phase: string }
  | { type: 'result'; result: RoundTripResult }
  | { type: 'error'; message: string };

self.addEventListener('message', (event: MessageEvent<RoundTripRequest>) => {
  const { start, minMeters, maxMeters, bike, hills } = event.data;

  const post = (message: RoundTripResponse): void => self.postMessage(message);

  void generateRoundTrips(start, minMeters, maxMeters, bike, hills, (done, total, phase) =>
    post({ type: 'progress', done, total, phase }),
  )
    .then((result) => post({ type: 'result', result }))
    .catch((error: unknown) =>
      // Error objects do not survive structured cloning intact, so send the
      // message the UI would have shown anyway.
      post({
        type: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      }),
    );
});
