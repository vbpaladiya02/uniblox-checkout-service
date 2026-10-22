import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FakePaymentGateway } from './payments.js';

const config = loadConfig();
const { app } = createApp({ config, payments: new FakePaymentGateway(config.paymentLatencyMs) });

app.listen(config.port, () => {
  console.log(
    `checkout-service listening on :${config.port} (coupon every ${config.couponEveryNOrders} orders, ${config.couponPercentOff}% off)`,
  );
});
