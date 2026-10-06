import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Runs against its own server (port 8788, no background simulator), so the only thing moving the order is the "Run demo" button.
test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
});

const scan = (page: Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();

async function placeAndPay(page: Page) {
  await page.goto("/");
  await page.getByRole("radio", { name: /Claremont Forecourt/ }).check();
  await page.getByLabel("Litres").fill("30");
  await page.getByRole("combobox", { name: "Drop-off" }).selectOption({ label: "Newlands, Main Road" });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
  await page.getByRole("button", { name: /Pay R.* with test card/ }).click();
  await expect(page.getByTestId("payment-status")).toHaveText("succeeded");
}

test("place, pay, Run demo, and watch it deliver (axe clean in light and dark, with a legend and a text equivalent)", async ({ page }) => {
  test.setTimeout(150_000);
  await placeAndPay(page);

  // Nothing moves until the visitor asks.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order placed");
  await expect(page.getByRole("heading", { name: "Run demo" })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order placed");

  await page.getByRole("button", { name: "Run demo" }).click();
  await expect(page.getByRole("button", { name: "Pause demo" })).toBeVisible();
  await expect(page.getByTestId("demo-speed")).toContainText("Demo speed: 10x");

  // Legend and the text version of the map, with real names.
  const legend = page.getByRole("list", { name: "Map key" });
  await expect(legend).toContainText("Station");
  await expect(legend).toContainText("Your drop-off");
  const words = page.getByRole("list", { name: "Map in words" });
  await expect(words).toContainText("Station: Claremont Forecourt");
  await expect(words).toContainText("Drop-off: Newlands, Main Road");
  await expect(page.locator(".pin-station")).toHaveCount(1);
  await expect(page.locator(".pin-dropoff")).toHaveCount(1);

  // The driver appears on the map and in the text.
  await expect(page.locator(".pin-driver")).toHaveCount(1, { timeout: 40_000 });
  await expect(legend).toContainText("Driver");
  await expect(words).toContainText(/Driver: .* (from the drop-off|waiting)/);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect((await scan(page)).violations, colorScheme).toEqual([]);
  }

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delivered", { timeout: 110_000 });
  const history = page.locator("section[aria-labelledby=history]");
  await expect(history.getByText(/Driver demo-drv-\d+ assigned/)).toBeVisible();
  await expect(history.getByText("Driver set off")).toBeVisible();
  await expect(history.getByText("Delivery completed")).toBeVisible();
  // Finished: the demo section is gone and nothing keeps polling.
  await expect(page.getByRole("button", { name: "Run demo" })).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect((await scan(page)).violations, `finished, ${colorScheme}`).toEqual([]);
  }
});

/** Screen positions of the driver marker, sampled every 100 ms. */
async function sampleDriver(page: Page, ms: number) {
  const out: { x: number; y: number }[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const box = await page.locator(".pin-driver").first().boundingBox();
    if (box) out.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await page.waitForTimeout(100);
  }
  return out;
}
const steps = (pts: { x: number; y: number }[]) => pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y));

test("the driver glides between updates instead of jumping", async ({ page }) => {
  test.setTimeout(120_000);
  await placeAndPay(page);
  await page.getByRole("button", { name: "Run demo" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Driver on the way", { timeout: 40_000 });
  await page.waitForTimeout(3000); // let the map settle after the driver first appears
  const pts = await sampleDriver(page, 8000);
  const s = steps(pts);
  const total = Math.hypot(pts.at(-1)!.x - pts[0]!.x, pts.at(-1)!.y - pts[0]!.y);
  expect(pts.length).toBeGreaterThan(40);
  expect(total).toBeGreaterThan(15); // it did move
  // Teleporting once per update would put a big share of the whole trip into one sample. Gliding spreads it out.
  expect(Math.max(...s)).toBeLessThan(Math.max(12, total * 0.35));
  expect(s.filter((d) => d > 0.2).length).toBeGreaterThan(pts.length * 0.4); // moving in most frames, not standing still then hopping
});

test("with reduced motion the driver jumps to each new position instead of animating", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await placeAndPay(page);
  await page.getByRole("button", { name: "Run demo" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Driver on the way", { timeout: 40_000 });
  await page.waitForTimeout(3000);
  const pts = await sampleDriver(page, 8000);
  const s = steps(pts);
  const total = Math.hypot(pts.at(-1)!.x - pts[0]!.x, pts.at(-1)!.y - pts[0]!.y);
  expect(total).toBeGreaterThan(15);
  // Standing still between updates, then one hop: most frames do not move, and the biggest hop is a large share of the total.
  expect(s.filter((d) => d < 0.2).length).toBeGreaterThan(pts.length * 0.6);
  expect(Math.max(...s)).toBeGreaterThan(total * 0.15);
});

test("a wrong order token cannot run the demo", async ({ page, request }) => {
  await placeAndPay(page);
  const id = page.url().split("/").pop()!;
  const res = await request.post(`/api/orders/${id}/demo/step`, { headers: { "x-order-token": "0".repeat(32) } });
  expect(res.status()).toBe(403);
});
