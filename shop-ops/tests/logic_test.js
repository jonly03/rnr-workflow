// Node tests for shop-ops/logic.js (pure functions) + parser.js.
// Run: node tests/logic_test.js
// Exit 0 = all checks pass. The NHTSA live check is soft: network
// failure prints SKIP, it never fails the suite.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const logic = require("../logic.js");
const { parseReferralText } = require("../parser.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  [OK] " + name); }
  catch (e) { fail++; console.log("  [FAIL] " + name + " — " + e.message); }
}

console.log("Invoice clock (10 days from install):");
check("HR-V install 2026-10-18 -> deadline 2026-10-28", () => {
  assert.strictEqual(logic.invoiceDeadline("2026-10-18"), "2026-10-28");
});
check("Tacoma install by 2026-10-27 -> latest deadline 2026-11-06", () => {
  assert.strictEqual(logic.invoiceDeadline("2026-10-27"), "2026-11-06");
});
check("clock due-today on deadline day", () => {
  const c = logic.invoiceClock({ installDate: "2026-10-18", status: "Installed - Awaiting Invoice" }, "2026-10-28");
  assert.strictEqual(c.state, "due-today"); assert.strictEqual(c.daysLeft, 0);
});
check("clock overdue 1 day past deadline", () => {
  const c = logic.invoiceClock({ installDate: "2026-10-18", status: "Installed - Awaiting Invoice" }, "2026-10-29");
  assert.strictEqual(c.state, "overdue"); assert.strictEqual(c.daysLeft, -1);
});
check("clock not-installed without install date", () => {
  const c = logic.invoiceClock({ installDate: null, status: "Referral Received" }, "2026-10-28");
  assert.strictEqual(c.state, "not-installed");
});
check("clock invoiced once filed", () => {
  const c = logic.invoiceClock({ installDate: "2026-10-18", status: "Invoiced - Awaiting Payment" }, "2026-11-03");
  assert.strictEqual(c.state, "invoiced");
});

console.log("True profit (business-system formulas):");
check("Tacoma-style math: 642.75 - 154.95 - 4.46 - 22.66 - 80.00 = 380.68", () => {
  const p = logic.computeProfit({
    invoiceAmount: 642.75, glassCost: 154.95, salesTax: 4.46,
    laborHours: 2, laborRate: 40, otherJobCosts: 0, glueMode: "per-job"
  });
  assert.strictEqual(p.gross, 483.34);
  assert.strictEqual(p.glue, 22.66);
  assert.strictEqual(p.laborCost, 80);
  assert.strictEqual(p.net, 380.68);
  assert.strictEqual(p.netExcludesLabor, false);
});
check("glue counted once: general-expense mode -> glue $0 here, flagged", () => {
  const p = logic.computeProfit({
    invoiceAmount: 642.75, glassCost: 154.95, salesTax: 4.46,
    laborHours: 2, laborRate: 40, otherJobCosts: 0, glueMode: "general-expense"
  });
  assert.strictEqual(p.glue, 0);
  assert.ok(p.glueNote.indexOf("general Expenses") !== -1);
  assert.strictEqual(p.net, 403.34); // 483.34 - 0 - 80
});
check("labor unknown -> net excludes labor, flagged, never invented", () => {
  const p = logic.computeProfit({
    invoiceAmount: 1117.58, glassCost: null, salesTax: null,
    laborHours: null, laborRate: 40, otherJobCosts: 0, glueMode: "per-job"
  });
  assert.strictEqual(p.netExcludesLabor, true);
  assert.strictEqual(p.laborCost, null);
  assert.ok(p.flags.some((f) => f.indexOf("Labor hours not entered") !== -1));
  assert.ok(p.flags.some((f) => f.indexOf("Glass cost not entered") !== -1));
});
check("W-9 reminder: first Progressive invoice without W-9 on file", () => {
  assert.strictEqual(logic.needsW9({ insurer: "Progressive", w9OnFile: false, status: "Installed - Awaiting Invoice" }), true);
  assert.strictEqual(logic.needsW9({ insurer: "Progressive", w9OnFile: true, status: "Installed - Awaiting Invoice" }), false);
  assert.strictEqual(logic.needsW9({ insurer: "Farmers", w9OnFile: false, status: "Installed - Awaiting Invoice" }), false);
});
check("recalibration: bill only the type performed", () => {
  const r = logic.recalibrationAmount({}, "dynamic");
  assert.strictEqual(r.amount, 275);
  const none = logic.recalibrationAmount({}, null);
  assert.strictEqual(none.amount, null);
  assert.ok(none.flag.indexOf("bill only what was actually performed") !== -1);
});

console.log("Daily brief (jobs data only, never calendar):");
const demoJobs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "synthetic-jobs.json"), "utf8"));
check("brief 2026-10-18 shows the HR-V install + bill clock", () => {
  const b = logic.buildBrief(demoJobs, "2026-10-18", "2026-10-18");
  assert.strictEqual(b.installs.length, 1);
  assert.strictEqual(b.installs[0].referral, "700006");
  assert.strictEqual(b.toBill.length, 1);
  assert.strictEqual(b.toBill[0].deadline, "2026-10-28");
  assert.strictEqual(b.toBill[0].daysLeft, 10);
  assert.strictEqual(b.isEmpty, false);
});
check("brief on a date with no jobs says so — never claims the day is clear", () => {
  const b = logic.buildBrief(demoJobs, "2026-11-20", "2026-11-20");
  assert.strictEqual(b.isEmpty, true);
  assert.strictEqual(b.installs.length, 0);
  assert.strictEqual(b.scheduled.length, 0);
  assert.ok(b.coverageNote.indexOf("does not mean the shop is free") !== -1);
  // Open items are not date-bound: the HR-V bill is still listed.
  assert.strictEqual(b.toBill.length, 1);
});
check("brief 2026-11-16 shows the two scheduled jobs", () => {
  const b = logic.buildBrief(demoJobs, "2026-11-16", "2026-11-16");
  assert.strictEqual(b.scheduled.length, 2);
});
check("maps link points from the shop to the customer address", () => {
  const url = logic.mapsDirLink("36 Harrison St, Taunton MA 02780");
  assert.ok(url.indexOf("google.com/maps/dir") !== -1);
  assert.ok(url.indexOf(encodeURIComponent("118 Terrace St, Roxbury MA 02120")) !== -1);
  assert.ok(url.indexOf(encodeURIComponent("36 Harrison St, Taunton MA 02780")) !== -1);
});

console.log("Synthetic referral PDF round-trip:");
check("generated PDF parses back to the same job", () => {
  const job = demoJobs.find((j) => j.referral === "700006");
  const pdf = logic.buildSyntheticReferralPdf(job);
  assert.ok(pdf.indexOf("%PDF-1.4") === 0);
  assert.ok(pdf.indexOf("700006") !== -1);
  assert.ok(pdf.indexOf("WILSON, SARA") !== -1);
  // The PDF text lines must parse with the same parser.
  const lines = pdf.split("\n").filter((l) => l.indexOf(" Tj") !== -1)
    .map((l) => { const m = l.match(/\((.*)\) Tj/); return m ? m[1].replace(/\\([()\\])/g, "$1") : ""; });
  const parsed = parseReferralText(lines.join("\n"), "ref-700006.pdf");
  assert.strictEqual(parsed.referral, "700006");
  assert.strictEqual(parsed.customer, "Sara Wilson");
  assert.strictEqual(parsed.vehicle, "2023 Honda HR-V");
  assert.strictEqual(parsed.nags, "FW05907 GTY");
  assert.strictEqual(parsed.approved_amount, 1117.58);
  assert.strictEqual(parsed.recalibration_required, true);
});

console.log("NHTSA live decode (soft check — SKIP on network failure):");
(async () => {
  try {
    // Public example VIN from NHTSA docs (2003 Honda Accord) — not a customer VIN.
    const res = await fetch("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A004352?format=json");
    const d = await res.json();
    const r = d.Results && d.Results[0];
    assert.strictEqual(String(r.ModelYear), "2003");
    assert.strictEqual(String(r.Make).toUpperCase(), "HONDA");
    pass++; console.log("  [OK] NHTSA decode returns 2003 Honda for the example VIN");
  } catch (e) {
    console.log("  [SKIP] NHTSA live decode unavailable: " + e.message);
  }
  console.log("\nlogic_test: " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
