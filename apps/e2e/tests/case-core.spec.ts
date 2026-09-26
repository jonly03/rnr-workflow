import { expect, test } from "@playwright/test";

test("Case Core create → detail → activity → queue survives refresh", async ({ page }) => {
  page.on("request", request => {
    if (request.url().includes("/api/")) {
      console.log("[browser request]", request.method(), request.url());
    }
  });
  page.on("response", response => {
    if (response.url().includes("/api/")) {
      console.log("[browser response]", response.status(), response.url());
    }
  });
  page.on("requestfailed", request => {
    if (request.url().includes("/api/")) {
      console.log("[browser request failed]", request.failure()?.errorText, request.url());
    }
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();

  await page.getByRole("button", { name: /New Case/i }).click();

  await page.getByLabel("Channel").selectOption("DIRECT");
  await page.getByLabel("Year").fill("2018");
  await page.getByLabel("Make").fill("Jeep");
  await page.getByLabel("Model").fill("Wrangler");
  await page.getByLabel("VIN").fill("1C4HJXEG3JW224862");
  await page.getByLabel("Requested glass type").selectOption("WINDSHIELD");

  const createResponsePromise = page.waitForResponse(
    response =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/cases") &&
      response.status() >= 200 &&
      response.status() < 300
  );

  await page.getByRole("button", { name: "Create Case" }).click();

  const createResponse = await createResponsePromise;
  const createBody = await createResponse.text();
  expect(
    createResponse.status(),
    `Create Case request failed with ${createResponse.status()}: ${createBody}`
  ).toBeGreaterThanOrEqual(200);
  expect(createResponse.status()).toBeLessThan(300);

  await expect(page.locator(".eyebrow", { hasText: "DIRECT" })).toBeVisible();
  await expect(page.getByText("2018 Jeep Wrangler")).toBeVisible();
  await expect(page.getByText("1C4HJXEG3JW224862")).toBeVisible();
  await expect(page.getByText("Request Received")).toBeVisible();
  await expect(page.getByText("REQUEST_RECEIVED")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("CASE_CREATED")).toBeVisible();

  const reference = await page.locator("h1").textContent();
  expect(reference).toMatch(/^RRA-\d{6}$/);

  await page.getByRole("button", { name: /Case Queue/i }).click();

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();
  await expect(page.getByText(reference!)).toBeVisible();
  await expect(page.getByText("2018 Jeep Wrangler")).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();
  await expect(page.getByText(reference!)).toBeVisible();
  await expect(page.getByText("2018 Jeep Wrangler")).toBeVisible();
});

test("Case Core browser path does not expose paid VIN lookup action", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New Case/i }).click();

  await expect(page.getByRole("button", { name: /VIN lookup/i })).toHaveCount(0);
});
