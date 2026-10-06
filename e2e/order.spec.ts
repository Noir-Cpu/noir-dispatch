import { expect, test, type Page } from "@playwright/test";

// OSM tiles are third-party network traffic: keep tests hermetic (the attribution control still renders).
test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
});

async function place(page: Page) {
  await page.goto("/");
  await page.getByRole("radio", { name: /Claremont Forecourt/ }).check();
  await page.getByLabel("Litres").fill("30");
  await page.getByRole("combobox", { name: "Drop-off" }).selectOption({ label: "Newlands, Main Road" });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
}

test("place an order, pay, and watch it progress to delivered with the simulator running", async ({ page }) => {
  test.setTimeout(120_000);
  await place(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order placed");

  await page.getByRole("button", { name: /Pay R.* with test card/ }).click();
  await expect(page.getByTestId("payment-status")).toHaveText("succeeded");

  // The simulator's station bot accepts, dispatch assigns a driver, the driver drives and delivers.
  // (At 20x the intermediate headings flash by between polls, so assert the end state and the log.)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delivered", { timeout: 100_000 });
  const history = page.locator("section[aria-labelledby=history]");
  await expect(history.getByText("Order placed")).toBeVisible();
  await expect(history.getByText(/Driver drv-\d+ assigned/).first()).toBeVisible(); // a 3% simulated decline reassigns, so there can be two
  await expect(history.getByText("Driver set off")).toBeVisible();
  await expect(history.getByText("Delivery completed")).toBeVisible();
});

test("the tracking WebSocket delivers live driver positions once a driver is assigned", async ({ page }) => {
  test.setTimeout(120_000);
  await place(page);
  const id = page.url().split("/").pop()!;
  await page.getByRole("button", { name: /Pay R.* with test card/ }).click();
  const first = await page.evaluate(
    (orderId) =>
      new Promise<{ lat: number; lng: number; driverId: string }>((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/api/orders/${orderId}/track`);
        const timer = setTimeout(() => reject(new Error("no position within 90 s")), 90_000);
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === "position") {
            clearTimeout(timer);
            ws.close();
            resolve(m.point);
          }
        };
      }),
    id,
  );
  expect(first.driverId).toMatch(/^drv-\d+$/);
  expect(first.lat).toBeLessThan(-33);
});

test("customer can cancel before a driver is assigned and the payment is cancelled", async ({ page }) => {
  await place(page);
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cancelled");
  await expect(page.locator("p", { hasText: /^Cancelled by customer/ })).toBeVisible();
  await expect(page.getByTestId("payment-status")).toHaveText("canceled");
});

test("ops console shows the order table, and an event log per order", async ({ page }) => {
  await place(page);
  await page.goto("/ops");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Operations");
  const table = page.getByRole("table", { name: "Orders" });
  await expect(table.getByRole("row").nth(1)).toBeVisible();
  await table.getByRole("button", { name: /event log for order/ }).first().click();
  await expect(page.getByRole("heading", { name: /Event log/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "order_placed" }).first()).toBeVisible();
});
