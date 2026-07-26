// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://cleyten.github.io/Lightroute/?old=1#frag"}
import { describe, expect, it } from 'vitest';
import { buildShareUrl, parseShareUrl, type SharePayload } from './share';

const payload: SharePayload = {
  waypoints: [
    [5.4697, 51.4416],
    [5.51, 51.46],
    [5.55, 51.48],
  ],
  bike: 'gravel',
  traffic: 2,
  closed: true,
};

/** Extracts the query string from a built share URL. */
const searchOf = (url: string) => new URL(url).search;

describe('buildShareUrl', () => {
  it('drops any pre-existing query and fragment', () => {
    const url = new URL(buildShareUrl(payload));
    expect(url.hash).toBe('');
    expect(url.searchParams.has('old')).toBe(false);
    expect(url.searchParams.has('r')).toBe(true);
    expect(url.pathname).toBe('/Lightroute/');
  });

  it('produces a link short enough to paste anywhere', () => {
    const long: SharePayload = {
      ...payload,
      waypoints: Array.from({ length: 12 }, (_, i) => [5.4 + i * 0.01, 51.4 + i * 0.01]),
    };
    expect(buildShareUrl(long).length).toBeLessThan(500);
  });

  it('uses only URL-safe base64 characters', () => {
    const r = new URL(buildShareUrl(payload)).searchParams.get('r')!;
    expect(r).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('parseShareUrl', () => {
  it('round-trips a payload', () => {
    const parsed = parseShareUrl(searchOf(buildShareUrl(payload)));
    expect(parsed).not.toBeNull();
    expect(parsed!.bike).toBe('gravel');
    expect(parsed!.traffic).toBe(2);
    expect(parsed!.closed).toBe(true);
    expect(parsed!.waypoints).toHaveLength(3);
    parsed!.waypoints.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(payload.waypoints[i][0], 5);
      expect(lat).toBeCloseTo(payload.waypoints[i][1], 5);
    });
  });

  it('round-trips an open route too', () => {
    const open = { ...payload, closed: false, bike: 'race', traffic: 0 };
    expect(parseShareUrl(searchOf(buildShareUrl(open)))!.closed).toBe(false);
  });

  it('returns null when there is no share parameter', () => {
    expect(parseShareUrl('')).toBeNull();
    expect(parseShareUrl('?other=1')).toBeNull();
  });

  it('returns null for a corrupt payload rather than throwing', () => {
    expect(parseShareUrl('?r=not-base64!!')).toBeNull();
    expect(parseShareUrl('?r=' + btoa('{"nope":true}'))).toBeNull();
  });

  it('returns null for a truncated link', () => {
    const full = new URL(buildShareUrl(payload)).searchParams.get('r')!;
    expect(parseShareUrl('?r=' + full.slice(0, Math.floor(full.length / 2)))).toBeNull();
  });

  it('rejects a hand-edited payload with unusable coordinates', () => {
    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parseShareUrl('?r=' + encode({ w: [[null, null], [1, 1]], b: 'race', t: 0, c: 0 }))).toBeNull();
    expect(parseShareUrl('?r=' + encode({ w: [['5', '51'], [6, 52]], b: 'race', t: 0, c: 0 }))).toBeNull();
    expect(parseShareUrl('?r=' + encode({ w: [[5, 51]], b: 'race', t: 0, c: 0 }))).toBeNull();
  });

  it('falls back to safe defaults for an unknown bike or traffic level', () => {
    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const parsed = parseShareUrl(
      '?r=' + encode({ w: [[5, 51], [6, 52]], b: 'unicycle', t: 99, c: 0 }),
    );
    expect(parsed!.bike).toBe('race');
    expect(parsed!.traffic).toBe(0);
  });
});
