import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Cents } from './money.js';

export interface ChargeRequest {
  reference: string;
  amountCents: Cents;
}

export interface PaymentGateway {
  charge(req: ChargeRequest): Promise<{ id: string }>;
}

export class FakePaymentGateway implements PaymentGateway {
  constructor(
    private readonly latencyMs = 0,
    private readonly shouldFail: (req: ChargeRequest) => boolean = () => false,
  ) {}

  async charge(req: ChargeRequest) {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (this.shouldFail(req)) throw new Error('card declined');
    return { id: `pay_${randomUUID()}` };
  }
}
