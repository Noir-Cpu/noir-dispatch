import { describe, expect, it } from "vitest";
import { DELIVERY_RADIUS_KM, rangeAdvice, stationRanges, withinRadius } from "./delivery";
import { destinationPoint } from "./polyline";

const A = { id: "a", name: "Alpha Pumps", lat: -33.98, lng: 18.47 };
const B = { id: "b", name: "Bravo Fuel", lat: -33.9, lng: 18.63 };

describe("delivery radius", () => {
  it("defaults to 12 km", () => expect(DELIVERY_RADIUS_KM).toBe(12));

  it("accepts a drop-off just inside the radius and rejects one just outside, in every direction", () => {
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(withinRadius(A, destinationPoint(A, bearing, 11_990))).toBe(true);
      expect(withinRadius(A, destinationPoint(A, bearing, 12_010))).toBe(false);
    }
  });

  it("includes the station itself and respects a different radius", () => {
    expect(withinRadius(A, A)).toBe(true);
    const p = destinationPoint(A, 10, 5_000);
    expect(withinRadius(A, p, 4)).toBe(false);
    expect(withinRadius(A, p, 6)).toBe(true);
  });

  it("ranks stations by distance and flags range", () => {
    const p = destinationPoint(A, 90, 3_000);
    const r = stationRanges([B, A], p);
    expect(r.map((x) => x.station.id)).toEqual(["a", "b"]);
    expect(r[0]).toMatchObject({ inRange: true });
    expect(r[0]!.distanceKm).toBeCloseTo(3, 1);
    expect(r[1]!.inRange).toBe(false);
  });
});

describe("rangeAdvice", () => {
  it("has no message when the chosen station can deliver", () => {
    const a = rangeAdvice([A, B], "a", destinationPoint(A, 0, 2_000));
    expect(a).toMatchObject({ ok: true, message: null });
  });

  it("names the radius and suggests the nearest station that can reach the point", () => {
    const p = destinationPoint(B, 270, 4_000); // near Bravo, about 15 km from Alpha
    const a = rangeAdvice([A, B], "a", p);
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/outside our 12 km delivery radius/);
    expect(a.message).toMatch(/Alpha Pumps/);
    expect(a.message).toMatch(/Bravo Fuel is 4\.0 km away and can deliver there/);
    expect(a.nearestInRange?.station.id).toBe("b");
  });

  it("never says '12.0 km' is outside a 12 km radius: it shows enough decimals to make sense", () => {
    const a = rangeAdvice([A], "a", destinationPoint(A, 0, 12_030));
    expect(a.message).toMatch(/12\.03 km from Alpha Pumps, outside our 12 km delivery radius/);
  });

  it("says so, kindly, when no station reaches the point", () => {
    const far = destinationPoint(A, 90, 45_000);
    const a = rangeAdvice([A], "a", far);
    expect(a.ok).toBe(false);
    expect(a.nearestInRange).toBeNull();
    expect(a.message).toMatch(/45\.0 km from Alpha Pumps/);
    expect(a.message).toMatch(/No station reaches that point/);
  });
});
