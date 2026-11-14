/* Referral sheet parser — Shop Ops Brain (Layer 3 MVP).
 *
 * Faithful JavaScript port of the VERIFIED Python parser in
 * ~/workspace/shop-ops-brain/referral_intake.py (parse_sheet).
 * That parser has 0 field mismatches across all 8 real Safelite
 * referral sheets. Do not invent a new parser: if a sheet fails
 * to parse here, fix the port to match the Python original.
 *
 * Works as a classic browser script (functions land on window) and
 * as a Node module (module.exports) so tests can require() it.
 * No DOM, no network, no dependencies.
 */

var INSURER_MAP = {
  "PROGRESSIVE": "Progressive",
  "FARMERS INSURANCE": "Farmers",
  "MAPFRE INSURANCE": "Mapfre",
  "GEICO": "Geico",
  "QUINCY MUTUAL INSURANCE": "Quincy Mutual",
  "PLYMOUTH ROCK ASSURANCE": "Plymouth Rock Assurance"
};

// The 833614 sheet truncates the customer name to "VILLALONA, ALTAGRACI"
// and masks the referral number as XXXXXX. Full name + number were
// verified from the ShopCare email (subject + attachment filename).
// Keep this override explicit and documented; do not guess anything
// else for this job.
var VERIFIED_OVERRIDES = {
  "833614": { customer: "Altagracia Villalona" }
};

function titleCase(text) {
  var small = { ST: "St", AVE: "Ave", APT: "Apt", STE: "Ste", DR: "Dr",
                RD: "Rd", LN: "Ln", CT: "Ct", BLVD: "Blvd", TER: "Ter" };
  return text.split(/\s+/).map(function (tok) {
    if (/[a-z]/.test(tok)) return tok; // already mixed-case, keep as-is
    if (small[tok]) return small[tok];
    if (tok === "XLE/LIMIT") return "XLE/Limited";
    if (tok === "HR-V") return "HR-V";
    return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
  }).join(" ");
}

function normVehicle(raw) {
  raw = raw.replace(/\s+/g, " ").trim();
  var m = raw.match(/^(\d{4})\s+([A-Za-z]+)\s+(.+)$/);
  if (!m) return titleCase(raw);
  var year = m[1], make = m[2], rest = m[3];
  rest = rest.replace("4 DOOR SED", "4-dr").replace("4 DOOR", "4-dr");
  rest = rest.replace("SRWSUP PU", "Super Duty pickup");
  rest = rest.replace("XLE/LIMIT", "XLE/Limited");
  make = make.toUpperCase() === "BMW" ? "BMW"
    : make.charAt(0).toUpperCase() + make.slice(1).toLowerCase();
  return year + " " + make + " " + titleCase(rest);
}

function toIso(mdY) {
  var p = mdY.split("/");
  var y = p[2].length === 2 ? "20" + p[2] : p[2];
  return y + "-" + p[0] + "-" + p[1];
}

/* Extract structured fields from one Safelite referral sheet's text.
 * `filenameHint` (optional, e.g. "ref-833614.pdf") supplies the
 * referral number when the sheet masks it as XXXXXX / NO COV.
 * Returns an object with the same field names as the Python parser. */
function parseReferralText(text, filenameHint) {
  var flat = text.replace(/\s+/g, " ");
  var f = {};
  var m;

  // --- sheet date + referral number -------------------------------------
  m = text.match(/Date:\s*(\d{2}\/\d{2}\/\d{2})/);
  f.referral_date = m ? toIso(m[1]) : null;
  m = flat.match(/Referral#\s*.{0,220}?(NO COV|XXXXXX|\d{6})/);
  var rawRef = m ? m[1] : null;
  f.referral_sheet = rawRef; // may be masked: 'NO COV' / 'XXXXXX'

  // If the sheet masks the number, take it from the filename instead.
  var hintedRef = null;
  if (filenameHint) {
    var hm = filenameHint.match(/(\d{6})/);
    if (hm) hintedRef = hm[1];
  }
  f.referral = (rawRef && /^\d{6}$/.test(rawRef)) ? rawRef : hintedRef;

  // --- customer / address / phone ---------------------------------------
  m = text.match(/Customer:\s*([A-Z][A-Z ,.'\-]+?)\s+Home:\s*([\d\-]+)/);
  if (m) {
    var parts = m[1].split(",");
    var last = (parts[0] || "").trim();
    var first = (parts.slice(1).join(",") || "").trim();
    f.customer = (first.charAt(0).toUpperCase() + first.slice(1).toLowerCase())
      + " " + (last.charAt(0).toUpperCase() + last.slice(1).toLowerCase());
    f.phone = m[2].trim();
  } else {
    f.customer = null;
    f.phone = null;
  }
  // street line follows the customer line; city/state/zip on the next line
  var lines = text.split("\n");
  f.address = null;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("Customer:") !== -1 && i + 2 < lines.length) {
      var street = lines[i + 1].split("Bus:")[0].trim();
      var cityln = lines[i + 2].split("|")[0].trim();
      var cm = cityln.match(/^([A-Z][A-Z ]*?)\s+([A-Z]{2})\s+(\d{5})/);
      if (street && cm) {
        f.address = titleCase(street) + ", " + titleCase(cm[1]) + " " + cm[2] + " " + cm[3];
      }
      break;
    }
  }

  // --- vehicle -----------------------------------------------------------
  m = text.match(/Vehicle:\s*(.+)/);
  f.vehicle_raw = m ? m[1].trim() : null;
  f.vehicle = f.vehicle_raw ? normVehicle(f.vehicle_raw) : null;

  // --- work type + NAGS part ---------------------------------------------
  m = text.match(/Type of Loss:\s*(REPLACE|REPAIR)\s+([A-Z0-9]+\s+[A-Z]+)/);
  f.work_type = m ? m[1] : null;
  f.nags = m ? m[2].trim() : null;

  // --- deductible ---------------------------------------------------------
  m = text.match(/Deductible:\s*\$([\d,]*\.?\d*)/);
  f.deductible = (m && m[1] !== "") ? parseFloat(m[1].replace(/,/g, "")) : null;

  // --- approved amount ----------------------------------------------------
  m = text.match(/has determined the amount of such work\s+is:\s*\$\s*([\d,]+\.\d{2})/);
  f.approved_amount = m ? parseFloat(m[1].replace(/,/g, "")) : null;

  // --- insurer / coverage --------------------------------------------------
  m = text.match(/COMPANY:\s*([A-Z ]+?)\s+ID#:/);
  var insurerRaw = m ? m[1].trim() : null;
  f.insurer = insurerRaw
    ? (INSURER_MAP[insurerRaw] || titleCase(insurerRaw))
    : null;
  f.no_coverage = text.indexOf("NO COMP COVERAGE") !== -1;
  f.coverage_verified = text.indexOf("Coverage not yet verified.") === -1 && !f.no_coverage;
  if (f.no_coverage && f.insurer) f.insurer = f.insurer + " — NO COMP COVERAGE";

  // --- date of loss ---------------------------------------------------------
  m = flat.match(/Date of loss:.{0,150}?(\d{2}\/\d{2}\/\d{4})/);
  f.date_of_loss = m ? toIso(m[1]) : null;

  // --- service location ------------------------------------------------------
  f.service = text.indexOf("INSHOP SERVICE") !== -1 ? "in-shop"
    : (text.indexOf("MOBILE SERVICE") !== -1 ? "mobile" : null);

  // --- recalibration ---------------------------------------------------------
  m = text.match(/Recalibration:\s*Static\s*\$([\d.]+)\s*Dynam:\s*\$([\d.]+)\s*Dual:\s*\$([\d.]+)/);
  if (m) {
    f.recalibration = "Static $" + parseFloat(m[1]) + " / Dynamic $" + parseFloat(m[2])
      + " / Dual $" + parseFloat(m[3]);
    f.recalibration_rates = { static: parseFloat(m[1]), dynamic: parseFloat(m[2]), dual: parseFloat(m[3]) };
  } else {
    f.recalibration = null;
    f.recalibration_rates = null;
  }
  f.recalibration_required = text.indexOf("PART REQUIRES RECALIBRATION") !== -1;

  // --- pricing ----------------------------------------------------------------
  m = text.match(/W\/S LIST:\s*(-[\d.]+)%\s*LABR:\s*\$([\d.]+)\s*PER HOUR/);
  if (m) {
    var labr = parseFloat(m[2]);
    f.pricing = "W/S list " + parseFloat(m[1]) + "%, labor $"
      + (labr === Math.floor(labr) ? String(Math.floor(labr)) : labr.toFixed(2)) + "/hr";
    f.labor_rate = labr;
  } else {
    f.pricing = null;
    f.labor_rate = null;
  }

  // --- VIN (sheets do not print one; look anyway) -----------------------------
  m = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  f.vin = m ? m[0] : null;

  // --- verified overrides (explicit, documented) ------------------------------
  if (f.referral && VERIFIED_OVERRIDES[f.referral]) {
    var ov = VERIFIED_OVERRIDES[f.referral];
    if (ov.customer) f.customer = ov.customer;
    f.override_applied = "Referral #" + f.referral
      + ": sheet masks the referral number as XXXXXX and truncates the name; "
      + "number and full name verified from the ShopCare email.";
  }

  return f;
}

/* Build a job object (same key order as safelite-jobs-data.json entries)
 * from parsed sheet fields. */
function jobFromParsed(parsed, referral) {
  var work = "Windshield replacement";
  if (parsed.work_type && parsed.nags) work += " (" + parsed.work_type + " " + parsed.nags + ")";
  if (parsed.service) work += ", " + parsed.service;
  if (parsed.recalibration_required) work += ", part requires recalibration";
  return {
    address: parsed.address,
    approvedAmount: parsed.approved_amount,
    customer: parsed.customer,
    dateOfLoss: parsed.date_of_loss,
    deductible: parsed.deductible,
    insurer: parsed.insurer,
    nags: parsed.nags,
    notes: parsed.override_applied || "",
    phone: parsed.phone,
    pricing: parsed.pricing,
    recalibration: parsed.recalibration,
    referral: referral,
    referralDate: parsed.referral_date,
    status: "Unknown",
    vehicle: parsed.vehicle,
    work: work
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseReferralText: parseReferralText,
    jobFromParsed: jobFromParsed,
    VERIFIED_OVERRIDES: VERIFIED_OVERRIDES,
    INSURER_MAP: INSURER_MAP,
    titleCase: titleCase,
    normVehicle: normVehicle
  };
}
