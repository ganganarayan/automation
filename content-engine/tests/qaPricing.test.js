import { describe, it, expect } from 'vitest';
import { lowestMargin, UNIT_COST_INR } from '../src/utils/marginSpec.js';
import { CHARGEABLE } from '../src/utils/billingSpec.js';

describe('QA pricing margins', () => {
  it('every plan on sale keeps at least 50% in rupees and dollars, yearly the lowest', () => {
    for (const plan of CHARGEABLE) {
      expect(UNIT_COST_INR[plan]).toBeGreaterThan(0);
      for (const cur of ['INR', 'USD']) expect(lowestMargin(plan, cur)).toBeGreaterThanOrEqual(0.5);
    }
    expect(lowestMargin('brand', 'INR')).toBeCloseTo(0.527, 2);
    expect(lowestMargin('agency', 'INR')).toBeGreaterThan(0.6);
  });
});
