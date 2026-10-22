import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discountFor, percentOf } from '../src/money.js';

describe('money', () => {
  it('rounds half up in integer cents', () => {
    assert.equal(percentOf(1999, 10), 200); // 199.9
    assert.equal(percentOf(1995, 10), 200); // 199.5
    assert.equal(percentOf(1994, 10), 199); // 199.4
    assert.equal(percentOf(5, 10), 1); // 0.5
  });

  it('handles fractional-cent results deterministically', () => {
    // 59.97 * 15% = 8.9955
    assert.equal(percentOf(3 * 1999, 15), 900);
  });

  it('never discounts more than the subtotal', () => {
    assert.equal(discountFor(1000, 100), 1000);
    assert.equal(discountFor(0, 50), 0);
  });
});
