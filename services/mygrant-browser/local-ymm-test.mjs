// local-ymm-test.mjs — decisive local test for the Fly-IP-vs-headless-client question.
//
// Launches YOUR installed Google Chrome (no Playwright browser download needed),
// logs into MyGrant, and runs the same 2018 Jeep YMM query the staging service runs.
//
//   nonzero vehicle count  => Fly's datacenter IP was the problem
//   zero vehicles          => the headless automation client (or the query) is the problem
//
// Run from services/mygrant-browser/:
//   npm install                                    # playwright JS library only; no browser download
//   MYGRANT_USERNAME=... MYGRANT_PASSWORD=... node local-ymm-test.mjs
// (use your MyGrant login — the same one stored as the Fly secrets)

import { chromium } from "playwright";

const BASE = "https://www.mygrantglass.com";
const LOGIN_URL = `${BASE}/pages/login.aspx`;
const username = process.env.MYGRANT_USERNAME;
const password = process.env.MYGRANT_PASSWORD;

if (!username || !password) {
  console.error("Set MYGRANT_USERNAME and MYGRANT_PASSWORD in your terminal first.");
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch({
    channel: "chrome", // installed Google Chrome — skips the Playwright CDN download
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
} catch (err) {
  console.error(
    "Could not launch installed Chrome via channel 'chrome'. Is Google Chrome installed?\n" +
      `Playwright said: ${err.message}`
  );
  process.exit(1);
}
console.log("Launched installed Chrome (no download needed)");

const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.setDefaultNavigationTimeout(30000);

try {
  // Login (same form the browser service uses).
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill("input[name='clogin:TxtUsername']", username);
  await page.fill("input[name='clogin:TxtPassword']", password);
  await page.waitForTimeout(800);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.click("input[name='clogin:ButtonLogin']"),
  ]);
  const loggedIn = /logout/i.test(await page.content());
  console.log(loggedIn ? "MyGrant login OK" : "WARNING: login page still showing");
  if (!loggedIn) throw new Error("MyGrant login failed — check MYGRANT_USERNAME / MYGRANT_PASSWORD");

  // Same YMM query as the API's searchYmmVehicles: 2018 Jeep, model prefix "W".
  let total = 0;
  for (const make of ["Jeep", "JEEP"]) {
    const url =
      `${BASE}/pages/searchm.aspx?` +
      new URLSearchParams({ yr: "2018", mk: make, md: "W", smdo: "Search" }).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const container = page.locator("#cms_DivModels");
    if ((await container.count()) === 0) {
      console.log(`make=${make}: no #cms_DivModels container (page may have changed)`);
      continue;
    }
    const links = container.locator("li a");
    const n = await links.count();
    total += n;
    console.log(`make=${make}: ${n} vehicle(s)`);
    for (let i = 0; i < Math.min(n, 10); i++) {
      console.log("  -", (await links.nth(i).innerText()).trim());
    }
    if (n > 0) break;
  }

  console.log("---");
  if (total > 0) {
    console.log(`RESULT: ${total} vehicle(s) from your Mac — Fly's datacenter IP was the problem.`);
  } else {
    console.log("RESULT: 0 vehicles from your Mac too — the headless client (or query) is the problem, not Fly's IP.");
  }
} finally {
  await browser.close();
}
