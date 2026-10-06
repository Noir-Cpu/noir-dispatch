import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
});

const dropoff = (page: Page, label: string) => page.getByRole("combobox", { name: "Drop-off" }).selectOption({ label });

test("a pin outside every station's radius gets a kind message and cannot be ordered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: /Claremont/ })).toBeVisible();
  await dropoff(page, "Franschhoek, Huguenot Road");
  const msg = page.getByTestId("range-message");
  await expect(msg).toContainText("outside our 12 km delivery radius");
  await expect(msg).toContainText("No station reaches that point");
  await expect(page.getByRole("button", { name: "Choose a station in range" })).toBeDisabled();
  // Every station that is not the selected one is disabled and says why. Only three are listed up front; the rest are behind one tap.
  await page.getByText(/Show \d+ more stations/).click();
  await expect(page.getByRole("radio", { name: /Foreshore/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Foreshore.*out of range: .* km from your pin, limit 12 km/ })).toBeVisible();
  // The map explains it: radius circles (one emphasised) are drawn, and the legend says what they are.
  await expect(page.getByRole("list", { name: "Map key" })).toContainText("Delivery radius, 12 km");
  await expect(page.locator("path.leaflet-interactive, svg.leaflet-zoom-animated path").first()).toBeVisible();
});

test("the nearest station that can deliver is suggested, and one click switches to it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: /Claremont/ })).toBeChecked();
  await dropoff(page, "Stellenbosch, Dorp Street"); // about 35 km from Claremont
  const msg = page.getByTestId("range-message");
  await expect(msg).toContainText("Claremont Forecourt, outside our 12 km delivery radius");
  await expect(msg).toContainText("Eikestad Fuel Depot");
  await expect(page.getByRole("button", { name: "Choose a station in range" })).toBeDisabled();
  await msg.getByRole("button", { name: "Use Eikestad Fuel Depot" }).click();
  await expect(page.getByTestId("range-message")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Eikestad/ })).toBeChecked();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
});

test("the server refuses an out-of-range order with a 422 that names the radius", async ({ request }) => {
  const res = await request.post("/api/orders", {
    headers: { "idempotency-key": `e2e-${Date.now()}` },
    data: { customerId: "e2e", stationId: "st-claremont", fuel: "diesel", litres: 10, dropoff: { lat: -33.9346, lng: 18.8602, label: "Stellenbosch" } },
  });
  expect(res.status()).toBe(422);
  expect(((await res.json()) as { message: string }).message).toContain("12 km delivery radius");
});

test("only the chosen station and the two nearest are listed up front; the rest are one tap away", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: /Claremont/ })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(3);
  await page.getByText("Show 12 more stations").click();
  await expect(page.getByRole("radio")).toHaveCount(15);
  // Choosing one from the hidden group keeps it on screen.
  await page.getByRole("radio", { name: /Foreshore/ }).check();
  await expect(page.getByRole("radio", { name: /Foreshore/ })).toBeChecked();
});
