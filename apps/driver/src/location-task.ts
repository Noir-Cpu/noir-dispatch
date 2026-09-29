import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { API } from "./config";

export const LOCATION_TASK = "dispatch-driver-location";

// Shared with the UI through module state; a real app would persist this (the task can run with the UI dead).
export const session: { driverId: string | null; orderId: string | null } = { driverId: null, orderId: null };

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !session.driverId) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const last = locations.at(-1);
  if (!last) return;
  // Active delivery: every ~5 s. Idle drivers use a coarser interval (see startTracking).
  await fetch(`${API}/api/drivers/${session.driverId}/location`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lat: last.coords.latitude, lng: last.coords.longitude, orderId: session.orderId ?? undefined }),
  }).catch(() => {});
});

export async function startTracking(active: boolean) {
  const fg = await Location.requestForegroundPermissionsAsync();
  const bg = fg.granted ? await Location.requestBackgroundPermissionsAsync() : fg;
  if (!bg.granted) throw new Error("background location permission denied");
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: active ? 5_000 : 30_000,
    distanceInterval: 0,
    foregroundService: { notificationTitle: "Dispatch", notificationBody: "Sharing your position for the delivery" },
  });
}

export const stopTracking = () => Location.stopLocationUpdatesAsync(LOCATION_TASK);
