export type Intent = { id: string; amountCents: number; currency: string; clientSecret: string; /** Hosted checkout page, when the provider has one. */ checkoutUrl?: string };

export type ProviderEvent = {
  /** Provider's event id; the same id is redelivered on retries. */
  id: string;
  type: "payment_intent.succeeded" | "payment_intent.payment_failed";
  intentId: string;
  amountCents: number;
  createdAt: number;
};

export class WebhookSignatureError extends Error {}
/** A correctly signed event we deliberately do not act on (e.g. a Paystack event type we do not model). */
export class WebhookIgnored extends Error {}

export interface PaymentProvider {
  readonly name: string;
  /** HTTP header carrying the webhook signature. */
  readonly signatureHeader: string;
  /** Same idempotency key must return the same intent, never a second one. */
  createIntent(i: { orderId: string; customerEmail?: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<Intent>;
  cancelIntent(intentId: string): Promise<void>;
  /** Same idempotency key must refund at most once. */
  refund(i: { intentId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string; amountCents: number }>;
  /** Verify the signature over the raw body, then parse. Throws WebhookSignatureError. */
  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs: number): Promise<ProviderEvent>;
}
