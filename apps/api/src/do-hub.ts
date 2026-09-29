import type { TrackPoint, TrackPublisher } from "@noir/core";

// Rooms are only worth a Durable Object once a driver is on the job.
const LIVE = new Set(["assigned", "en_route", "arrived", "delivering", "completed", "cancelled"]);

/** TrackPublisher backed by one Durable Object per order (Workers). */
export class DoHub implements TrackPublisher {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(orderId: string) {
    return this.ns.get(this.ns.idFromName(orderId));
  }
  private post(orderId: string, path: string, body?: unknown) {
    return this.stub(orderId).fetch(`https://room${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async publish(p: TrackPoint) {
    await this.post(p.orderId, "/publish", p);
  }
  async setStatus(orderId: string, status: string) {
    if (LIVE.has(status)) await this.post(orderId, "/status", { status });
  }
  async close(orderId: string) {
    await this.post(orderId, "/close");
  }
  upgrade(orderId: string, req: Request) {
    return this.stub(orderId).fetch("https://room/ws", { headers: req.headers });
  }
}
