import type { Cents } from './money.js';

export interface Product {
  id: string;
  name: string;
  priceCents: Cents;
  stock: number;
}

export type CartStatus = 'OPEN' | 'CHECKING_OUT' | 'CHECKED_OUT';

export interface Cart {
  id: string;
  status: CartStatus;
  items: Map<string, number>;
  orderId: string | null;
  createdAt: string;
}

export interface OrderLine {
  productId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface Order {
  id: string;
  number: number;
  cartId: string;
  lines: OrderLine[];
  subtotalCents: Cents;
  coupon: { code: string; percentOff: number } | null;
  discountCents: Cents;
  totalCents: Cents;
  paymentReference: string;
  createdAt: string;
}

export type CouponStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED';

export interface Coupon {
  code: string;
  percentOff: number;
  milestone: number;
  status: CouponStatus;
  orderId: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

export interface IdempotencyRecord {
  fingerprint: string;
  result: Promise<Order>;
}

export class Store {
  readonly products = new Map<string, Product>();
  readonly carts = new Map<string, Cart>();
  readonly orders = new Map<string, Order>();
  readonly coupons = new Map<string, Coupon>();
  readonly checkoutKeys = new Map<string, IdempotencyRecord>();

  constructor(products: Product[] = []) {
    for (const p of products) this.products.set(p.id, { ...p });
  }
}

export const seedProducts: Product[] = [
  { id: 'sku_tshirt', name: 'Cotton T-Shirt', priceCents: 1999, stock: 100 },
  { id: 'sku_hoodie', name: 'Zip Hoodie', priceCents: 4950, stock: 40 },
  { id: 'sku_mug', name: 'Ceramic Mug', priceCents: 1250, stock: 200 },
  { id: 'sku_cap', name: 'Baseball Cap', priceCents: 1599, stock: 60 },
  { id: 'sku_backpack', name: 'Travel Backpack', priceCents: 8999, stock: 25 },
  { id: 'sku_sneaker_ltd', name: 'Limited Edition Sneaker', priceCents: 15000, stock: 3 },
];
