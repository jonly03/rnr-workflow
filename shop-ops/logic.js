/* Shop Ops Brain — pure business logic (Layer 3 MVP).
 *
 * No DOM, no network, no dependencies. Same file is loaded by the
 * app (classic script) and by the Node tests (module.exports).
 *
 * Rules (from the business system + standing rules):
 * - Gross Profit = Invoice Amount - Glass/Parts Cost - Sales Tax
 * - Net Job Profit = Gross Profit - Glue & Supplies - Other Job Costs
 *   (labor is part of "Other Job Costs" in the sheet; here it is shown
 *   separately so the math is auditable — it is still subtracted once.)
 * - Glue: 1.5 tubes/job = $22.66/job (Express 30, $135.93/box avg,
 *   9 tubes/box). Counted EXACTLY ONCE: per-job column OR general
 *   expense, never both.
 * - Invoice within 10 days of install. Amount = APPROVED amount,
 *   flagged as approved — never money received.
 * - Labor hours must be ENTERED per job, never invented.
 */

var SHOP = {
  name: "R&R's Finest Auto Glass",
  address: "118 Terrace St, Roxbury MA 02120",
  phone: "857-266-1284",
  hours: "Mon–Sat 8–6",
  shipTo: "C034125-001",
  mygrantPortal: "https://mygrantglassonline.com",
  safelitePortal: "https://safelitesolutionsnetwork.com"
};

var GLUE_TUBES_PER_JOB = 1.5;
var GLUE_TUBES_PER_BOX = 9;
var GLUE_COST_PER_BOX = 135.93; // average across 19 kits on file
var GLUE_PER_JOB = 22.66;        // 0.167 box x $135.93

// Lists values from the business-system workbook (Lists sheet).
var JOB_STATUSES = [
  "Referral Received",
  "Scheduled",
  "Installed - Awaiting Invoice",
  "Invoiced - Awaiting Payment",
  "Paid",
  "Cancelled"
];
var PAYMENT_STATUSES = [
  "Not Invoiced",
  "Unpaid",
  "Partial",
  "Paid - Insurance Check",
  "Paid - Cash",
  "Paid - Card",
  "Paid - Other"
];

// Recalibration rates from the Safelite referral sheets on file
// (referral #186114: Static $300 / Dynamic $275 / Dual $500).
// A job's own sheet rates win when present. Bill ONLY the type
// actually performed — never static + dynamic together.
var RECALIBRATION_RATES = { static: 300, dynamic: 275, dual: 500 };

function money(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Money is rounded to cents at each step — binary floating point
 * (0.1 + 0.2) must never leak into job profit math. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function addDays(iso, days) {
  var d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  var a = new Date(fromIso + "T12:00:00");
  var b = new Date(toIso + "T12:00:00");
  return Math.round((b - a) / 86400000);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/* 10-day invoice clock. Returns null deadline when no install date. */
function invoiceDeadline(installDateIso) {
  if (!installDateIso) return null;
  return addDays(installDateIso, 10);
}

function invoiceClock(job, today) {
  today = today || todayIso();
  if (!job.installDate) return { state: "not-installed", deadline: null, daysLeft: null };
  var deadline = invoiceDeadline(job.installDate);
  var daysLeft = daysBetween(today, deadline);
  if (job.status === "Invoiced - Awaiting Payment" || job.status === "Paid") {
    return { state: "invoiced", deadline: deadline, daysLeft: daysLeft };
  }
  if (daysLeft < 0) return { state: "overdue", deadline: deadline, daysLeft: daysLeft };
  if (daysLeft === 0) return { state: "due-today", deadline: deadline, daysLeft: 0 };
  return { state: "on-time", deadline: deadline, daysLeft: daysLeft };
}

/* W-9 reminder: signed W-9 goes with the FIRST Progressive invoice. */
function needsW9(job) {
  if (!job.insurer || job.insurer.indexOf("Progressive") !== 0) return false;
  if (job.status === "Paid") return false;
  return !job.w9OnFile;
}

/* Recalibration amount for the type actually performed.
 * typePerformed: "static" | "dynamic" | "dual" | null. */
function recalibrationAmount(job, typePerformed) {
  if (!typePerformed) return { amount: null, flag: "Recalibration type not recorded — bill only what was actually performed." };
  var rates = (job && job.recalibrationRates) || RECALIBRATION_RATES;
  var amt = rates[typePerformed];
  if (amt === undefined || amt === null) return { amount: null, flag: "Unknown recalibration type: " + typePerformed };
  return { amount: amt, flag: null };
}

/* True profit for one job. Mirrors the business-system Jobs formulas.
 * Returns { invoice, glass, tax, gross, glue, glueNote, laborHours,
 * laborRate, laborCost, other, net, netExcludesLabor, flags[] }.
 * Any number that is unknown is flagged, never invented. */
function computeProfit(job) {
  var flags = [];
  var invoice = (job.invoiceAmount === null || job.invoiceAmount === undefined) ? null : Number(job.invoiceAmount);
  if (invoice === null) flags.push("Invoice amount unknown — enter the approved amount (flagged as approved, not money received).");
  var glass = (job.glassCost === null || job.glassCost === undefined || job.glassCost === "") ? null : Number(job.glassCost);
  if (glass === null) flags.push("Glass cost not entered yet — record the Mygrant cost against this job.");
  var tax = (job.salesTax === null || job.salesTax === undefined || job.salesTax === "") ? null : Number(job.salesTax);
  if (tax === null) { tax = 0; flags.push("Sales tax not entered — treated as $0.00 in this math until entered."); }
  var other = Number(job.otherJobCosts || 0);

  var gross = (invoice === null || glass === null) ? null : round2(invoice - glass - tax);

  var glue, glueNote;
  if (job.glueMode === "general-expense") {
    glue = 0;
    glueNote = "Glue counted in general Expenses, NOT here — do not also add a per-job glue cost.";
  } else {
    glue = GLUE_PER_JOB;
    glueNote = "Glue 1.5 tubes @ $" + GLUE_PER_JOB.toFixed(2) + "/job (Express 30). Counted here only.";
  }

  var laborHours = (job.laborHours === null || job.laborHours === undefined || job.laborHours === "") ? null : Number(job.laborHours);
  var laborRate = (job.laborRate === null || job.laborRate === undefined || job.laborRate === "") ? null : Number(job.laborRate);
  var laborCost = null, netExcludesLabor = false;
  if (laborHours === null) {
    flags.push("Labor hours not entered — net below EXCLUDES labor. Enter hours to finish the math.");
    netExcludesLabor = true;
  } else if (laborRate === null) {
    flags.push("Labor rate unknown — enter the $/hr rate from the referral sheet to price labor.");
    netExcludesLabor = true;
  } else {
    laborCost = round2(laborHours * laborRate);
  }

  var net = null;
  if (gross !== null) net = round2(gross - glue - other - (laborCost === null ? 0 : laborCost));

  return {
    invoice: invoice, glass: glass, tax: tax, gross: gross,
    glue: glue, glueNote: glueNote,
    laborHours: laborHours, laborRate: laborRate, laborCost: laborCost,
    other: other, net: net, netExcludesLabor: netExcludesLabor, flags: flags
  };
}

/* Google Maps directions link from the shop to a customer address. */
function mapsDirLink(address) {
  var origin = encodeURIComponent(SHOP.address);
  var dest = encodeURIComponent(address || "");
  return "https://www.google.com/maps/dir/?api=1&origin=" + origin + "&destination=" + dest;
}

/* Daily brief for one date, built ONLY from the jobs data.
 * Never claims a day is clear: an empty day is reported as
 * "no jobs in the jobs data for this date", not "clear". */
function buildBrief(jobs, dateIso, today) {
  today = today || todayIso();
  var installs = [], scheduled = [], toOrder = [], toBill = [], overdue = [];
  jobs.forEach(function (job) {
    if (job.status === "Cancelled") return;
    if (job.installDate === dateIso) installs.push(job);
    if (job.scheduledDate === dateIso) scheduled.push(job);
    var needsGlass = (job.glassCost === null || job.glassCost === undefined || job.glassCost === "");
    if ((job.status === "Referral Received" || job.status === "Scheduled") && needsGlass) toOrder.push(job);
    if (job.status === "Installed - Awaiting Invoice") {
      var clock = invoiceClock(job, today);
      var entry = { job: job, deadline: clock.deadline, daysLeft: clock.daysLeft };
      toBill.push(entry);
      if (clock.state === "overdue") overdue.push(entry);
    }
  });
  return {
    date: dateIso,
    installs: installs,
    scheduled: scheduled,
    toOrder: toOrder,
    toBill: toBill,
    overdue: overdue,
    // "Empty" means nothing is booked for this date (no installs, no
    // scheduled jobs). Open to-order / to-bill items are NOT date-bound,
    // so they do not make a day non-empty — they are listed separately.
    isEmpty: installs.length === 0 && scheduled.length === 0,
    coverageNote: "Built from jobs entered in this app only. This is not your calendar — the device calendar cache is unreliable, so an empty day here does not mean the shop is free."
  };
}

/* Derive the all-caps sheet-layout fields from a normal job object.
 * Explicit sheet fields on the job (synthetic fixtures carry them) win. */
function sheetFields(job) {
  function up(s) { return (s === null || s === undefined) ? "" : String(s).toUpperCase(); }
  function mdy(iso) {
    if (!iso) return "10/01/2026";
    var p = iso.split("-");
    return p[1] + "/" + p[2] + "/" + p[0];
  }
  function mdyy(iso) {
    if (!iso) return "11/13/26";
    var p = iso.split("-");
    return p[1] + "/" + p[2] + "/" + p[0].slice(2);
  }
  var customerSheet = job.customerSheet;
  if (!customerSheet && job.customer) {
    var cp = job.customer.trim().split(/\s+/);
    var last = cp.length > 1 ? cp[cp.length - 1] : cp[0];
    var first = cp.length > 1 ? cp.slice(0, -1).join(" ") : "";
    customerSheet = up(last) + ", " + up(first);
  }
  var addressSheet = job.addressSheet, citySheet = job.citySheet;
  if ((!addressSheet || !citySheet) && job.address) {
    var aParts = job.address.split(",");
    addressSheet = addressSheet || up((aParts[0] || "").trim());
    if (!citySheet && aParts.length >= 2) {
      var tail = aParts.slice(1).join(",").trim().replace(/\s+/g, " ");
      citySheet = up(tail);
    }
  }
  var vehicleSheet = job.vehicleSheet || up(job.vehicle || "");
  var insurerSheet = job.insurerSheet || up((job.insurer || "").replace(" — NO COMP COVERAGE", ""));
  return {
    customerSheet: customerSheet || "",
    addressSheet: addressSheet || "",
    citySheet: citySheet || "",
    vehicleSheet: vehicleSheet,
    insurerSheet: insurerSheet,
    referralDateMMDDYY: job.referralDateMMDDYY || mdyy(job.referralDate),
    dateOfLossMDY: job.dateOfLossMDY || mdy(job.dateOfLoss)
  };
}

/* ---- Minimal one-page PDF builder (synthetic referral fixtures) ----
 * Builds a valid ASCII PDF string for a synthetic referral sheet so Lou
 * can download it, drop it back into the app, and watch it parse.
 * All text is ASCII; string length == byte length, so xref offsets
 * computed from string lengths are correct. */
function pdfEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSyntheticReferralPdf(job) {
  // Derive the all-caps sheet-layout fields from the normal job fields
  // when they are not already present (jobs created from a parsed
  // referral do not carry them; synthetic fixtures do).
  var sf = sheetFields(job);
  var lines = [
    "Safelitesolutionsnetwork.com PricingApproval@Safelite.com ShopCare@Safelite.com",
    "",
    "Bobcat   |------------------------------------------|         Date: " + sf.referralDateMMDDYY,
    "  F9     |  S A F E L I T E   S O L U T I O N S     |         Time: 09:58:46",
    "------------------------------------------------------------------------------",
    "To:        R & RS FINEST AUTO        Shop#: 174214        |",
    "           118 TERRACE ST            Fax:   857-266-1284  |      Referral#",
    "           ROXBURY MA 02120          Tel:   857 266 1284  |       " + job.referral,
    "----------------------------------------------------------|",
    "Customer:  " + sf.customerSheet + "             Home:  " + (job.phone || "") + "  |",
    "           " + sf.addressSheet + "            Bus:     0-  0-   0  |  Date of loss:",
    "           " + sf.citySheet + "                               |     " + sf.dateOfLossMDY,
    "Vehicle:  " + sf.vehicleSheet,
    "Type of Loss: " + (job.workType || "REPLACE") + "  " + job.nags,
    "Deductible:     $" + (job.deductible === null || job.deductible === undefined ? "" : Number(job.deductible).toFixed(2)),
    "------------------------------------------------------------------------------",
    "W/S LIST:  -49.0% LABR:  $40.00 PER HOUR",
    "C/T LIST:  -49.0% LABR:  $40.00 PER HOUR",
    "",
    "______________________________________________________________________________",
    "          " + sf.insurerSheet + " has determined the amount of such work",
    "           is:  $   " + (job.approvedAmount === null || job.approvedAmount === undefined ? "" : Number(job.approvedAmount).toFixed(2)) + " less any applicable deductible amount.",
    "",
    "INSHOP SERVICE",
    "",
    "COMPANY: " + sf.insurerSheet + "               ID#: 09034   EDI MAILBOX: SAFL  SAFL107",
    "-------------------------- Billing Instructions ------------------------------",
    " Sold To: " + sf.customerSheet + "                    Please Show On Your Invoice",
    " Bill To: " + sf.insurerSheet + "                       1) Referral#: " + job.referral,
    " Address: PO BOX 182277                     2) Full Vehicle Vin Number",
    "          COLUMBUS, OH 43218-2277           3) Valid NAGS Part Numbers",
    "or,Invoice at safelitesolutionsnetwork.com       4) Customer's Signature",
    "- You must include sales tax on your invoice if applicable.",
    "- Please complete and submit a W9 with your first invoice.",
    "- Payment will be rendered upon receipt of funds from the client.",
    "- Invoices should be submitted within 10 days of installation.",
    "-------------------------- Customer Authorization-----------------------------",
    "",
    "Customer Signature ______________________________________ Date ______________",
    "Please return your invoice signed by the customer, along with this signed fax"
  ];
  if (job.recalibrationRequired) {
    lines.splice(19, 0, "PART REQUIRES RECALIBRATION",
      "Recalibration: Static $300 Dynam: $275 Dual: $500");
  }
  if (job.noCoverage) {
    lines.splice(15, 0, "NO COMP COVERAGE");
  }
  if (job.coverageNotVerified) {
    lines.splice(15, 0, "Coverage not yet verified.");
  }
  var content = "BT /F1 11 Tf 14 TL\n";
  var y = 760;
  lines.forEach(function (ln) {
    content += "36 " + y + " Td (" + pdfEscape(ln) + ") Tj T*\n";
    y -= 14;
  });
  content += "ET";
  var objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  objects[5] = "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream";
  var pdf = "%PDF-1.4\n";
  var offsets = [0];
  for (var i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += i + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  var xrefPos = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (var j = 1; j <= 5; j++) {
    pdf += ("0000000000" + offsets[j]).slice(-10) + " 00000 n \n";
  }
  pdf += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF";
  return pdf;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHOP: SHOP,
    GLUE_PER_JOB: GLUE_PER_JOB,
    GLUE_TUBES_PER_JOB: GLUE_TUBES_PER_JOB,
    GLUE_TUBES_PER_BOX: GLUE_TUBES_PER_BOX,
    GLUE_COST_PER_BOX: GLUE_COST_PER_BOX,
    JOB_STATUSES: JOB_STATUSES,
    PAYMENT_STATUSES: PAYMENT_STATUSES,
    RECALIBRATION_RATES: RECALIBRATION_RATES,
    money: money,
    addDays: addDays,
    daysBetween: daysBetween,
    todayIso: todayIso,
    invoiceDeadline: invoiceDeadline,
    invoiceClock: invoiceClock,
    needsW9: needsW9,
    recalibrationAmount: recalibrationAmount,
    computeProfit: computeProfit,
    mapsDirLink: mapsDirLink,
    buildBrief: buildBrief,
    sheetFields: sheetFields,
    buildSyntheticReferralPdf: buildSyntheticReferralPdf
  };
}
