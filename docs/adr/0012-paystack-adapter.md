# ADR 0012: Paystack test-mode adapter, fake provider stays the default

Status: accepted

**Decision.** `PaystackProvider` implements the existing `PaymentProvider` interface: `POST /transaction/initialize` (amount in cents, reference derived from the idempotency key), `POST /refund`, and webhooks verified with HMAC-SHA512 of the raw body against `x-paystack-signature`. It refuses any key not starting `sk_test_`. It is selected only when `PAYMENTS_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY` are both set; otherwise the fake provider is used. The demo "pay" endpoint (`DEV_TOOLS`) and the simulator's pay endpoint refuse to run unless the active provider is the fake one, so those switches cannot reach a real-money path (tested).

**Not verified.** It was written from Paystack's public docs and tested only against fixtures written here; it has not been run against Paystack. Marked UNSURE in the code: the duplicate-reference error shape, whether initialised transactions can be cancelled (assumed not), whether refunds accept an idempotency key (assumed not), and whether a failed-charge webhook exists for this flow (only `charge.success` is mapped; other events are acknowledged and ignored). Paystack signs no timestamp, so replay protection rests on the idempotent charge guard (ADR 0005), not a time window.
