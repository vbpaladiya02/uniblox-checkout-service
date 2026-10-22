import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { discountFor } from '../money.js';
import type { PaymentGateway } from '../payments.js';
import type { Cart, Coupon, Order, OrderLine, Store } from '../store.js';

export interface CheckoutResult {
  order: Order;
  replayed: boolean;
}

interface Reservation {
  cart: Cart;
  lines: OrderLine[];
  coupon: Coupon | null;
}

export class CheckoutService {
  constructor(
    private readonly store: Store,
    private readonly payments: PaymentGateway,
  ) {}

  async checkout(cartId: string, couponCode: string | undefined, idempotencyKey: string): Promise<CheckoutResult> {
    const code = couponCode?.trim().toUpperCase() || null;
    const fingerprint = JSON.stringify([cartId, code]);

    const existing = this.store.checkoutKeys.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      }
      return { order: await existing.result, replayed: true };
    }

    // Registered before the first await so a retry that arrives mid-payment
    // waits on this same attempt instead of starting a second one.
    const result = this.placeOrder(cartId, code);
    this.store.checkoutKeys.set(idempotencyKey, { fingerprint, result });

    try {
      return { order: await result, replayed: false };
    } catch (err) {
      // Only successes are remembered; a failed attempt can be retried with the same key.
      this.store.checkoutKeys.delete(idempotencyKey);
      throw err;
    }
  }

  getOrder(orderId: string): Order {
    const order = this.store.orders.get(orderId);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    return order;
  }

  private async placeOrder(cartId: string, couponCode: string | null): Promise<Order> {
    // Everything up to the payment call runs synchronously, which makes
    // validate + reserve atomic on Node's single thread.
    const reservation = this.reserve(cartId, couponCode);
    const { cart, lines, coupon } = reservation;

    const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const discountCents = coupon ? discountFor(subtotalCents, coupon.percentOff) : 0;
    const totalCents = subtotalCents - discountCents;

    let paymentId: string;
    try {
      ({ id: paymentId } = await this.payments.charge({ reference: cart.id, amountCents: totalCents }));
    } catch (err) {
      this.release(reservation);
      throw new AppError(402, 'PAYMENT_FAILED', 'Payment was declined', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const order: Order = {
      id: randomUUID(),
      number: this.store.orders.size + 1,
      cartId: cart.id,
      lines,
      subtotalCents,
      coupon: coupon && { code: coupon.code, percentOff: coupon.percentOff },
      discountCents,
      totalCents,
      paymentReference: paymentId,
      createdAt: new Date().toISOString(),
    };
    this.store.orders.set(order.id, order);

    cart.status = 'CHECKED_OUT';
    cart.orderId = order.id;
    if (coupon) {
      coupon.status = 'REDEEMED';
      coupon.orderId = order.id;
      coupon.redeemedAt = order.createdAt;
    }
    return order;
  }

  private reserve(cartId: string, couponCode: string | null): Reservation {
    const cart = this.store.carts.get(cartId);
    if (!cart) throw new AppError(404, 'CART_NOT_FOUND', `Cart ${cartId} not found`);
    if (cart.status === 'CHECKED_OUT') {
      throw new AppError(409, 'CART_ALREADY_CHECKED_OUT', 'Cart has already been checked out', {
        orderId: cart.orderId,
      });
    }
    if (cart.status === 'CHECKING_OUT') {
      throw new AppError(409, 'CHECKOUT_IN_PROGRESS', 'A checkout for this cart is already in progress');
    }
    if (cart.items.size === 0) throw new AppError(422, 'CART_EMPTY', 'Cannot check out an empty cart');

    const lines: OrderLine[] = [];
    const shortages: { productId: string; requested: number; available: number }[] = [];
    for (const [productId, quantity] of cart.items) {
      const product = this.store.products.get(productId);
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
      if (product.stock < quantity) {
        shortages.push({ productId, requested: quantity, available: product.stock });
        continue;
      }
      lines.push({
        productId,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity,
        lineTotalCents: product.priceCents * quantity,
      });
    }
    if (shortages.length > 0) {
      throw new AppError(409, 'INSUFFICIENT_INVENTORY', 'Some items are no longer available in the requested quantity', {
        items: shortages,
      });
    }

    const coupon = couponCode ? this.claimableCoupon(couponCode) : null;

    for (const line of lines) this.store.products.get(line.productId)!.stock -= line.quantity;
    if (coupon) coupon.status = 'RESERVED';
    cart.status = 'CHECKING_OUT';

    return { cart, lines, coupon };
  }

  private release({ cart, lines, coupon }: Reservation) {
    for (const line of lines) this.store.products.get(line.productId)!.stock += line.quantity;
    if (coupon) coupon.status = 'AVAILABLE';
    cart.status = 'OPEN';
  }

  private claimableCoupon(code: string): Coupon {
    const coupon = this.store.coupons.get(code);
    if (!coupon) throw new AppError(422, 'INVALID_COUPON', `Coupon ${code} does not exist`);
    if (coupon.status === 'REDEEMED') {
      throw new AppError(409, 'COUPON_ALREADY_REDEEMED', `Coupon ${code} has already been used`);
    }
    if (coupon.status === 'RESERVED') {
      throw new AppError(409, 'COUPON_IN_USE', `Coupon ${code} is being used by another checkout`);
    }
    return coupon;
  }
}
