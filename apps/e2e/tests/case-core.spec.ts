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

  // VIN-first flow: paste VIN, decode via NHTSA, pick glass, create.
  // Use the textbox role: the photo button ("Upload a photo of the VIN")
  // accessible name also contains "VIN", which breaks getByLabel("VIN")
  // strict mode.
  await page.getByRole("textbox", { name: "VIN" }).fill("1C4HJXEG3JW224862");
  await page.getByRole("button", { name: "Decode VIN" }).click();
  // NHTSA decodes this VIN to 2018 Jeep Wrangler (make arrives uppercase).
  await expect(page.getByText(/2018 jeep wrangler/i)).toBeVisible();
  await page.getByRole("button", { name: "Windshield" }).click();

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

  // Creation now shows a live progress view (intake left, activity stream
  // right) while identification runs in the background, then hands off to
  // the case detail screen on a terminal event.
  await expect(page.getByRole("heading", { name: "Creating case…" })).toBeVisible();

  await expect(page.locator("h1")).toHaveText(/^RRA-\d{6}$/, { timeout: 60000 });
  await expect(page.getByRole("heading", { name: "Vehicle / Service" })).toBeVisible();
  await expect(page.getByTestId("case-channel")).toHaveText("DIRECT");
  // Exact match: the identification summary also shows the candidate
  // description ("2018 JEEP Wrangler Windshield"), which contains this string.
  // NHTSA returns the make uppercase, so match case-insensitively.
  await expect(page.getByText(/2018 jeep wrangler/i).first()).toBeVisible();
  await expect(page.getByText("1C4HJXEG3JW224862")).toBeVisible();
  // Phase 2: identification auto-runs after intake; the 2018 Jeep Wrangler
  // resolves to a single catalog candidate.
  // Phase 3: sourcing + pricing auto-advance from GLASS_IDENTIFIED.
  await expect(page.getByText("PRICE_APPROVED")).toBeVisible();
  // Detail cards: Vehicle / Service, Supplier Sourcing, Pricing, Activity.
  await expect(page.getByRole("heading", { name: "Vehicle / Service" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Supplier sourcing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  // No staff action is required on an auto-advanced case: no alert card.
  await expect(page.getByRole("alert")).not.toBeVisible();

  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  // Each activity entry shows a plain-English summary; expand it for the raw event.
  const createdEntry = page.getByRole("button", { name: /Case opened in the Direct channel/ });
  await expect(createdEntry).toBeVisible();
  await createdEntry.click();
  await expect(page.getByText("CASE_CREATED")).toBeVisible();

  const reference = await page.locator("h1").textContent();
  expect(reference).toMatch(/^RRA-\d{6}$/);

  await page.getByRole("button", { name: /Case Queue/i }).click();

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();
  const caseCard = page.locator(".case-card", { hasText: reference! });
  await expect(caseCard).toBeVisible();
  await expect(caseCard.getByText(/2018 jeep wrangler/i)).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: "Case Queue" })).toBeVisible();
  await expect(caseCard).toBeVisible();
  await expect(caseCard.getByText(/2018 jeep wrangler/i)).toBeVisible();
});

test("Case Core browser path does not expose paid VIN lookup action", async ({ page }) => {
  await page.goto("/");
  await signInIfRequired(page);
  await page.getByRole("button", { name: /New Case/i }).click();

  await expect(page.getByRole("button", { name: /VIN lookup/i })).toHaveCount(0);
});
