import type { Driver, Station, Store } from "@noir/core";

/**
 * Fictional stations (made-up names, no real brands) placed at approximate real area centres: not real forecourts.
 * Prices are made-up demo numbers, cents per litre. The first five are the original metro-core stations; the in-process
 * and HTTP simulators keep using only these (SIM_STATIONS) so their drivers and their published benchmark stay comparable.
 */
export const SIM_STATIONS: Station[] = [
  { id: "st-cbd", name: "Foreshore Fuel Stop", lat: -33.9187, lng: 18.4318, rating: 4.4, prices: { diesel: 2350, petrol_95: 2410 } },
  { id: "st-sea-point", name: "Sea Point Depot", lat: -33.9169, lng: 18.3856, rating: 4.1, prices: { diesel: 2365, petrol_95: 2410 } },
  { id: "st-claremont", name: "Claremont Forecourt", lat: -33.9825, lng: 18.4661, rating: 4.6, prices: { diesel: 2340, petrol_95: 2410 } },
  { id: "st-bellville", name: "Bellville Fuel Yard", lat: -33.9, lng: 18.6296, rating: 3.9, prices: { diesel: 2320, petrol_95: 2410 } },
  { id: "st-century-city", name: "Century City Pumps", lat: -33.8917, lng: 18.5116, rating: 4.3, prices: { diesel: 2355, petrol_95: 2410 } },
];

/** Added for the public demo, so more of Cape Town and the winelands can order. Seeded by the deploy workflow. */
export const EXTRA_STATIONS: Station[] = [
  { id: "st-stellenbosch", name: "Eikestad Fuel Depot", lat: -33.9346, lng: 18.8602, rating: 4.5, prices: { diesel: 2345, petrol_95: 2405 } },
  { id: "st-somerset-west", name: "Helderberg Forecourt", lat: -34.0782, lng: 18.843, rating: 4.2, prices: { diesel: 2335, petrol_95: 2400 } },
  { id: "st-paarl", name: "Paarl Rock Pumps", lat: -33.7342, lng: 18.9621, rating: 4.0, prices: { diesel: 2330, petrol_95: 2395 } },
  { id: "st-durbanville", name: "Durbanville Hills Depot", lat: -33.8326, lng: 18.6489, rating: 4.4, prices: { diesel: 2350, petrol_95: 2410 } },
  { id: "st-table-view", name: "Blouberg Bay Fuel", lat: -33.8244, lng: 18.4902, rating: 4.3, prices: { diesel: 2360, petrol_95: 2420 } },
  { id: "st-mitchells-plain", name: "Town Centre Pumps", lat: -34.0495, lng: 18.6217, rating: 3.8, prices: { diesel: 2325, petrol_95: 2390 } },
  { id: "st-muizenberg", name: "Muizenberg Beachfront Fuel", lat: -34.1086, lng: 18.4713, rating: 4.1, prices: { diesel: 2370, petrol_95: 2430 } },
  { id: "st-constantia", name: "Constantia Valley Forecourt", lat: -34.0241, lng: 18.4182, rating: 4.7, prices: { diesel: 2355, petrol_95: 2415 } },
  { id: "st-hout-bay", name: "Hout Bay Harbour Pumps", lat: -34.048, lng: 18.356, rating: 4.2, prices: { diesel: 2380, petrol_95: 2440 } },
  { id: "st-brackenfell", name: "Brackenfell Junction Fuel", lat: -33.8702, lng: 18.6903, rating: 3.9, prices: { diesel: 2330, petrol_95: 2400 } },
];

export const CAPE_TOWN_STATIONS: Station[] = [...SIM_STATIONS, ...EXTRA_STATIONS];

/** Bounding box the simulator keeps drivers and customers inside (Cape Town metro core). */
export const CAPE_TOWN_BOX = { south: -34.02, north: -33.86, west: 18.38, east: 18.65 };

/** Idempotent: an upsert per station, so it is safe to run on every deploy and against production. */
export async function seedStations(store: Store, stations = CAPE_TOWN_STATIONS) {
  for (const s of stations) await store.upsertStation(s);
}

export async function seedDrivers(store: Store, drivers: Driver[]) {
  for (const d of drivers) await store.upsertDriver(d);
}
