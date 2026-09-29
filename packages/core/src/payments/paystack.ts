import { hmacVerify } from "./hmac";
import { WebhookIgnored, WebhookSignatureError, type Intent, type PaymentProvider, type ProviderEvent } from "./types";

/**
 * Paystack adapter for TEST MODE (secret key starts sk_test_). Written from Paystack's public docs
 * and unit-tested against fixtures written here; it has NOT been run against Paystack.
 * Items marked UNSURE need checking against a real test-mode account before relying on them.
 * Docs: https://paystack.com/docs/api/transaction/ , /refund/ , https://paystack.com/docs/payments/webhooks/
 *
 * Refuses to run with a live key (sk_live_): this repo is a simulation and must never take real money.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";
  readonly signatureHeader = "x-paystack-signature";
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: { secretKey: string; baseUrl?: string; fetch?: typeof fetch }) {
    if (!opts.secretKey.startsWith("sk_test_")) throw new Error("PaystackProvider only accepts a test-mode secret key (sk_test_...)");
    this.base = opts.baseUrl ?? "https://api.paystack.co";
    this.f = opts.fetch ?? fetch;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.secretKey}`, "content-type": "application/json", ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || body.status === false) throw new PaystackError(res.status, body.message ?? "request failed");
    return body.data as T;
  }

  /**
   * POST /transaction/initialize. `amount` is in the currency's lowest unit (cents for ZAR).
   * The transaction `reference` is derived from the idempotency key: Paystack rejects a reused reference,
   * and in that case we fetch the existing transaction instead. UNSURE: exact error text/status for a
   * duplicate reference, so we key off any failure followed by a successful verify of the same reference.
   */
  async createIntent(i: { orderId: string; customerEmail?: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<Intent> {
    const reference = await referenceFor(i.idempotencyKey);
    try {
      const d = await this.call<{ authorization_url: string; access_code: string; reference: string }>("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email: i.customerEmail ?? `customer-${i.orderId}@dispatch.invalid`,
          amount: i.amountCents,
          currency: i.currency,
          reference,
          metadata: { orderId: i.orderId },
        }),
      });
      return { id: d.reference, amountCents: i.amountCents, currency: i.currency, clientSecret: d.access_code, checkoutUrl: d.authorization_url };
    } catch (e) {
      // Retry of the same order: the reference already exists.
      const existing = await this.call<{ reference: string; amount: number }>(`/transaction/verify/${reference}`).catch(() => null);
      if (existing?.reference === reference && existing.amount === i.amountCents) {
        return { id: reference, amountCents: i.amountCents, currency: i.currency, clientSecret: "" };
      }
      throw e;
    }
  }

  /** Paystack has no cancel endpoint for an initialised transaction (UNSURE); it simply expires unpaid. */
  async cancelIntent(): Promise<void> {}

  /**
   * POST /refund {transaction, amount}. UNSURE: Paystack takes no idempotency key on refunds; our own
   * `markRefunded` guard (one refund per payment) is what prevents a second refund from this system.
   */
  async refund(i: { intentId: string; amountCents: number; idempotencyKey: string }) {
    const d = await this.call<{ id?: number; reference?: string }>("/refund", {
      method: "POST",
      body: JSON.stringify({ transaction: i.intentId, amount: i.amountCents }),
    });
    return { refundId: `paystack_refund_${d.id ?? i.idempotencyKey}`, amountCents: i.amountCents };
  }

  /**
   * Paystack signs the raw body with HMAC-SHA512 using the secret key; hex digest in `x-paystack-signature`.
   * There is no timestamp in the scheme, so replays are stopped by our idempotent charge guard, not a window.
   * Only `charge.success` is modelled. UNSURE: whether a failed-charge event exists for our flow; anything
   * else is acknowledged and ignored.
   */
  async verifyWebhook(rawBody: string, header: string | null): Promise<ProviderEvent> {
    if (!header || !(await hmacVerify(this.opts.secretKey, rawBody, header, "SHA-512"))) throw new WebhookSignatureError("bad signature");
    let e: { event?: string; data?: { id?: number; reference?: string; amount?: number; status?: string; paid_at?: string; created_at?: string } };
    try {
      e = JSON.parse(rawBody);
    } catch {
      throw new WebhookSignatureError("body is not JSON");
    }
    const d = e.data;
    if (e.event !== "charge.success" || !d?.reference || d.status !== "success" || !Number.isInteger(d.amount)) throw new WebhookIgnored(e.event ?? "unknown");
    return {
      id: `paystack_charge_${d.id ?? d.reference}`,
      type: "payment_intent.succeeded",
      intentId: d.reference,
      amountCents: d.amount!,
      createdAt: Date.parse(d.paid_at ?? d.created_at ?? "") || 0,
    };
  }
}

export class PaystackError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Paystack ${status}: ${message}`);
  }
}

async function referenceFor(key: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return "dsp_" + [...bytes].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
