import type { ProviderEvent, TestPaymentProvider } from "@noir/core";
import type { Engine } from "./engine";

/**
 * Plays the payment provider: tells the engine "this customer paid" through the same signed-webhook
 * path a real provider would use. For the simulator, the dev "pay" button and tests. Never for production.
 */
export async function payAsProvider(engine: Engine, provider: TestPaymentProvider, orderId: string, now: number, eventId = `evt_${orderId}`) {
  const d = await engine.detail(orderId);
  if (!d?.payment) return { status: "ignored" as const };
  const event: ProviderEvent = {
    id: eventId,
    type: "payment_intent.succeeded",
    intentId: d.payment.intentId,
    amountCents: d.payment.amountCents,
    createdAt: now,
  };
  const { body, signature } = await provider.signEvent(event, now);
  return engine.handleWebhook(body, signature);
}
