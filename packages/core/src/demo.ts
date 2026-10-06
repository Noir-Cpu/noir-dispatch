// Timeline of the on-demand demo. Pure: the same elapsed time always gives the same state and position, so any number of
// tabs or retries asking "where is the driver now?" get the same answer. The API computes this from the demo clock, never
// from how many requests arrived.
import { pointAtM, cumulativeM } from "./polyline";
import type { LatLng } from "./order-machine";

/**
 * One real second of demo is this many simulated seconds. Shown to the visitor as "demo speed". A 6 km trip that takes the
 * routing service's estimate of about 10 minutes therefore plays in about a minute, and the car appears to move about ten
 * times faster than a real one would.
 */
export const DEMO_TIME_COMPRESSION = 10;

/** Demo drivers are simulated drivers with these ids. They are only ever assignable to orders that are running the demo. */
export const DEMO_DRIVER_PREFIX = "demo-drv-";
export const isDemoDriverId = (id: string | null | undefined) => !!id && id.startsWith(DEMO_DRIVER_PREFIX);

/** Simulated seconds spent in each non-travel stage. Plausible, not measured. */
export const DEMO_DWELL_S = {
  /** Order placed until station staff accept. */
  accept: 15,
  /** Driver assigned until the driver sets off (loading the tanker). */
  depart: 45,
  /** Arrived until delivery starts (walking to the customer). */
  arrived: 30,
  /** Pumping. */
  delivering: 240,
} as const;

export type DemoTimeline = { acceptAt: number; departAt: number; arriveAt: number; startAt: number; doneAt: number };

/** Simulated seconds since the demo started at which each step happens, for a trip that takes `travelS` simulated seconds. */
export function demoTimeline(travelS: number): DemoTimeline {
  const travel = Math.max(20, travelS);
  const acceptAt = DEMO_DWELL_S.accept;
  const departAt = acceptAt + DEMO_DWELL_S.depart;
  const arriveAt = departAt + travel;
  const startAt = arriveAt + DEMO_DWELL_S.arrived;
  return { acceptAt, departAt, arriveAt, startAt, doneAt: startAt + DEMO_DWELL_S.delivering };
}

/** Driver position at `simS`: at the station until departure, along the road at constant speed, then at the door. */
export function demoDriverPosition(points: readonly LatLng[], tl: DemoTimeline, simS: number): LatLng & { heading: number; fraction: number } {
  const cum = cumulativeM(points);
  const f = Math.min(1, Math.max(0, (simS - tl.departAt) / (tl.arriveAt - tl.departAt)));
  return { ...pointAtM(points, f * cum.at(-1)!, cum), fraction: f };
}
