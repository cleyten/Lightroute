import { describe, expect, it } from 'vitest';
import { estimateMovingTimeHours, formatRideTime } from './rideTime';

describe('estimateMovingTimeHours', () => {
  it('takes longer for a slower bike type over the same distance', () => {
    const race = estimateMovingTimeHours(40, 0, 'race');
    const mtb = estimateMovingTimeHours(40, 0, 'mtb');
    expect(mtb).toBeGreaterThan(race);
  });

  it('takes longer when a route climbs more, distance held equal', () => {
    const flat = estimateMovingTimeHours(40, 0, 'race');
    const hilly = estimateMovingTimeHours(40, 500, 'race');
    expect(hilly).toBeGreaterThan(flat);
  });
});

describe('formatRideTime', () => {
  it('formats hours as H:MM', () => {
    expect(formatRideTime(1 + 38 / 60)).toBe('1:38');
    expect(formatRideTime(0.5)).toBe('0:30');
  });

  it('rounds minutes that roll over into the next hour', () => {
    expect(formatRideTime(1 + 59.6 / 60)).toBe('2:00');
  });
});
