import type { Intent, PaymentProvider, ProviderEvent } from "./types";

/**
 * Stripe adapter. NOT IMPLEMENTED: needs Stripe test-mode keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET).
 * TODO(John): implement with the `stripe` SDK in test mode
 *   - createIntent   -> paymentIntents.create(..., { idempotencyKey })
 *   - refund         -> refunds.create(..., { idempotencyKey })
 *   - verifyWebhook  -> stripe.webhooks.constructEventAsync(rawBody, header, secret)
 */
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  constructor(readonly secretKey: string, readonly webhookSecret: string) {}
  createIntent(): Promise<Intent> {
    throw new Error("StripeProvider is a stub: needs test-mode keys and implementation");
  }
  cancelIntent(): Promise<void> {
    throw new Error("StripeProvider is a stub");
  }
  refund(): Promise<{ refundId: string; amountCents: number }> {
    throw new Error("StripeProvider is a stub");
  }
  verifyWebhook(): Promise<ProviderEvent> {
    throw new Error("StripeProvider is a stub");
  }
}
