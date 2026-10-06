import { DELIVERY_RADIUS_KM } from "@noir/core";

/** DELIVERY_RADIUS_KM from a plain wrangler var. Anything that is not a positive finite number means the default (12 km). */
export function parseRadiusKm(raw: string | undefined): number {
  const km = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(km) && km > 0 ? km : DELIVERY_RADIUS_KM;
}
