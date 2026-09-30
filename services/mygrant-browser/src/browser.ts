/**
 * Playwright browser session manager for MyGrant.
 *
 * Keeps a single warm Chromium instance with one page. Ensures the page is
 * logged into MyGrant before any fetch, re-logging-in if the session expired.
 * All MyGrant credentials come from environment variables (set as Fly.io
 * secrets by the shop owner — never in code or chat).
 */
import { chromium, Browser, Page } from "playwright";

const MYGRANT_BASE = "https://www.mygrantglass.com";
const LOGIN_URL = `${MYGRANT_BASE}/pages/login.aspx`;

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export class MyGrantBrowser {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private loginInFlight: Promise<void> | null = null;

  /** Launch Chromium (once). Call at startup. */
  async launch(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    this.page = await context.newPage();
    // Human pacing: don't hammer the site.
    this.page.setDefaultTimeout(30000);
    this.page.setDefaultNavigationTimeout(30000);
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  private getPage(): Page {
    if (!this.page) throw new Error("Browser not launched");
    return this.page;
  }

  /** True when the current page shows the login form. */
  private async isLoginPage(): Promise<boolean> {
    const page = this.getPage();
    return (await page.locator("input[name='clogin:TxtUsername']").count()) > 0;
  }

  /** True when the page looks authenticated (logout link, no login form). */
  private async isAuthenticatedPage(): Promise<boolean> {
    const page = this.getPage();
    const html = await page.content();
    return /logout/i.test(html) && !(await this.isLoginPage());
  }

  /**
   * Log into MyGrant via the real login form. Single-flight: concurrent
   * callers share one login attempt.
   */
  async ensureLoggedIn(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const page = this.getPage();
    if (await this.isAuthenticatedPage()) return;

    const username = requiredEnv("MYGRANT_USERNAME");
    const password = requiredEnv("MYGRANT_PASSWORD");

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.fill("input[name='clogin:TxtUsername']", username);
    await page.fill("input[name='clogin:TxtPassword']", password);
    // Small human-like pause before submitting.
    await page.waitForTimeout(800);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("input[name='clogin:ButtonLogin']"),
    ]);

    if (!(await this.isAuthenticatedPage())) {
      const title = await page.title();
      throw new Error(
        `MyGrant login failed (post-login page title: "${title}"). ` +
          `Check MYGRANT_USERNAME / MYGRANT_PASSWORD.`
      );
    }
  }

  /**
   * Navigate to a MyGrant URL as the logged-in user and return the rendered
   * HTML. Re-logs-in once if the session expired mid-flow.
   */
  async fetchPage(url: string): Promise<{ html: string; finalUrl: string }> {
    const page = this.getPage();
    await this.ensureLoggedIn();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (await this.isLoginPage()) {
      // Session expired — log in again and retry once.
      await this.doLogin();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      if (await this.isLoginPage()) {
        throw new Error("MyGrant session could not be re-established.");
      }
    }
    // Let any client-side rendering settle.
    await page.waitForTimeout(1000);
    return { html: await page.content(), finalUrl: page.url() };
  }
}
