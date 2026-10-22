import express, { type ErrorRequestHandler, type Request } from 'express';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { FakePaymentGateway, type PaymentGateway } from './payments.js';
import { CartService } from './services/carts.js';
import { CheckoutService } from './services/checkout.js';
import { CouponService } from './services/coupons.js';
import { buildReport } from './services/report.js';
import { Store, seedProducts } from './store.js';

const quantity = z.number().int().positive();
const addItemBody = z.object({ productId: z.string().min(1), quantity });
const updateItemBody = z.object({ quantity });
const checkoutBody = z.object({ couponCode: z.string().trim().min(1).max(64).optional() }).default({});
const idempotencyKey = z.string().trim().min(1).max(255);
const productPatch = z
  .object({ priceCents: z.number().int().nonnegative(), stock: z.number().int().nonnegative() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Provide priceCents and/or stock');

export interface AppDeps {
  config: Pick<Config, 'couponEveryNOrders' | 'couponPercentOff'>;
  payments?: PaymentGateway;
  store?: Store;
}

export function createApp({ config, payments = new FakePaymentGateway(), store = new Store(seedProducts) }: AppDeps) {
  const carts = new CartService(store);
  const checkout = new CheckoutService(store, payments);
  const coupons = new CouponService(store, {
    everyNOrders: config.couponEveryNOrders,
    percentOff: config.couponPercentOff,
  });

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/products', (_req, res) => {
    res.json({ items: [...store.products.values()] });
  });

  app.post('/carts', (_req, res) => {
    res.status(201).json(carts.view(carts.create()));
  });

  app.get('/carts/:cartId', (req, res) => {
    res.json(carts.view(carts.get(req.params.cartId)));
  });

  app.post('/carts/:cartId/items', (req, res) => {
    const { productId, quantity } = addItemBody.parse(req.body);
    res.json(carts.view(carts.addItem(req.params.cartId, productId, quantity)));
  });

  app.patch('/carts/:cartId/items/:productId', (req, res) => {
    const { quantity } = updateItemBody.parse(req.body);
    res.json(carts.view(carts.updateItem(req.params.cartId, req.params.productId, quantity)));
  });

  app.delete('/carts/:cartId/items/:productId', (req, res) => {
    res.json(carts.view(carts.removeItem(req.params.cartId, req.params.productId)));
  });

  app.post('/carts/:cartId/checkout', async (req, res) => {
    const key = parseHeader(req, 'Idempotency-Key', idempotencyKey);
    const { couponCode } = checkoutBody.parse(req.body ?? {});
    const { order, replayed } = await checkout.checkout(req.params.cartId, couponCode, key);
    res.status(201).set('Idempotent-Replayed', String(replayed)).json(order);
  });

  app.get('/orders/:orderId', (req, res) => {
    res.json(checkout.getOrder(req.params.orderId));
  });

  app.post('/admin/coupons', (_req, res) => {
    res.status(201).json(coupons.generate());
  });

  app.get('/admin/coupons', (_req, res) => {
    res.json({ items: coupons.list() });
  });

  app.get('/admin/report', (_req, res) => {
    res.json(buildReport(store));
  });

  app.patch('/admin/products/:productId', (req, res) => {
    const patch = productPatch.parse(req.body);
    const product = store.products.get(req.params.productId);
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${req.params.productId} not found`);
    Object.assign(product, patch);
    res.json(product);
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} does not exist` } });
  });

  app.use(errorHandler);

  return { app, store };
}

function parseHeader<T>(req: Request, name: string, schema: z.ZodType<T>): T {
  const result = schema.safeParse(req.get(name));
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', `${name} header is required`);
  }
  return result.data;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
