import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FakePaymentGateway, type PaymentGateway } from '../src/payments.js';

const config = { couponEveryNOrders: 2, couponPercentOff: 10 };

function setup(payments: PaymentGateway = new FakePaymentGateway(20)) {
  return createApp({ config, payments });
}

type App = ReturnType<typeof setup>['app'];

let keySeq = 0;
const newKey = () => `key-${++keySeq}`;

async function cartWith(app: App, items: Record<string, number>) {
  const { body: cart } = await request(app).post('/carts').expect(201);
  for (const [productId, quantity] of Object.entries(items)) {
    await request(app).post(`/carts/${cart.id}/items`).send({ productId, quantity }).expect(200);
  }
  return cart.id as string;
}

function checkout(app: App, cartId: string, key = newKey(), couponCode?: string) {
  return request(app)
    .post(`/carts/${cartId}/checkout`)
    .set('Idempotency-Key', key)
    .send(couponCode ? { couponCode } : {});
}

async function placeOrders(app: App, count: number) {
  for (let i = 0; i < count; i++) {
    await checkout(app, await cartWith(app, { sku_mug: 1 })).expect(201);
  }
}

const statuses = (results: { status: number }[]) => results.map((r) => r.status).sort();

describe('checkout', () => {
  it('does not oversell limited stock under concurrent checkouts', async () => {
    const { app, store } = setup();
    const carts = await Promise.all(Array.from({ length: 6 }, () => cartWith(app, { sku_sneaker_ltd: 1 })));

    const results = await Promise.all(carts.map((id) => checkout(app, id)));

    assert.deepEqual(statuses(results), [201, 201, 201, 409, 409, 409]);
    for (const r of results.filter((r) => r.status === 409)) {
      assert.equal(r.body.error.code, 'INSUFFICIENT_INVENTORY');
    }
    assert.equal(store.products.get('sku_sneaker_ltd')!.stock, 0);
  });

  it('turns concurrent retries with the same key into a single order', async () => {
    const { app, store } = setup();
    const cartId = await cartWith(app, { sku_hoodie: 2 });
    const key = newKey();

    const results = await Promise.all([checkout(app, cartId, key), checkout(app, cartId, key), checkout(app, cartId, key)]);

    assert.deepEqual(statuses(results), [201, 201, 201]);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(results.filter((r) => r.headers['idempotent-replayed'] === 'true').length, 2);
    assert.equal(store.orders.size, 1);
    assert.equal(store.products.get('sku_hoodie')!.stock, 38);

    const later = await checkout(app, cartId, key).expect(201);
    assert.equal(later.body.id, results[0]!.body.id);

    const otherKey = await checkout(app, cartId).expect(409);
    assert.equal(otherKey.body.error.code, 'CART_ALREADY_CHECKED_OUT');
    assert.equal(otherKey.body.error.details.orderId, later.body.id);
  });

  it('rejects an idempotency key reused for a different request', async () => {
    const { app } = setup();
    const key = newKey();
    await checkout(app, await cartWith(app, { sku_mug: 1 }), key).expect(201);

    const res = await checkout(app, await cartWith(app, { sku_mug: 1 }), key).expect(422);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('releases stock and coupon when payment fails, and the same key can retry', async () => {
    let declineNext = false;
    const { app, store } = setup(new FakePaymentGateway(5, () => declineNext));
    await placeOrders(app, 2);
    const { body: coupon } = await request(app).post('/admin/coupons').expect(201);

    const cartId = await cartWith(app, { sku_sneaker_ltd: 3 });
    const key = newKey();

    declineNext = true;
    const failed = await checkout(app, cartId, key, coupon.code).expect(402);
    assert.equal(failed.body.error.code, 'PAYMENT_FAILED');
    assert.equal(store.products.get('sku_sneaker_ltd')!.stock, 3);
    assert.equal(store.coupons.get(coupon.code)!.status, 'AVAILABLE');
    assert.equal((await request(app).get(`/carts/${cartId}`)).body.status, 'OPEN');

    declineNext = false;
    const { body: order } = await checkout(app, cartId, key, coupon.code).expect(201);
    assert.equal(order.subtotalCents, 45000);
    assert.equal(order.discountCents, 4500);
    assert.equal(order.totalCents, 40500);
    assert.equal(store.coupons.get(coupon.code)!.status, 'REDEEMED');
  });

  it('lets only one of two concurrent checkouts redeem a coupon', async () => {
    const { app, store } = setup();
    await placeOrders(app, 2);
    const { body: coupon } = await request(app).post('/admin/coupons').expect(201);
    const [a, b] = await Promise.all([cartWith(app, { sku_cap: 1 }), cartWith(app, { sku_tshirt: 1 })]);

    const results = await Promise.all([checkout(app, a, newKey(), coupon.code), checkout(app, b, newKey(), coupon.code)]);

    assert.deepEqual(statuses(results), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.body.error.code, 'COUPON_IN_USE');
    assert.equal(store.coupons.get(coupon.code)!.status, 'REDEEMED');

    const reuse = await checkout(app, await cartWith(app, { sku_mug: 1 }), newKey(), coupon.code).expect(409);
    assert.equal(reuse.body.error.code, 'COUPON_ALREADY_REDEEMED');
  });

  it('prices from checkout time and freezes the order snapshot afterwards', async () => {
    const { app } = setup();
    const cartId = await cartWith(app, { sku_tshirt: 2 });
    await request(app).patch('/admin/products/sku_tshirt').send({ priceCents: 2500 }).expect(200);

    const { body: order } = await checkout(app, cartId).expect(201);
    assert.equal(order.lines[0].unitPriceCents, 2500);
    assert.equal(order.lines[0].lineTotalCents, 5000);

    await request(app).patch('/admin/products/sku_tshirt').send({ priceCents: 100, stock: 0 }).expect(200);
    const { body: stored } = await request(app).get(`/orders/${order.id}`).expect(200);
    assert.equal(stored.lines[0].unitPriceCents, 2500);
    assert.equal(stored.totalCents, 5000);
  });

  it('fails checkout when stock dropped after the item was added', async () => {
    const { app } = setup();
    const cartId = await cartWith(app, { sku_backpack: 5, sku_mug: 1 });
    await request(app).patch('/admin/products/sku_backpack').send({ stock: 2 }).expect(200);

    const res = await checkout(app, cartId).expect(409);
    assert.deepEqual(res.body.error.details.items, [{ productId: 'sku_backpack', requested: 5, available: 2 }]);
  });

  it('locks the cart after checkout', async () => {
    const { app } = setup();
    const cartId = await cartWith(app, { sku_mug: 1 });
    await checkout(app, cartId).expect(201);

    const res = await request(app).post(`/carts/${cartId}/items`).send({ productId: 'sku_mug', quantity: 1 }).expect(409);
    assert.equal(res.body.error.code, 'CART_NOT_OPEN');
  });
});

describe('cart validation', () => {
  it('rejects unknown products, bad quantities and empty checkouts', async () => {
    const { app } = setup();
    const cartId = await cartWith(app, {});
    const add = (body: object) => request(app).post(`/carts/${cartId}/items`).send(body);

    assert.equal((await add({ productId: 'nope', quantity: 1 })).body.error.code, 'PRODUCT_NOT_FOUND');
    assert.equal((await add({ productId: 'sku_mug', quantity: 0 })).status, 400);
    assert.equal((await add({ productId: 'sku_mug', quantity: 1.5 })).status, 400);
    assert.equal((await add({ productId: 'sku_sneaker_ltd', quantity: 4 })).body.error.code, 'INSUFFICIENT_INVENTORY');
    assert.equal((await checkout(app, cartId).expect(422)).body.error.code, 'CART_EMPTY');
    assert.equal((await request(app).post(`/carts/${cartId}/checkout`).send({})).status, 400);

    const { body } = await request(app).get(`/carts/${cartId}`).expect(200);
    assert.deepEqual(body.items, []);
  });
});

describe('coupons and reporting', () => {
  it('generates exactly one coupon per milestone, even when admins race', async () => {
    const { app } = setup();
    await placeOrders(app, 1);
    const early = await request(app).post('/admin/coupons').expect(409);
    assert.deepEqual(early.body.error.details, { ordersPlaced: 1, nextMilestoneAt: 2 });

    await placeOrders(app, 1);
    const results = await Promise.all([1, 2, 3].map(() => request(app).post('/admin/coupons')));
    assert.deepEqual(statuses(results), [201, 409, 409]);
  });

  it('reconciles with orders and does not change on repeated reads', async () => {
    const { app } = setup();
    await checkout(app, await cartWith(app, { sku_tshirt: 2, sku_cap: 1 })).expect(201);
    await checkout(app, await cartWith(app, { sku_tshirt: 1 })).expect(201);
    const { body: coupon } = await request(app).post('/admin/coupons').expect(201);
    await checkout(app, await cartWith(app, { sku_backpack: 1 }), newKey(), coupon.code).expect(201);

    const first = await request(app).get('/admin/report').expect(200);
    const second = await request(app).get('/admin/report').expect(200);
    assert.deepEqual(second.body, first.body);

    const gross = 3 * 1999 + 1599 + 8999;
    const report = first.body;
    assert.equal(report.ordersPlaced, 3);
    assert.equal(report.totalItemsPurchased, 5);
    assert.equal(report.grossRevenueCents, gross);
    assert.equal(report.totalDiscountCents, 900);
    assert.equal(report.netRevenueCents, gross - 900);
    assert.deepEqual(
      { ...report.coupons, codes: undefined },
      { generated: 1, available: 0, reserved: 0, redeemed: 1, codes: undefined },
    );
    assert.equal(report.itemsPurchased.find((r: { productId: string }) => r.productId === 'sku_tshirt').quantity, 3);
  });
});
