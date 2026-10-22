# Checkout & Rewards Service

Backend for a small store: carts, checkout and orders, plus a reward coupon after every *n*th order. The focus is on keeping orders, inventory and coupons consistent when requests are retried or overlap.

Design notes, invariants and trade-offs are in [DECISIONS.md](DECISIONS.md).

## Stack

- Node.js 20+, TypeScript, Express 5
- zod for request validation
- In-memory store, seeded at startup
- Tests: `node:test` + supertest, run through tsx

## Running

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # with reload
npm test
npm run typecheck
```

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `COUPON_EVERY_N_ORDERS` | `5` | `n`: one coupon per n successful orders |
| `COUPON_PERCENT_OFF` | `10` | `x`: percentage discount (1–100) |
| `PAYMENT_LATENCY_MS` | `50` | Simulated payment delay, makes overlapping checkouts realistic |

Seeded products: `sku_tshirt`, `sku_hoodie`, `sku_mug`, `sku_cap`, `sku_backpack`, and `sku_sneaker_ltd` (stock 3). Restarting resets all data.

[requests.http](requests.http) walks through the main flow and works with the VS Code REST Client or JetBrains HTTP client.

## Conventions

- All money is in **integer cents** (`priceCents`, `totalCents`, ...).
- Errors always have this shape:

  ```json
  { "error": { "code": "INSUFFICIENT_INVENTORY", "message": "...", "details": { } } }
  ```

  Clients should branch on `code`, not on `message`.

## API

### Catalog

| Method | Path | Success | Notes |
|---|---|---|---|
| GET | `/products` | 200 `{ items: Product[] }` | |

### Carts

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/carts` | – | 201 Cart | |
| GET | `/carts/:cartId` | – | 200 Cart | 404 `CART_NOT_FOUND` |
| POST | `/carts/:cartId/items` | `{ productId, quantity }` | 200 Cart | 400 `VALIDATION_ERROR`, 404 `PRODUCT_NOT_FOUND`, 409 `INSUFFICIENT_INVENTORY`, 409 `CART_NOT_OPEN` |
| PATCH | `/carts/:cartId/items/:productId` | `{ quantity }` | 200 Cart | same, plus 404 `ITEM_NOT_IN_CART` |
| DELETE | `/carts/:cartId/items/:productId` | – | 200 Cart | 404 `ITEM_NOT_IN_CART`, 409 `CART_NOT_OPEN` |

`POST .../items` adds to the existing quantity. `PATCH` sets it. Quantities must be positive integers, at most 99 per product.

Cart response:

```json
{
  "id": "…",
  "status": "OPEN",
  "orderId": null,
  "items": [
    { "productId": "sku_mug", "name": "Ceramic Mug", "quantity": 2, "unitPriceCents": 1250, "lineTotalCents": 2500, "inStock": true }
  ],
  "itemCount": 2,
  "subtotalCents": 2500
}
```

Prices in the cart are always the **current** product prices. `inStock` is `false` if stock has dropped below the quantity in the cart.

### Checkout and orders

```
POST /carts/:cartId/checkout
Idempotency-Key: <client-generated, unique per checkout attempt>
{ "couponCode": "SAVE-1A2B3C4D" }      // optional
```

| Status | Code | When |
|---|---|---|
| 201 | – | Order created. A retry with the same key returns the same order with `Idempotent-Replayed: true` |
| 400 | `VALIDATION_ERROR` | Missing `Idempotency-Key` or bad body |
| 402 | `PAYMENT_FAILED` | Payment declined. Stock and coupon are released; retry is safe |
| 404 | `CART_NOT_FOUND` / `PRODUCT_NOT_FOUND` | |
| 409 | `INSUFFICIENT_INVENTORY` | `details.items` lists each short product |
| 409 | `CART_ALREADY_CHECKED_OUT` | `details.orderId` points to the existing order |
| 409 | `CHECKOUT_IN_PROGRESS` | Another checkout of this cart (with a different key) is running |
| 409 | `COUPON_ALREADY_REDEEMED` / `COUPON_IN_USE` | |
| 422 | `CART_EMPTY` / `INVALID_COUPON` | |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key sent with a different cart or coupon |

Order response:

```json
{
  "id": "…",
  "number": 6,
  "cartId": "…",
  "lines": [{ "productId": "sku_backpack", "name": "Travel Backpack", "unitPriceCents": 8999, "quantity": 1, "lineTotalCents": 8999 }],
  "subtotalCents": 8999,
  "coupon": { "code": "SAVE-1A2B3C4D", "percentOff": 10 },
  "discountCents": 900,
  "totalCents": 8099,
  "paymentReference": "pay_…",
  "createdAt": "…"
}
```

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/orders/:orderId` | 200 Order | 404 `ORDER_NOT_FOUND` |

### Admin

These are the administrative operations. There's no auth here; in a real deployment they'd sit behind an admin role or a separate internal service.

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/admin/coupons` | 201 Coupon | 409 `NO_ELIGIBLE_MILESTONE` (`details.nextMilestoneAt`) |
| GET | `/admin/coupons` | 200 `{ items: Coupon[] }` | |
| GET | `/admin/report` | 200 Report | |
| PATCH | `/admin/products/:productId` | 200 Product | 400, 404. Body `{ priceCents?, stock? }`, used to simulate price and stock changes |

Report response:

```json
{
  "ordersPlaced": 5,
  "itemsPurchased": [{ "productId": "sku_mug", "name": "Ceramic Mug", "quantity": 4, "grossCents": 5000 }],
  "totalItemsPurchased": 9,
  "grossRevenueCents": 40940,
  "totalDiscountCents": 900,
  "netRevenueCents": 40040,
  "coupons": { "generated": 1, "available": 0, "reserved": 0, "redeemed": 1, "codes": [] }
}
```

## Project layout

```
src/
  app.ts              routes, validation, error mapping
  server.ts           entry point
  config.ts           env config
  store.ts            in-memory state + seed data
  money.ts            cents math
  payments.ts         payment gateway interface + fake
  services/
    carts.ts          cart operations
    checkout.ts       reservation, payment, commit/rollback, idempotency
    coupons.ts        milestone-based coupon generation
    report.ts         admin summary
test/
  checkout.test.ts    concurrency, retries, failures, coupons, reporting
  money.test.ts
```
