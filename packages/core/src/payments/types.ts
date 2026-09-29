export type Intent = { id: string; amountCents: number; currency: string; clientSecret: string };

export type ProviderEvent = {
  /** Provider's event id; the same id is redelivered on retries. */
  id: string;
  type: "payment_intent.succeeded" | "payment_intent.payment_failed";
  intentId: string;
  amountCents: number;
  createdAt: number;
};

export class WebhookSignatureError extends Error {}

export interface PaymentProvider {
  readonly name: string;
  /** Same idempotency key must return the same intent, never a second one. */
  createIntent(i: { orderId: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<Intent>;
  cancelIntent(intentId: string): Promise<void>;
  /** Same idempotency key must refund at most once. */
  refund(i: { intentId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string; amountCents: number }>;
  /** Verify the signature over the raw body, then parse. Throws WebhookSignatureError. */
  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs: number): Promise<ProviderEvent>;
}
