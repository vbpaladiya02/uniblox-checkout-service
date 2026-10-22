export type Cents = number;

// Rounds half up. Integer math only, safe while amount * percent < 2^53.
export function percentOf(amount: Cents, percent: number): Cents {
  return Math.floor((amount * percent + 50) / 100);
}

export function discountFor(subtotal: Cents, percentOff: number): Cents {
  return Math.min(percentOf(subtotal, percentOff), subtotal);
}
