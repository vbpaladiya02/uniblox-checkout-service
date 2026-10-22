export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'PRODUCT_NOT_FOUND'
  | 'CART_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ITEM_NOT_IN_CART'
  | 'CART_NOT_OPEN'
  | 'CART_EMPTY'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'CHECKOUT_IN_PROGRESS'
  | 'INSUFFICIENT_INVENTORY'
  | 'INVALID_COUPON'
  | 'COUPON_ALREADY_REDEEMED'
  | 'COUPON_IN_USE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PAYMENT_FAILED'
  | 'NO_ELIGIBLE_MILESTONE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
