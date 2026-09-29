// Live tracking room logic. Plain class so it runs (and is tested) without the Workers runtime;
// the Durable Object in apps/api only adapts sockets and storage to this.

export type TrackPoint = { orderId: string; driverId: string; lat: number; lng: number; t: number };
export type TrackMessage =
  | { type: "snapshot"; last: TrackPoint | null; status: string | null; track: TrackPoint[] }
  | { type: "position"; point: TrackPoint }
  | { type: "status"; status: string };

export type Subscriber = (msg: TrackMessage) => void;

/** What the engine needs from live tracking. In-process hub for dev and tests, Durable Objects in production. */
export interface TrackPublisher {
  publish(p: TrackPoint): void | Promise<void>;
  setStatus(orderId: string, status: string): void | Promise<void>;
  /** The delivery is over: flush and release the room. */
  close(orderId: string): void | Promise<void>;
}

export class TrackRoom {
  private subs = new Set<Subscriber>();
  private last: TrackPoint | null = null;
  private lastPersistedAt = Number.NEGATIVE_INFINITY;
  private status: string | null = null;
  private track: TrackPoint[] = [];

  constructor(
    private readonly opts: {
      /** One point per this many ms is kept in the track and persisted. */
      downsampleMs?: number;
      /** Called for each downsampled point, e.g. to write driver_locations. Errors never block broadcast. */
      persist?: (p: TrackPoint) => void | Promise<void>;
      /** Cap on the in-memory track. */
      maxTrack?: number;
    } = {},
  ) {}

  get subscriberCount() {
    return this.subs.size;
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub);
    sub({ type: "snapshot", last: this.last, status: this.status, track: [...this.track] });
    return () => this.subs.delete(sub);
  }

  /** Broadcast first, persist second: subscribers never wait on storage. Returns true if the point was persisted. */
  ingest(p: TrackPoint): boolean {
    // Out-of-order pings (retries) are dropped so the marker never jumps backwards.
    if (this.last && p.t <= this.last.t) return false;
    this.last = p;
    this.broadcast({ type: "position", point: p });
    if (p.t - this.lastPersistedAt < (this.opts.downsampleMs ?? 30_000)) return false;
    this.lastPersistedAt = p.t;
    this.track.push(p);
    if (this.track.length > (this.opts.maxTrack ?? 500)) this.track.shift();
    try {
      void Promise.resolve(this.opts.persist?.(p)).catch(() => {});
    } catch {
      /* persistence must not break live delivery */
    }
    return true;
  }

  setStatus(status: string) {
    this.status = status;
    this.broadcast({ type: "status", status });
  }

  snapshot() {
    return { last: this.last, status: this.status, track: [...this.track] };
  }

  /** Rebuild after a Durable Object wakes from hibernation. Only what was persisted (track, status) comes back. */
  restore(s: { status: string | null; track: TrackPoint[] }) {
    this.status = s.status;
    this.track = [...s.track];
    this.last = s.track.at(-1) ?? null;
    this.lastPersistedAt = this.last?.t ?? Number.NEGATIVE_INFINITY;
  }

  private broadcast(msg: TrackMessage) {
    for (const s of this.subs) {
      try {
        s(msg);
      } catch {
        this.subs.delete(s); // a dead socket must not stop the others
      }
    }
  }
}

/** Process-local registry of rooms, keyed by order id. Used by the dev server and the simulator. */
export class TrackHub implements TrackPublisher {
  private rooms = new Map<string, TrackRoom>();
  constructor(private readonly opts: ConstructorParameters<typeof TrackRoom>[0] & object = {}) {}
  room(orderId: string) {
    let r = this.rooms.get(orderId);
    if (!r) this.rooms.set(orderId, (r = new TrackRoom(this.opts)));
    return r;
  }
  publish(p: TrackPoint) {
    this.room(p.orderId).ingest(p);
  }
  setStatus(orderId: string, status: string) {
    this.room(orderId).setStatus(status);
  }
  close(orderId: string) {
    this.rooms.delete(orderId);
  }
  get size() {
    return this.rooms.size;
  }
}
