import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import type { Coupon, Store } from '../store.js';

export interface CouponPolicy {
  everyNOrders: number;
  percentOff: number;
}

export class CouponService {
  constructor(
    private readonly store: Store,
    private readonly policy: CouponPolicy,
  ) {}

  // Each milestone (n, 2n, 3n, ...) earns exactly one coupon. Generation is
  // synchronous, so two concurrent admin calls cannot both claim the same one.
  generate(): Coupon {
    const ordersPlaced = this.store.orders.size;
    const milestonesReached = Math.floor(ordersPlaced / this.policy.everyNOrders);
    const nextMilestone = this.store.coupons.size + 1;

    if (nextMilestone > milestonesReached) {
      throw new AppError(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone is available', {
        ordersPlaced,
        nextMilestoneAt: nextMilestone * this.policy.everyNOrders,
      });
    }

    const coupon: Coupon = {
      code: this.newCode(),
      percentOff: this.policy.percentOff,
      milestone: nextMilestone * this.policy.everyNOrders,
      status: 'AVAILABLE',
      orderId: null,
      createdAt: new Date().toISOString(),
      redeemedAt: null,
    };
    this.store.coupons.set(coupon.code, coupon);
    return coupon;
  }

  list(): Coupon[] {
    return [...this.store.coupons.values()];
  }

  private newCode(): string {
    let code: string;
    do {
      code = `SAVE-${randomBytes(4).toString('hex').toUpperCase()}`;
    } while (this.store.coupons.has(code));
    return code;
  }
}
