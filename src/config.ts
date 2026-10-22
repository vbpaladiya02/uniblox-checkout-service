import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  COUPON_EVERY_N_ORDERS: z.coerce.number().int().min(1).default(5),
  COUPON_PERCENT_OFF: z.coerce.number().int().min(1).max(100).default(10),
  PAYMENT_LATENCY_MS: z.coerce.number().int().min(0).default(50),
});

export interface Config {
  port: number;
  couponEveryNOrders: number;
  couponPercentOff: number;
  paymentLatencyMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    port: parsed.PORT,
    couponEveryNOrders: parsed.COUPON_EVERY_N_ORDERS,
    couponPercentOff: parsed.COUPON_PERCENT_OFF,
    paymentLatencyMs: parsed.PAYMENT_LATENCY_MS,
  };
}
