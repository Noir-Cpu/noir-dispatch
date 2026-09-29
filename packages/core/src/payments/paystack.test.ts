import { describe, expect, it } from "vitest";
import { hmacHex } from "./hmac";
import { PaystackProvider } from "./paystack";
import { WebhookIgnored, WebhookSignatureError } from "./types";

// Fixtures written by hand from Paystack's public documentation. NOT captured from Paystack.
const KEY = "sk_test_fixture_key_not_real";
const successBody = JSON.stringify({
  event: "charge.success",
  data: { id: 302961, reference: "dsp_abc", amount: 93600, currency: "ZAR", status: "success", paid_at: "2026-01-15T08:00:10.000Z" },
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (data: unknown) => new Response(JSON.stringify({ status: true, message: "ok", data }));

describe("PaystackProvider (fixtures only, never run against Paystack)", () => {
  it("refuses a live key", () => {
    expect(() => new PaystackProvider({ secretKey: "sk_live_x" })).toThrow(/test-mode/);
  });

  it("initialises a transaction with amount in cents, a stable reference, and the bearer key", async () => {
    const { f, calls } = mockFetch(() => ok({ authorization_url: "https://checkout.paystack.com/x", access_code: "ac_1", reference: "ignored" }));
    const p = new PaystackProvider({ secretKey: KEY, fetch: f });
    const intent = await p.createIntent({ orderId: "o1", amountCents: 93600, currency: "ZAR", idempotencyKey: "order:c:k" });
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(calls[0]!.url).toBe("https://api.paystack.co/transaction/initialize");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(sent).toMatchObject({ amount: 93600, currency: "ZAR", metadata: { orderId: "o1" } });
    expect(sent.reference).toMatch(/^dsp_[0-9a-f]{24}$/);
    expect(intent).toMatchObject({ clientSecret: "ac_1", checkoutUrl: "https://checkout.paystack.com/x" });
    await p.createIntent({ orderId: "o1", amountCents: 93600, currency: "ZAR", idempotencyKey: "order:c:k" });
    expect(JSON.parse(calls[1]!.init.body as string).reference).toBe(sent.reference); // same key, same reference
  });

  it("on a duplicate reference, returns the existing transaction if amount matches", async () => {
    const { f } = mockFetch((url) =>
      url.endsWith("/transaction/initialize")
        ? new Response(JSON.stringify({ status: false, message: "Duplicate Transaction Reference" }), { status: 400 })
        : ok({ reference: url.split("/").pop(), amount: 500 }),
    );
    const p = new PaystackProvider({ secretKey: KEY, fetch: f });
    const i = await p.createIntent({ orderId: "o", amountCents: 500, currency: "ZAR", idempotencyKey: "k" });
    expect(i.id).toMatch(/^dsp_/);
    await expect(p.createIntent({ orderId: "o", amountCents: 999, currency: "ZAR", idempotencyKey: "k" })).rejects.toThrow(/Duplicate/);
  });

  it("refunds by transaction reference", async () => {
    const { f, calls } = mockFetch(() => ok({ id: 77 }));
    const r = await new PaystackProvider({ secretKey: KEY, fetch: f }).refund({ intentId: "dsp_abc", amountCents: 100, idempotencyKey: "r" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ transaction: "dsp_abc", amount: 100 });
    expect(r).toEqual({ refundId: "paystack_refund_77", amountCents: 100 });
  });

  it("verifies an HMAC-SHA512 webhook and maps charge.success to our payment event", async () => {
    const p = new PaystackProvider({ secretKey: KEY });
    const sig = await hmacHex(KEY, successBody, "SHA-512");
    expect(sig).toHaveLength(128);
    expect(await p.verifyWebhook(successBody, sig)).toEqual({
      id: "paystack_charge_302961",
      type: "payment_intent.succeeded",
      intentId: "dsp_abc",
      amountCents: 93600,
      createdAt: Date.parse("2026-01-15T08:00:10.000Z"),
    });
  });

  it("rejects a missing, wrong, tampered or SHA-256 signature", async () => {
    const p = new PaystackProvider({ secretKey: KEY });
    const good = await hmacHex(KEY, successBody, "SHA-512");
    await expect(p.verifyWebhook(successBody, null)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(p.verifyWebhook(successBody, "00" + good.slice(2))).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(p.verifyWebhook(successBody.replace("93600", "1"), good)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(p.verifyWebhook(successBody, await hmacHex(KEY, successBody, "SHA-256"))).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("ignores validly signed events it does not model", async () => {
    const p = new PaystackProvider({ secretKey: KEY });
    const body = JSON.stringify({ event: "transfer.success", data: {} });
    await expect(p.verifyWebhook(body, await hmacHex(KEY, body, "SHA-512"))).rejects.toBeInstanceOf(WebhookIgnored);
  });
});
