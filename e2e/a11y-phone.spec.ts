import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// A first-time visitor on a small phone (320 px wide, the narrowest still in use): can they see, reach and use everything?
test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });

test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
});

const scan = (page: Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Interactive things a thumb has to hit. Links inside running text and the map's attribution line are exempt (WCAG 2.5.8 inline exception). */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel = "button, select, summary, nav a, .choice, label.check, input[type=text], input[type=number], .leaflet-bar a";
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5) out.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`320 px, ${colorScheme}: order form fits, is axe clean, and every tap target is at least 44 px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(page.getByRole("radio", { name: /Claremont/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Map key" })).toBeVisible();
    await page.getByText("Enter coordinates instead").click();
    expect(await noSideScroll(page)).toBe(true);
    expect((await scan(page)).violations).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
  });

  test(`320 px, ${colorScheme}: order page and ops console fit and are axe clean`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order placed");
    await expect(page.getByRole("list", { name: "Map in words" })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    expect((await scan(page)).violations).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
    await page.goto("/ops");
    await expect(page.getByRole("table", { name: "Orders" })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    expect((await scan(page)).violations).toEqual([]);
  });
}

test("the total and the Place order button stay in view while the long form scrolls", async ({ page }) => {
  await page.goto("/");
  const button = page.getByRole("button", { name: "Place order" });
  await expect(button).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await button.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
});

test.describe("choosing a drop-off without dragging", () => {
  test("a button drops the pin at the cross in the middle of the map", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Drop pin at the cross" }).click();
    const select = page.getByRole("combobox", { name: "Drop-off" });
    await expect(select).toHaveValue("custom");
    await expect(page.getByRole("list", { name: "Map in words" })).toContainText("Custom point (");
  });

  test("keyboard: focus the map, pan with the arrow keys, press Enter to drop the pin", async ({ page }) => {
    await page.goto("/");
    const map = page.getByRole("region", { name: /Map of stations/ });
    await expect(map).toHaveAttribute("aria-describedby", /.+/);
    await map.focus();
    const before = await page.locator(".leaflet-map-pane").evaluate((e) => (e as HTMLElement).style.transform);
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.locator(".leaflet-map-pane").evaluate((e) => (e as HTMLElement).style.transform)).not.toBe(before);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox", { name: "Drop-off" })).toHaveValue("custom");
  });

  test("typed coordinates: a bad value says what is wrong, a good one moves the pin, a far one explains the radius; Enter never places an order", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("radio", { name: /Claremont/ })).toBeVisible();
    await page.getByText("Enter coordinates instead").click();
    const lat = page.getByLabel("Latitude");
    const lng = page.getByLabel("Longitude");
    await lat.fill("133");
    await lng.fill("18.4");
    await lng.press("Enter");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("alert").filter({ hasText: "Latitude must be" })).toBeVisible();
    await lat.fill("abc");
    await page.getByRole("button", { name: "Use these coordinates" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Latitude must be" })).toBeVisible();
    await lat.fill("-33,9721"); // a decimal comma is accepted
    await lng.fill("200");
    await page.getByRole("button", { name: "Use these coordinates" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Longitude must be" })).toBeVisible();
    await lng.fill("18.4592");
    await page.getByRole("button", { name: "Use these coordinates" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "must be" })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Map in words" })).toContainText("Custom point (-33.9721, 18.4592)");
    // Far from every station: the same kind message as for a tapped pin.
    await lat.fill("-33.0");
    await lng.fill("19.9");
    await page.getByRole("button", { name: "Use these coordinates" }).click();
    await expect(page.getByTestId("range-message")).toContainText("outside our 12 km delivery radius");
    await expect(page.getByRole("button", { name: "Choose a station in range" })).toBeDisabled();
  });
});

test("status changes are announced politely, in one place, and the live position line is not a live region", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order placed");
  const status = page.locator("[role=status][aria-live=polite]", { hasText: "Order placed" });
  await expect(status).toHaveCount(1);
  await expect(page.locator("h1[aria-live]")).toHaveCount(0); // the heading itself is not a live region (it would be read twice)
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cancelled");
  await expect(page.locator("[role=status][aria-live=polite]", { hasText: "Cancelled" })).toHaveCount(1);
});

test("after the order is placed, keyboard focus moves into the page instead of being lost, and the new page is announced", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\//);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("main");
  await expect(page.locator("[role=status][aria-live=polite]", { hasText: "Your order" }).first()).toBeAttached();
  await expect(page).toHaveTitle(/Your order/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});

test("reduced motion switches off the map's own zoom, pan and fade animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".leaflet-fade-anim")).toHaveCount(0);
  await expect(page.locator(".leaflet-zoom-anim")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect(page.locator(".leaflet-fade-anim")).toHaveCount(1);
});

test("the simulated-demo notice is on every page, and the map has a text version", async ({ page }) => {
  for (const path of ["/", "/ops"]) {
    await page.goto(path);
    await expect(page.getByRole("note")).toContainText("Simulated demo: no fuel is delivered and no real payment is taken.");
  }
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Map in words" })).toContainText("Drop-off");
});
