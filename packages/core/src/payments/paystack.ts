import type { Intent, PaymentProvider, ProviderEvent } from "./types";

/**
 * Paystack adapter. NOT IMPLEMENTED: needs a Paystack test-mode secret key (PAYSTACK_SECRET_KEY).
 * TODO(John): implement with the test key from https://dashboard.paystack.com/#/settings/developers
 *   - createIntent   -> POST /transaction/initialize (reference = idempotency key)
 *   - refund         -> POST /refund
 *   - verifyWebhook  -> HMAC-SHA512 of the raw body with the secret key, header x-paystack-signature
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";
  constructor(readonly secretKey: string) {}
  createIntent(): Promise<Intent> {
    throw new Error("PaystackProvider is a stub: needs a test-mode key and implementation");
  }
  cancelIntent(): Promise<void> {
    throw new Error("PaystackProvider is a stub");
  }
  refund(): Promise<{ refundId: string; amountCents: number }> {
    throw new Error("PaystackProvider is a stub");
  }
  verifyWebhook(): Promise<ProviderEvent> {
    throw new Error("PaystackProvider is a stub");
  }
}
