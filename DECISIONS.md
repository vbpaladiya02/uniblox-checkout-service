# Decisions

## Invariants

These are the rules the service must never break. Each one has a test.

1. **No overselling.** Product stock never goes below zero, and stock is decremented exactly once per placed order.
2. **One order per cart.** A cart moves `OPEN → CHECKING_OUT → CHECKED_OUT` and can't be modified or checked out again after that.
3. **Retries are safe.** The same `Idempotency-Key` + request produces at most one order, whether the retry arrives during or after the first attempt.
4. **One coupon per milestone.** The k-th coupon can exist only once `k * n` orders have been placed.
5. **A coupon is redeemed at most once**, and a failed checkout never consumes it.
6. **Orders are self-describing.** An order stores name, unit price, quantity, discount and totals at purchase time, so later product changes don't alter it.
7. **Totals add up.** `total = subtotal - discount`, `0 <= discount <= subtotal`, all integers.
8. **The report is derived only from orders and coupons**, and reading it changes nothing.

## Ambiguities and the semantics I picked

| Question | Choice |
|---|---|
| Price changes after an item is added | The cart stores only product + quantity. The cart view shows live prices, and checkout charges the price at checkout time, which is then frozen on the order. Holding a stale price would need a quote/expiry concept, which felt out of scope. |
| Stock drops after an item is added | Adding to the cart does a soft check for early feedback. The real check happens at checkout, which fails with `INSUFFICIENT_INVENTORY` listing every short line, so the client can fix the cart in one round trip. Adding to a cart does **not** hold stock. Otherwise abandoned carts would lock inventory. |
| Which orders count toward the nth-order milestone | Every successfully placed order, including ones that used a coupon. Failed checkouts never count. |
| Several milestones unrewarded at once (admin didn't call for a while) | Each `POST /admin/coupons` generates one coupon for the oldest unrewarded milestone. Calling it again generates the next one. |
| Who can use a coupon | Anyone who has the code. There are no customer accounts, so nothing to bind it to. No expiry, one coupon per order, applied to the whole order. |
| Coupon generated automatically or by admin? | By admin, as the spec says. The admin decides when to release it and to whom. |
| Retrying a checkout that failed | Failures are not cached against the idempotency key. After a payment decline or a stock problem the client can retry with the same key. Only a successful order is replayed. |
| Payment | A `PaymentGateway` interface with a fake implementation (configurable latency and failure). See below. |

## Decision: Reserve-then-pay checkout with explicit rollback

**Context:** Checkout must not oversell or double-spend a coupon, even when the slow part (payment) overlaps with other checkouts.

**Options considered:**
- Check stock, call payment, then decrement. This is simple, but two requests can both pass the check while payment is in flight.
- A global mutex around the whole checkout. Correct, but it serialises every checkout behind payment latency.
- Reserve stock and coupon first, then pay, then commit or release.

**Choice:** Reserve, pay, commit/release. `CheckoutService.reserve()` validates the cart, stock and coupon, then decrements stock, marks the coupon `RESERVED` and the cart `CHECKING_OUT`. All of that happens synchronously, before the first `await`. On a payment failure, `release()` undoes exactly what was reserved.

**Why:** Node runs JavaScript on one thread, so a block of code with no `await` in it can't interleave with another request. That gives an atomic "check and reserve" without locks, and payments for different carts still run in parallel. It's the same shape as a DB transaction that does `UPDATE ... SET stock = stock - q WHERE stock >= q` before calling payment.

**Consequences:** Stock is briefly unavailable to others while a payment is in flight; that's intended. If the process crashed mid-payment, the in-memory reservation would be lost along with everything else. With a real DB, reservations would need a timeout/sweeper (see "Scaling").

## Decision: Idempotency-Key header, required for checkout

**Context:** Clients retry on timeouts. A retry must not create a second order or charge stock twice.

**Options considered:**
- Rely on cart state alone: a second checkout of a checked-out cart just returns the existing order. This breaks if the retry arrives *while* the first attempt is still paying, and it can't tell a retry from a mistaken second purchase.
- An optional idempotency key.
- A required `Idempotency-Key` header, stored with a fingerprint of the request.

**Choice:** Required header. The key maps to `{ fingerprint, promise of the order }`. The record is written **before** the first await, so a concurrent retry awaits the same in-flight attempt instead of starting another. The same key with a different cart or coupon gives `422 IDEMPOTENCY_KEY_REUSED`. A new key on an already checked-out cart gives `409 CART_ALREADY_CHECKED_OUT` with the order id.

**Why:** Checkout is the one non-idempotent operation that moves money, so it's worth making clients be explicit (as Stripe does). Storing the promise instead of only the final result is what makes in-flight retries safe.

**Consequences:** Keys are kept in memory forever. In production they'd have a TTL (e.g. 24h) and be scoped per client/API key.

## Decision: Integer cents, half-up rounding, discount capped at subtotal

**Context:** No floating-point errors. Discounts must be deterministic and never produce a negative total.

**Options considered:** A decimal library (`decimal.js`/`big.js`), floats rounded at the end, or integer minor units.

**Choice:** All amounts are integer cents. `percentOf(amount, pct) = floor((amount * pct + 50) / 100)` (round half up), and `discount = min(percentOf(subtotal, x), subtotal)`. The discount is calculated once on the order subtotal, not per line.

**Why:** Integers are exact for every operation we do (sum, multiply by quantity, one percentage). A decimal library would add a dependency for no benefit here. Discounting the subtotal once means at most one rounding step, so the result is easy to explain on the order.

**Consequences:** Single currency only. Values stay exact up to ~2^53 cents, far beyond any realistic order. With multi-currency, amounts would carry a currency and minor-unit exponent.

## Decision: Coupons are counted against milestones, not created on order

**Context:** "Every nth order makes one coupon available", but an admin must request generation, and a milestone must never produce two coupons.

**Options considered:**
- Auto-generate inside checkout when `orderCount % n == 0`.
- Keep a separate "rewarded milestones" set.
- Derive it: the next coupon is milestone `generated + 1`, allowed only if `floor(orders / n) >= generated + 1`.

**Choice:** Derived. Each coupon records its milestone (e.g. order #10). Generation is synchronous, so concurrent admin calls can't both claim the same milestone (covered by a test).

**Why:** No extra state that could drift out of sync. Counting from the number of coupons works because coupons are never deleted.

**Consequences:** If coupons could ever be deleted or expired-and-removed, this would need an explicit milestone table instead.

## Decision: Fake payment gateway behind an interface

**Context:** No real payments, but "a coupon must not be lost by a checkout that fails" needs something that *can* fail, and concurrency is only interesting if checkout has an async gap.

**Options considered:** Treat checkout as always succeeding, or add a small gateway abstraction.

**Choice:** `PaymentGateway.charge()` with a `FakePaymentGateway(latencyMs, shouldFail)`. Tests inject a gateway that declines on demand.

**Why:** It creates the realistic window where overlapping requests matter, and it gives a real failure path to roll back. A real provider would plug in behind the same interface, passing the idempotency key through to the provider too.

**Consequences:** The fake only answers "success" or "declined". A real provider adds a third outcome, a timeout where we don't know whether the charge went through, which this design doesn't model yet.

## Decision: Error model

**Context:** Clients need to tell "fix your request" from "retry" from "conflict".

**Choice:** One shape, `{ error: { code, message, details } }`, with a stable `code` enum (`src/errors.ts`) and conventional statuses:

- `400`: malformed input (validation, missing header, bad JSON)
- `402`: payment declined. Retryable; nothing was consumed
- `404`: unknown cart, product, order or item
- `409`: the request conflicts with current state (stock, cart state, coupon state, milestone not reached)
- `422`: well-formed but not processable (empty cart, unknown coupon, key reuse)

`details` carries what a client needs to act: short products with available quantities, the existing `orderId`, the next milestone.

**Consequences:** Codes are part of the API contract, so renaming one is a breaking change. The 409/422 split is a judgment call, and the README documents it per endpoint.

## Decision: Layered but small

Routes (`app.ts`) only parse input and map errors. Business rules live in services that work on a `Store`. `createApp` takes its dependencies (store, payment gateway, n/x config), so tests build an isolated app per case without mocking modules. I didn't add repository interfaces or a DI container, since that seemed too much for an in-memory service.

## Implemented vs deferred

Implemented: everything in the brief. That covers cart CRUD, idempotent checkout with coupon, order retrieval, admin coupon generation, the report, an admin product patch to simulate price/stock changes, and tests for concurrency, retries, payment failure, coupon races, price changes and report reconciliation.

Deferred:
- Persistence. Everything resets on restart.
- Idempotency key TTL and per-client scoping.
- Reservation timeouts. They aren't needed in-process, but are required with a DB and external payments.
- Auth and an admin role.
- Customers, coupon expiry, per-customer coupons.
- Pagination on lists, OpenAPI spec, structured logging/metrics.

## Scaling to multiple instances and a real database

The single-thread trick doesn't survive more than one process, so the invariants move into the database:

- **Stock:** `UPDATE products SET stock = stock - $q WHERE id = $id AND stock >= $q` inside the order transaction. Zero affected rows means insufficient stock. Alternatively, `SELECT ... FOR UPDATE` on the product rows in a consistent order to avoid deadlocks.
- **Coupon:** `UPDATE coupons SET status='RESERVED' WHERE code=$c AND status='AVAILABLE'`, a conditional update so only one checkout wins. Plus `UNIQUE(milestone)` on coupons, so duplicate generation fails at the DB.
- **Cart:** a conditional status update `OPEN → CHECKING_OUT` claims the cart.
- **Idempotency:** a table with `PRIMARY KEY(client_id, key)`, inserted first. The loser of a race reads the winner's row and waits or polls for the result. Rows expire with a TTL.
- **Payment:** reserve in transaction 1, call the provider (with our idempotency key) outside any transaction, then commit in transaction 2, or release. Reservations get an `expires_at`, and a sweeper releases ones stuck after a crash. Reconciling against the provider handles "charged but we crashed before commit".
- **Report:** a SQL aggregate over orders. At scale it would come from a read model or analytics pipeline fed by order events, instead of scanning orders on every request.

## AI usage

I used Claude Code throughout: to scaffold the project, implement the services and tests, and draft the README and this document. I then reviewed the design and the code myself.

Where I redirected it:
- **Wrong assignment.** It first built a different task from the repo (an ML pipeline). I pointed it at the full-stack brief that matches my role and had that work deleted.
- **Test runner.** It set up Vitest, but its native binary was blocked by Windows Application Control on my machine. Rather than fighting the environment, we switched to Node's built-in `node:test` run through tsx. That's one dependency fewer, and nothing native to install.
- **Checking the tests themselves.** Passing tests weren't enough for me, so I had it deliberately break checkout (decrement stock *after* payment instead of before). The overselling and payment-failure tests failed as expected, then I restored the correct code. That's how I know the concurrency tests can catch a real bug.

I also checked behaviour by running the server and sending cart, checkout and coupon requests by hand.

## If I had two more hours

1. Move the store to SQLite/Postgres with the conditional updates above, and re-run the same concurrency tests against it. That's the real test of the design.
2. Add reservation expiry and a "payment outcome unknown" state (timeout from the provider), which the fake can't produce today.
3. Add a TTL to idempotency keys and scope them to a client.
4. Write an OpenAPI spec and generate the README tables from it.

## Time spent

About 4 hours in total. That covers reading the brief and pinning down the ambiguous rules, building with an AI assistant, reviewing the checkout and coupon logic, writing and checking the concurrency tests, and the docs.

Nothing in the brief is left unimplemented. The deliberate simplifications (in-memory storage, no idempotency-key TTL, no auth) are listed under "Implemented vs deferred", with how I'd handle each in production.
