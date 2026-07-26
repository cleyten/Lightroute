// Thin wrapper around the round-trip worker.
//
// Presents the same shape as calling generateRoundTrips() directly, so the UI
// does not need to know a worker is involved, and falls back to running on the
// main thread where module workers are unavailable (older iOS Safari, and any
// environment that blocks them). The fallback is slower to the eye, not
// broken: it is exactly the behaviour this replaced.

import type { HillPreference, ProgressReporter, RoundTripResult } from './ors';
import type { LngLat } from './routing';
import type { RoundTripRequest, RoundTripResponse } from './roundtrip.worker';

export interface RoundTripOptions {
  start: LngLat;
  minMeters: number;
  maxMeters: number;
  bike: string;
  hills: HillPreference;
  onProgress?: ProgressReporter;
  /** Abort an in-flight generation; the worker is terminated. */
  signal?: AbortSignal;
}

export class RoundTripCancelledError extends Error {
  constructor() {
    super('Round trip generation cancelled.');
    this.name = 'RoundTripCancelledError';
  }
}

function createWorker(): Worker | null {
  try {
    return new Worker(new URL('./roundtrip.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

export function generateRoundTripsAsync(options: RoundTripOptions): Promise<RoundTripResult> {
  const { onProgress = () => {}, signal } = options;

  const worker = createWorker();
  if (!worker) {
    // No worker: run inline. Imported lazily so the fallback path does not pull
    // ors.ts (and its dependency tree) into the main bundle for everyone else.
    return import('./ors').then(({ generateRoundTrips }) =>
      generateRoundTrips(
        options.start,
        options.minMeters,
        options.maxMeters,
        options.bike,
        options.hills,
        onProgress,
      ),
    );
  }

  return new Promise<RoundTripResult>((resolve, reject) => {
    const cleanup = (): void => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };

    function onAbort(): void {
      cleanup();
      reject(new RoundTripCancelledError());
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);

    worker.addEventListener('message', (event: MessageEvent<RoundTripResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.done, message.total, message.phase);
        return;
      }
      cleanup();
      if (message.type === 'result') resolve(message.result);
      else reject(new Error(message.message));
    });

    worker.addEventListener('error', (event) => {
      cleanup();
      reject(new Error(event.message || 'Round trip generation failed.'));
    });

    const request: RoundTripRequest = {
      start: options.start,
      minMeters: options.minMeters,
      maxMeters: options.maxMeters,
      bike: options.bike,
      hills: options.hills,
    };
    worker.postMessage(request);
  });
}
