# ADR 0006: Payments behind a provider interface, with a Stripe-shaped fake

Status: accepted

**Context.** Real Paystack or Stripe test-mode needs keys we do not have, but the interesting problems (retries, replays, forged callbacks, refunds) exist with any provider.

**Decision.** `PaymentProvider` has `createIntent`, `cancelIntent`, `refund` (both idempotent by key) and `verifyWebhook`. `TestPaymentProvider` derives intent and refund ids from the idempotency key (so it is stateless across Worker isolates), signs webhooks as `t=<unix>,v1=HMAC-SHA256(secret, "t.body")`, and rejects timestamps more than 5 minutes off. `PaystackProvider` and `StripeProvider` are stubs that throw and carry a TODO. The order price is fixed at placement, so a modification never reprices an already-created intent.

Webhook handling assumes at-least-once delivery: the charge is recorded by a guarded update (see ADR 0005), so the same event, or the same payment under a new event id, records one charge. A payment that succeeds after its order was cancelled is refunded automatically. Refund on cancel is full, minus a flat fee when a customer cancels after the driver set off (fee value is a product parameter, not a measurement).

**Consequences.** A real adapter must satisfy the same contract. The dev "Pay" button plays the provider by sending a signed webhook through the real endpoint, so the demo exercises the real path.
