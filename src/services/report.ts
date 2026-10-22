import type { Store } from '../store.js';

export function buildReport(store: Store) {
  const byProduct = new Map<string, { productId: string; name: string; quantity: number; grossCents: number }>();
  let grossRevenueCents = 0;
  let totalDiscountCents = 0;

  for (const order of store.orders.values()) {
    grossRevenueCents += order.subtotalCents;
    totalDiscountCents += order.discountCents;
    for (const line of order.lines) {
      const row = byProduct.get(line.productId) ?? { productId: line.productId, name: line.name, quantity: 0, grossCents: 0 };
      row.quantity += line.quantity;
      row.grossCents += line.lineTotalCents;
      byProduct.set(line.productId, row);
    }
  }

  const coupons = [...store.coupons.values()];
  const count = (status: string) => coupons.filter((c) => c.status === status).length;

  return {
    ordersPlaced: store.orders.size,
    itemsPurchased: [...byProduct.values()].sort((a, b) => a.productId.localeCompare(b.productId)),
    totalItemsPurchased: [...byProduct.values()].reduce((n, r) => n + r.quantity, 0),
    grossRevenueCents,
    totalDiscountCents,
    netRevenueCents: grossRevenueCents - totalDiscountCents,
    coupons: {
      generated: coupons.length,
      available: count('AVAILABLE'),
      reserved: count('RESERVED'),
      redeemed: count('REDEEMED'),
      codes: coupons.map((c) => ({ code: c.code, status: c.status, percentOff: c.percentOff })),
    },
  };
}
