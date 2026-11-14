// Smoke test for the Shop Ops Brain app (app.js) without a browser.
// Builds a stub DOM + localStorage + fetch, loads parser.js, logic.js
// and app.js in a VM context, then clicks through every tab and the
// main flows, asserting no exceptions and that key strings render.
// Run: node tests/smoke_test.js
// Exit 0 = all checks pass.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SHOPOPS = path.join(__dirname, "..");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  [OK] " + name); }
  catch (e) { fail++; console.log("  [FAIL] " + name + " — " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertContains(hay, needle, msg) {
  assert(String(hay || "").indexOf(needle) !== -1, (msg || "expected to contain") + ": " + needle);
}

/* ---- stub DOM ---- */
function makeClassList() {
  const s = new Set();
  return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
}
function makeEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", checked: false,
    dataset: {}, classList: makeClassList(), style: {},
    _listeners: {},
    addEventListener: function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    click: function () { (this._listeners.click || []).forEach((fn) => fn({ preventDefault: () => {} })); },
    change: function () { (this._listeners.change || []).forEach((fn) => fn({})); },
    insertAdjacentHTML: function (pos, html) { this.innerHTML += html; },
    querySelectorAll: function () { return []; },
  };
  return el;
}
const elements = {};
function getEl(id) { return (elements[id] = elements[id] || makeEl(id)); }
const tabButtons = ["intake", "jobs", "order", "invoice", "profit", "brief", "tech", "pricing"]
  .map((t) => { const b = makeEl("tabbtn-" + t); b.dataset.tab = t; return b; });
const tabSections = ["intake", "jobs", "order", "invoice", "profit", "brief", "tech", "pricing"]
  .map((t) => makeEl("tab-" + t));

const store = {};
const sandbox = {
  console,
  setTimeout, clearTimeout,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  alert: (m) => { sandbox.__alerts.push(m); },
  confirm: () => true,
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
  Blob: function () {},
  FileReader: function () {},
  fetch: (url) => {
    let file = null;
    if (url.indexOf("config/pricing.json") !== -1) file = path.join(SHOPOPS, "config", "pricing.json");
    else if (url.indexOf("fixtures/synthetic-referral-1.txt") !== -1) file = path.join(SHOPOPS, "fixtures", "synthetic-referral-1.txt");
    else if (url.indexOf("fixtures/synthetic-jobs.json") !== -1) file = path.join(SHOPOPS, "fixtures", "synthetic-jobs.json");
    else if (url.indexOf("vpic.nhtsa.dot.gov") !== -1) return Promise.reject(new Error("NHTSA not stubbed"));
    if (!file) return Promise.reject(new Error("fetch stub: unknown URL " + url));
    const text = fs.readFileSync(file, "utf8");
    return Promise.resolve({ ok: true, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) });
  },
  __alerts: [],
};
sandbox.window = sandbox;
sandbox.document = {
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) => {
    if (sel === "#tabs button") return tabButtons;
    if (sel === "section.tab") return tabSections;
    return [];
  },
  createElement: (tag) => makeEl("created-" + tag),
};
sandbox.document.defaultView = sandbox;

vm.createContext(sandbox);
["parser.js", "logic.js", "app.js"].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(SHOPOPS, f), "utf8"), sandbox, { filename: f });
});

function clickTab(name) {
  const btn = tabButtons.find((b) => b.dataset.tab === name);
  btn._listeners.click.forEach((fn) => fn({}));
}
function clickEl(id) { getEl(id).click(); }

console.log("Smoke test — app loads and every tab renders:");
check("app loaded without throwing; jobs tab renders empty state", () => {
  assertContains(getEl("jobs-list").innerHTML, "No jobs yet");
});
check("load 8 synthetic demo jobs", () => {
  clickEl("load-fixtures");
  assertContains(getEl("intake-result").innerHTML, "8 synthetic demo jobs");
  assertContains(getEl("jobs-list").innerHTML, "700006");
  assertContains(getEl("jobs-list").innerHTML, "Sara Wilson");
});
check("every tab renders without throwing", () => {
  ["jobs", "order", "invoice", "profit", "brief", "tech", "pricing", "intake"].forEach(clickTab);
});
check("order tab shows a draft for a booked job", () => {
  clickTab("order");
  // A real browser auto-selects the first <option>; the stub select
  // needs the value set explicitly, then a change event.
  getEl("order-job").value = "job-700002";
  getEl("order-job").change();
  assertContains(getEl("order-draft").innerHTML, "C034125-001");
  assertContains(getEl("order-draft").innerHTML, "FW02584 GTY");
});
check("record glass cost from the order tab", () => {
  getEl("glass-cost").value = "154.95";
  getEl("glass-tax").value = "4.46";
  clickEl("save-glass-cost");
  assertContains(getEl("order-result").innerHTML, "recorded against job #700002");
});
check("invoice draft: 10-day clock, W-9 reminder, approved-amount flag", () => {
  clickTab("invoice");
  getEl("invoice-job").value = "job-700006";
  getEl("invoice-job").change();
  const html = getEl("invoice-draft").innerHTML;
  assertContains(html, "2026-10-28"); // install 2026-10-18 + 10 days
  assertContains(html, "W-9 REMINDER");
  assertContains(html, "approved amount, not confirmed billed total, NOT money received");
  assertContains(html, "$1,117.58");
  // Today is past 2026-10-28, so the overdue branch (the one that had
  // the syntax error) must render instead of throwing.
  assertContains(html, "OVERDUE");
});
check("profit tab shows the math with glue counted once", () => {
  clickTab("profit");
  const html = getEl("profit-table").innerHTML;
  assertContains(html, "$22.66");
  assertContains(html, "Counted here only");
});
check("daily brief for 2026-10-18 shows the HR-V install + deadline", () => {
  clickTab("brief");
  getEl("brief-date").value = "2026-10-18";
  clickEl("brief-go");
  const html = getEl("brief-result").innerHTML;
  assertContains(html, "700006");
  assertContains(html, "2026-10-28");
  assertContains(html, "google.com/maps/dir");
});
check("daily brief for an empty date never claims the day is clear", () => {
  getEl("brief-date").value = "2026-11-20";
  clickEl("brief-go");
  const html = getEl("brief-result").innerHTML;
  assertContains(html, "does <strong>not</strong> mean the shop is free");
});
check("tech helper shows recalibration + variant warning for job 700006", () => {
  clickTab("tech");
  getEl("tech-job").value = "job-700006";
  getEl("tech-job").change();
  const html = getEl("tech-job-result").innerHTML;
  assertContains(html, "REQUIRED on the referral sheet");
  assertContains(html, "does NOT give the exact variant");
});
check("paste path: synthetic sheet text parses to #700006", () => {
  clickTab("intake");
  const text = fs.readFileSync(path.join(SHOPOPS, "fixtures", "synthetic-referral-1.txt"), "utf8");
  getEl("pastetext").value = text;
  clickEl("parse-paste");
  assertContains(getEl("intake-result").innerHTML, "700006");
  assertContains(getEl("intake-result").innerHTML, "Sara Wilson");
});

console.log("\nsmoke_test: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
