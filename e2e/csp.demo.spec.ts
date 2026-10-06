import { expect, test, type Page } from "@playwright/test";

// Runs on the demo server (port 8788, no background simulator), because "Run demo" needs an order nobody else moves.
// The dev server serves apps/web/public/_headers, the file Cloudflare serves in production, so this tests the deployed policy.
//
// OpenStreetMap tiles are answered with a 1x1 image instead of being aborted: a blocked request and an aborted one look the same
// to the page, so aborting would hide a tile host the policy forgot to allow.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function watchCsp(page: Page) {
  const violations: string[] = [];
  const tiles: string[] = [];
  await page.exposeFunction("__cspViolation", (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  page.on("console", (m) => {
    if (/Content Security Policy|violates the following|Refused to/i.test(m.text())) violations.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => {
    if (/Content Security Policy|unsafe-eval/i.test(e.message)) violations.push(`pageerror: ${e.message}`);
  });
  await page.route("https://tile.openstreetmap.org/**", (r) => {
    tiles.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
  });
  return { violations, tiles };
}

test("the detector works: an inline script is reported as a violation", async ({ page }) => {
  const w = await watchCsp(page);
  await page.goto("/");
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__ran = 1";
    document.head.append(s);
  });
  await expect.poll(() => w.violations.length).toBeGreaterThan(0);
  expect(w.violations.join("\n")).toContain("script-src");
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
});

test("no CSP violation across place order, pay, Run demo, delivery and the ops console", async ({ page }) => {
  test.setTimeout(170_000);
  const w = await watchCsp(page);

  // The headline of the policy, on the very document the browser got.
  const doc = await page.goto("/");
  const h = doc!.headers();
  expect(h["content-security-policy"]).toContain("script-src 'self'");
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toContain("https://tile.openstreetmap.org");

  // Place: exercise the map (pick by list, by tapping the map, by coordinates) so Leaflet draws its markers, circles and controls.
  await page.getByRole("radio", { name: /Claremont Forecourt/ }).check();
  await page.getByLabel("Litres").fill("30");
  await page.getByRole("combobox", { name: "Drop-off" }).selectOption({ label: "Newlands, Main Road" });
  await expect(page.locator(".pin-dropoff")).toHaveCount(1);
  await page.locator(".map").click({ position: { x: 60, y: 60 } });
  await expect(page.getByRole("combobox", { name: "Drop-off" })).toHaveValue("custom");
  await page.getByRole("combobox", { name: "Drop-off" }).selectOption({ label: "Newlands, Main Road" });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);

  // Pay, Run demo, delivery.
  await page.getByRole("button", { name: /Pay R.* with test card/ }).click();
  await expect(page.getByTestId("payment-status")).toHaveText("succeeded");
  await page.getByRole("button", { name: "Run demo" }).click();
  await expect(page.locator(".pin-driver")).toHaveCount(1, { timeout: 40_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Delivered", { timeout: 110_000 });

  // Ops console (the dev server leaves it open): table, event log, map.
  await page.goto("/ops");
  await expect(page.getByRole("table", { name: "Orders" })).toBeVisible();
  await page.getByLabel("Include finished orders").check(); // this order is already delivered
  await page.getByRole("table", { name: "Orders" }).getByRole("button", { name: /event log for order/ }).first().click();
  await expect(page.getByRole("heading", { name: /Event log/ })).toBeVisible();
  await expect(page.locator(".leaflet-container")).toBeVisible();

  expect(w.tiles.length, "map tiles were requested from tile.openstreetmap.org and allowed").toBeGreaterThan(0);
  expect(w.violations, w.violations.join("\n")).toEqual([]);
});
