import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
});

const scan = (page: import("@playwright/test").Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();

test("order form has no axe violations and no horizontal scroll", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: /Claremont/ })).toBeVisible();
  expect((await scan(page)).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("order tracking page has no axe violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: /Claremont/ }).check();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Order placed");
  expect((await scan(page)).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("ops console has no axe violations", async ({ page }) => {
  await page.goto("/ops");
  await expect(page.getByRole("table", { name: "Orders" })).toBeVisible();
  expect((await scan(page)).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the order can be placed with the keyboard alone", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: /Foreshore/ })).toBeVisible();
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab");
  await page.getByRole("radio", { name: /Foreshore/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Place order" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/order\//);
});
