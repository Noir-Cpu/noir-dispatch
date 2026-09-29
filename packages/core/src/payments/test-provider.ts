import { hmacHex, hmacVerify, sha256Hex } from "./hmac";
import { WebhookSignatureError, type Intent, type PaymentProvider, type ProviderEvent } from "./types";

const TOLERANCE_MS = 5 * 60_000;

/**
 * A fake provider that behaves like Stripe/Paystack where it matters for correctness:
 * deterministic ids per idempotency key, `t=...,v1=<hmac>` signed webhooks with a replay window,
 * and at-least-once delivery (the caller may deliver the same event repeatedly).
 * Stateless on purpose so it works across Worker isolates. No money moves.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = "test";
  readonly signatureHeader = "x-test-signature";
  constructor(private readonly webhookSecret: string) {}

  async createIntent(i: { orderId: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<Intent> {
    const h = (await sha256Hex(`intent:${i.idempotencyKey}`)).slice(0, 24);
    return { id: `pi_test_${h}`, amountCents: i.amountCents, currency: i.currency, clientSecret: `pi_test_${h}_secret_${h.slice(0, 8)}` };
  }

  async cancelIntent(): Promise<void> {}

  async refund(i: { intentId: string; amountCents: number; idempotencyKey: string }) {
    const h = (await sha256Hex(`refund:${i.idempotencyKey}`)).slice(0, 24);
    return { refundId: `re_test_${h}`, amountCents: i.amountCents };
  }

  async verifyWebhook(rawBody: string, header: string | null, nowMs: number): Promise<ProviderEvent> {
    const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!header || !Number.isFinite(t) || !parts.v1) throw new WebhookSignatureError("malformed signature header");
    if (Math.abs(nowMs - t * 1000) > TOLERANCE_MS) throw new WebhookSignatureError("timestamp outside tolerance");
    if (!(await hmacVerify(this.webhookSecret, `${parts.t}.${rawBody}`, parts.v1))) throw new WebhookSignatureError("bad signature");
    let e: ProviderEvent;
    try {
      e = JSON.parse(rawBody) as ProviderEvent;
    } catch {
      throw new WebhookSignatureError("body is not JSON");
    }
    if (!e.id || !e.intentId || !Number.isInteger(e.amountCents)) throw new WebhookSignatureError("malformed event");
    return e;
  }

  /** What the provider would send. Used by the dev server's "pay" button, the simulator and tests. */
  async signEvent(event: ProviderEvent, nowMs: number) {
    const body = JSON.stringify(event);
    const t = Math.floor(nowMs / 1000);
    return { body, signature: `t=${t},v1=${await hmacHex(this.webhookSecret, `${t}.${body}`)}` };
  }
}
