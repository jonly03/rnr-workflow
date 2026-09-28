import { expect, test, type Page } from "@playwright/test";

// Staff auth gate: sign in when the login screen is shown.
async function signInIfRequired(page: Page) {
  if (await page.getByRole("heading", { name: "Sign in" }).isVisible()) {
    const email = process.env.E2E_STAFF_EMAIL;
    const password = process.env.E2E_STAFF_PASSWORD;
    if (!email || !password) {
      throw new Error(
        "E2E_STAFF_EMAIL and E2E_STAFF_PASSWORD must be set for the authenticated smoke test."
      );
    }
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
}

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

  await signInIfRequired(page);

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

  await expect(page.locator("h1")).toHaveText(/^RRA-\d{6}$/);
  await expect(page.getByRole("heading", { name: "Vehicle / Service" })).toBeVisible();
  await expect(page.getByTestId("case-channel")).toHaveText("DIRECT");
  // Exact match: the identification summary also shows the candidate
  // description ("2018 Jeep Wrangler Windshield"), which contains this string.
  await expect(page.getByText("2018 Jeep Wrangler", { exact: true })).toBeVisible();
  await expect(page.getByText("1C4HJXEG3JW224862")).toBeVisible();
  // Phase 2: identification auto-runs after intake; the 2018 Jeep Wrangler
  // resolves to a single catalog candidate.
  // Phase 3: sourcing + pricing auto-advance from GLASS_IDENTIFIED.
  await expect(page.getByText("Price Approved")).toBeVisible();
  await expect(page.getByText("PRICE_APPROVED")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Glass identification" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Supplier sourcing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("CASE_CREATED")).toBeVisible();

  const reference = await page.locator("h1").textContent();
  expect(reference).toMatch(/^RRA-\d{6}$/);

  await page.getByRole("button", { name: /Case Queue/i }).click();

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();
  const caseCard = page.locator(".case-card", { hasText: reference! });
  await expect(caseCard).toBeVisible();
  await expect(caseCard.getByText("2018 Jeep Wrangler", { exact: true })).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();
  await expect(caseCard).toBeVisible();
  await expect(caseCard.getByText("2018 Jeep Wrangler", { exact: true })).toBeVisible();
});

test("Case Core browser path does not expose paid VIN lookup action", async ({ page }) => {
  await page.goto("/");
  await signInIfRequired(page);
  await page.getByRole("button", { name: /New Case/i }).click();

  await expect(page.getByRole("button", { name: /VIN lookup/i })).toHaveCount(0);
});
