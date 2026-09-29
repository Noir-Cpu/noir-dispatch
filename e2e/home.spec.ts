import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("home page renders and reaches the API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "NOIR Template" })).toBeVisible();
  await expect(page.getByText(/API: ok/i)).toBeVisible();
});

test("brand display font is applied to the heading", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const family = await page.getByRole("heading", { name: "NOIR Template" }).evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain("Archivo");
  expect(await page.evaluate(() => document.fonts.check('900 1em "Archivo Variable"'))).toBe(true);
});

test("has no detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/API: ok/i)).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(res.headers()["x-request-id"]).toBeTruthy();
});
