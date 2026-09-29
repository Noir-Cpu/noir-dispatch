import type { ProviderEvent } from "@noir/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookSignatureError } from "@noir/core";
import { createLocalEngine, type LocalEngine } from "./testkit";

let k: LocalEngine;
beforeEach(async () => {
  k = await createLocalEngine();
  await k.store.upsertCustomer({ id: "c1", name: "C" });
});
afterEach(() => k.close());

const order = () =>
  k.engine.placeOrder({ customerId: "c1", stationId: "st-cbd", fuel: "diesel", litres: 20, dropoff: { lat: -33.93, lng: 18.44, label: "x" }, idempotencyKey: "k" });

async function signed(orderId: string, over: Partial<ProviderEvent> = {}) {
  const d = (await k.engine.detail(orderId))!;
  const ev: ProviderEvent = {
    id: "evt_1",
    type: "payment_intent.succeeded",
    intentId: d.payment!.intentId,
    amountCents: d.payment!.amountCents,
    createdAt: k.clock.now,
    ...over,
  };
  return k.provider.signEvent(ev, k.clock.now);
}

describe("payment webhooks (chaos)", () => {
  it("replaying the same signed webhook 10 times records exactly one charge", async () => {
    const { order: o } = await order();
    const { body, signature } = await signed(o.id);
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await k.engine.handleWebhook(body, signature));
    expect(results.map((r) => r.status)).toEqual(["processed", ...Array(9).fill("duplicate")]);
    const pay = (await k.engine.detail(o.id))!.payment!;
    expect(pay.status).toBe("succeeded");
    expect(await k.store.countCharges(pay.id)).toBe(1);
    expect(await k.store.countCharges()).toBe(1);
    expect(await k.store.countWebhookEvents()).toBe(1);
  });

  it("10 concurrent deliveries of the same webhook still record exactly one charge", async () => {
    const { order: o } = await order();
    const { body, signature } = await signed(o.id);
    await Promise.all(Array.from({ length: 10 }, () => k.engine.handleWebhook(body, signature)));
    expect(await k.store.countCharges()).toBe(1);
  });

  it("the same payment redelivered under new event ids is still one charge", async () => {
    const { order: o } = await order();
    for (let i = 0; i < 10; i++) {
      const { body, signature } = await signed(o.id, { id: `evt_${i}` });
      await k.engine.handleWebhook(body, signature);
    }
    expect(await k.store.countCharges()).toBe(1);
  });

  it("rejects a bad signature, a tampered body, a stale timestamp and a malformed header", async () => {
    const { order: o } = await order();
    const { body, signature } = await signed(o.id);
    const tampered = body.replace(/"amountCents":\d+/, '"amountCents":1');
    await expect(k.engine.handleWebhook(tampered, signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(k.engine.handleWebhook(body, signature.replace(/v1=./, "v1=0"))).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(k.engine.handleWebhook(body, null)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(k.engine.handleWebhook(body, "garbage")).rejects.toBeInstanceOf(WebhookSignatureError);
    const old = await k.provider.signEvent(JSON.parse(body), k.clock.now - 10 * 60_000);
    await expect(k.engine.handleWebhook(old.body, old.signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await k.store.countCharges()).toBe(0);
    expect((await k.engine.detail(o.id))!.payment!.status).toBe("requires_payment");
  });

  it("a validly signed event with the wrong amount charges nothing", async () => {
    const { order: o } = await order();
    const { body, signature } = await signed(o.id, { amountCents: 1 });
    const r = await k.engine.handleWebhook(body, signature);
    expect(r.status).not.toBe("processed");
    expect(await k.store.countCharges()).toBe(0);
  });

  it("a failed payment cancels the order", async () => {
    const { order: o } = await order();
    const { body, signature } = await signed(o.id, { type: "payment_intent.payment_failed" });
    await k.engine.handleWebhook(body, signature);
    const d = (await k.engine.detail(o.id))!;
    expect(d.payment!.status).toBe("failed");
    expect(d.view.cancel).toMatchObject({ by: "system", reason: "payment_failed" });
  });

  it("intent creation is idempotent per key and refunds are idempotent per key", async () => {
    const a = await k.provider.createIntent({ orderId: "o", amountCents: 100, currency: "ZAR", idempotencyKey: "same" });
    const b = await k.provider.createIntent({ orderId: "o", amountCents: 100, currency: "ZAR", idempotencyKey: "same" });
    const c = await k.provider.createIntent({ orderId: "o", amountCents: 100, currency: "ZAR", idempotencyKey: "other" });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    const r1 = await k.provider.refund({ intentId: a.id, amountCents: 50, idempotencyKey: "r" });
    expect(await k.provider.refund({ intentId: a.id, amountCents: 50, idempotencyKey: "r" })).toEqual(r1);
  });
});
