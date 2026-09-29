import type { Driver, Station, Store } from "@noir/core";

/** Fictional stations at real Cape Town coordinates. Prices are made-up demo numbers, cents per litre. */
export const CAPE_TOWN_STATIONS: Station[] = [
  { id: "st-cbd", name: "Foreshore Fuel Stop", lat: -33.9187, lng: 18.4318, rating: 4.4, prices: { diesel: 2350, petrol_95: 2410 } },
  { id: "st-sea-point", name: "Sea Point Depot", lat: -33.9169, lng: 18.3856, rating: 4.1, prices: { diesel: 2365, petrol_95: 2410 } },
  { id: "st-claremont", name: "Claremont Forecourt", lat: -33.9825, lng: 18.4661, rating: 4.6, prices: { diesel: 2340, petrol_95: 2410 } },
  { id: "st-bellville", name: "Bellville Fuel Yard", lat: -33.9, lng: 18.6296, rating: 3.9, prices: { diesel: 2320, petrol_95: 2410 } },
  { id: "st-century-city", name: "Century City Pumps", lat: -33.8917, lng: 18.5116, rating: 4.3, prices: { diesel: 2355, petrol_95: 2410 } },
];

/** Bounding box the simulator keeps drivers and customers inside (Cape Town metro core). */
export const CAPE_TOWN_BOX = { south: -34.02, north: -33.86, west: 18.38, east: 18.65 };

export async function seedStations(store: Store, stations = CAPE_TOWN_STATIONS) {
  for (const s of stations) await store.upsertStation(s);
}

export async function seedDrivers(store: Store, drivers: Driver[]) {
  for (const d of drivers) await store.upsertDriver(d);
}
