import { describe, expect, it } from 'vitest';
import { isValidWaypoints, sanitizeWaypoints } from './waypoints';

const valid = [
  [5.4697, 51.4416],
  [5.51, 51.46],
];

describe('isValidWaypoints', () => {
  it('accepts a plain two-point list', () => {
    expect(isValidWaypoints(valid)).toBe(true);
  });

  it('accepts pairs carrying a third element, as routed coordinates do', () => {
    expect(isValidWaypoints([[5, 51, 12], [6, 52, 30]])).toBe(true);
  });

  it.each([
    ['not an array', { w: 1 }],
    ['null', null],
    ['undefined', undefined],
    ['empty', []],
    ['a single point', [[5, 51]]],
    ['a non-array member', [[5, 51], 'nope']],
    ['a short pair', [[5, 51], [6]]],
    ['string coordinates', [['5', '51'], ['6', '52']]],
    ['null coordinates', [[null, null], [null, null]]],
    ['NaN', [[NaN, 51], [6, 52]]],
    ['Infinity', [[Infinity, 51], [6, 52]]],
    ['an out-of-range longitude', [[181, 51], [6, 52]]],
    ['an out-of-range latitude', [[5, 91], [6, 52]]],
  ])('rejects %s', (_label, input) => {
    expect(isValidWaypoints(input)).toBe(false);
  });

  it('rejects an implausibly long list', () => {
    const huge = Array.from({ length: 501 }, () => [5, 51]);
    expect(isValidWaypoints(huge)).toBe(false);
    expect(isValidWaypoints(huge.slice(0, 500))).toBe(true);
  });

  it('accepts the extremes of the valid range', () => {
    expect(isValidWaypoints([[-180, -90], [180, 90]])).toBe(true);
  });
});

describe('sanitizeWaypoints', () => {
  it('returns null for invalid input', () => {
    expect(sanitizeWaypoints('garbage')).toBeNull();
    expect(sanitizeWaypoints([[NaN, 0], [1, 1]])).toBeNull();
  });

  it('copies rather than aliasing, so editing a route cannot corrupt the record', () => {
    const stored = [[5, 51], [6, 52]];
    const out = sanitizeWaypoints(stored)!;
    out[0][0] = 99;
    expect(stored[0][0]).toBe(5);
  });

  it('trims a third element down to a plain pair', () => {
    expect(sanitizeWaypoints([[5, 51, 12], [6, 52, 30]])).toEqual([[5, 51], [6, 52]]);
  });
});
