import { useCallback, useEffect, useState } from "react";
import { Button, SafeAreaView, Text, TextInput, View } from "react-native";
import { API } from "./config";
import { session, startTracking, stopTracking } from "./location-task";

type Order = { id: string; state: string; driverId: string | null; actions: { driver: string[] }; dropoff: { label: string } };

// Minimal scaffold: sign in with a seeded driver id, go online, work the assigned order.
// Not built or run yet (see README). The driver actions match the state machine and the HTTP API.
export default function App() {
  const [driverId, setDriverId] = useState("drv-01");
  const [online, setOnline] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!online) return;
    const { orders } = (await (await fetch(`${API}/api/orders?active=1`)).json()) as { orders: Order[] };
    const mine = orders.find((o) => o.driverId === driverId) ?? null;
    session.orderId = mine?.id ?? null;
    setOrder(mine ? ((await (await fetch(`${API}/api/orders/${mine.id}`)).json()) as { order: Order }).order : null);
  }, [online, driverId]);

  useEffect(() => {
    const t = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const post = (path: string, body?: unknown) =>
    fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  const goOnline = async () => {
    try {
      session.driverId = driverId;
      await startTracking(false);
      await post(`/api/drivers/${driverId}/online`, { lat: -33.93, lng: 18.42 });
      setOnline(true);
    } catch (e) {
      setError(String(e));
    }
  };
  const goOffline = async () => {
    await post(`/api/drivers/${driverId}/offline`);
    await stopTracking().catch(() => {});
    setOnline(false);
    setOrder(null);
  };
  const act = async (type: string) => {
    const res = await post(`/api/orders/${order!.id}/events`, { actor: "driver", actorId: driverId, type });
    if (!res.ok) setError(((await res.json()) as { message?: string }).message ?? "failed");
    await refresh();
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Dispatch driver (simulated)</Text>
      <TextInput value={driverId} onChangeText={setDriverId} editable={!online} accessibilityLabel="Driver id" style={{ borderWidth: 1, padding: 12 }} />
      <Button title={online ? "Go offline" : "Go online"} onPress={online ? goOffline : goOnline} />
      {error && <Text accessibilityRole="alert">{error}</Text>}
      {order ? (
        <View style={{ gap: 8 }}>
          <Text>Order {order.id.slice(-8)}: {order.state}</Text>
          <Text>Drop-off: {order.dropoff.label}</Text>
          {order.actions.driver.map((t) => (
            <Button key={t} title={t.replaceAll("_", " ")} onPress={() => void act(t)} />
          ))}
        </View>
      ) : (
        online && <Text>Waiting for a job…</Text>
      )}
    </SafeAreaView>
  );
}
