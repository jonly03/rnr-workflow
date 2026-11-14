/* Shop Ops Brain — UI (Layer 3 MVP).
 * Classic script, no modules, works from file:// or any static server.
 * State lives in localStorage only. Synthetic demo data only — no real
 * customer PII. Nothing here sends, orders, or files anything.
 */
(function () {
  "use strict";

  var STORE_KEY = "shopops.jobs.v1";
  var GLUE_PER_JOB = 22.66;

  /* Embedded copy of fixtures/synthetic-jobs.json (same 8 jobs) so the
   * demo loads even from file://, where fetch() of local files fails.
   * The JSON file in fixtures/ is the canonical copy. */
  var SYNTHETIC_JOBS = [
    { referral: "700001", customer: "John Doe", phone: "555-010-0001", address: "12 Example St, Roxbury MA 02119", vehicle: "2015 Nissan Altima 4-dr", nags: "FW03621 GBY", workType: "REPLACE", service: "in-shop", insurer: "Mapfre — NO COMP COVERAGE", approvedAmount: null, deductible: 9999, coverageVerified: false, noCoverage: true, dateOfLoss: "2024-08-10", referralDate: "2024-08-19", recalibrationRequired: false, status: "Referral Received", paymentStatus: "Not Invoiced" },
    { referral: "700002", customer: "Jane Smith", phone: "555-010-0002", address: "34 Sample Ave Apt 1, Boston MA 02118", vehicle: "2009 Honda Civic 4-dr", nags: "FW02584 GTY", workType: "REPLACE", service: "in-shop", insurer: "Farmers", approvedAmount: 351.08, deductible: 0, coverageVerified: true, noCoverage: false, dateOfLoss: "2025-01-17", referralDate: "2025-01-21", recalibrationRequired: false, status: "Scheduled", scheduledDate: "2026-11-16", paymentStatus: "Not Invoiced" },
    { referral: "700003", customer: "Robert Jones", phone: "555-010-0003", address: "56 Demo Rd Apt 501, Weymouth MA 02190", vehicle: "2018 BMW 530", nags: "FD27247 YPN", workType: "REPLACE", service: "in-shop", insurer: "Progressive", approvedAmount: null, deductible: 0, coverageVerified: true, noCoverage: false, dateOfLoss: "2025-04-16", referralDate: "2025-04-18", recalibrationRequired: false, status: "Referral Received", paymentStatus: "Not Invoiced" },
    { referral: "700004", customer: "Mary Brown", phone: "555-010-0004", address: "78 Test Ln, Brockton MA 02302", vehicle: "2005 Ford Super Duty pickup", nags: "DW01537 GTY", workType: "REPLACE", service: "in-shop", insurer: "Quincy Mutual", approvedAmount: null, deductible: 0, coverageVerified: true, noCoverage: false, dateOfLoss: "2025-06-28", referralDate: "2025-07-02", recalibrationRequired: false, status: "Referral Received", paymentStatus: "Not Invoiced" },
    { referral: "700005", customer: "Lisa Garcia", phone: "555-010-0005", address: "90 Placeholder St, Brockton MA 02302", vehicle: "2018 Toyota Camry 4-dr", nags: "FB27410 GTN", workType: "REPLACE", service: "in-shop", insurer: "Geico", approvedAmount: null, deductible: 100, coverageVerified: true, noCoverage: false, dateOfLoss: "2025-07-01", referralDate: "2025-07-03", recalibrationRequired: false, status: "Scheduled", scheduledDate: "2026-11-16", paymentStatus: "Not Invoiced" },
    { referral: "700006", customer: "Sara Wilson", phone: "555-010-0006", address: "22 Mockingbird Ave, Mattapan MA 02126", vehicle: "2023 Honda HR-V", nags: "FW05907 GTY", workType: "REPLACE", service: "in-shop", insurer: "Progressive", approvedAmount: 1117.58, deductible: 0, coverageVerified: true, noCoverage: false, dateOfLoss: "2026-10-09", referralDate: "2026-10-12", recalibrationRequired: true, recalibration: "Static $300 / Dynamic $275 / Dual $500", recalibrationRates: { static: 300, dynamic: 275, dual: 500 }, status: "Installed - Awaiting Invoice", installDate: "2026-10-18", paymentStatus: "Not Invoiced" },
    { referral: "700007", customer: "Mike Taylor", phone: "555-010-0007", address: "44 Fiction St, Taunton MA 02780", vehicle: "2016 Toyota Tacoma", nags: "FW04108 GTY", workType: "REPLACE", service: "in-shop", insurer: "Progressive", approvedAmount: 642.75, deductible: 0, coverageVerified: true, noCoverage: false, dateOfLoss: "2026-10-01", referralDate: "2026-10-20", recalibrationRequired: false, status: "Invoiced - Awaiting Payment", installDate: "2026-10-27", invoiceDate: "2026-11-03", invoiceNumber: "DEMO-700007", invoiceAmount: 642.75, paymentStatus: "Unpaid" },
    { referral: "700008", customer: "Ana Rivera", phone: "555-010-0008", address: "66 Imaginary Way Apt 2, West Roxbury MA 02132", vehicle: "2013 Toyota Sienna XLE/Limited", nags: "FW03760 GBY", workType: "REPLACE", service: "in-shop", insurer: "Plymouth Rock Assurance", approvedAmount: 674.87, deductible: null, coverageVerified: false, noCoverage: false, dateOfLoss: "2026-09-26", referralDate: "2026-11-02", recalibrationRequired: false, status: "Referral Received", paymentStatus: "Not Invoiced" }
  ];

  /* ---------------- state ---------------- */
  function loadJobs() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      return JSON.parse(raw).map(normalizeJob);
    } catch (e) { return []; }
  }
  function saveJobs(jobs) {
    localStorage.setItem(STORE_KEY, JSON.stringify(jobs));
  }
  function normalizeJob(j) {
    var d = {
      id: j.id || ("job-" + j.referral),
      referral: j.referral || "", referralDate: j.referralDate || null,
      customer: j.customer || "", phone: j.phone || "", address: j.address || "",
      vehicle: j.vehicle || "", vehicleYear: j.vehicleYear || null,
      vehicleMake: j.vehicleMake || "", vehicleModel: j.vehicleModel || "",
      vin: j.vin || null, nags: j.nags || "", workType: j.workType || "REPLACE",
      service: j.service || "in-shop", insurer: j.insurer || "",
      approvedAmount: (j.approvedAmount === undefined ? null : j.approvedAmount),
      deductible: (j.deductible === undefined ? null : j.deductible),
      coverageVerified: !!j.coverageVerified, noCoverage: !!j.noCoverage,
      dateOfLoss: j.dateOfLoss || null,
      recalibrationRequired: !!j.recalibrationRequired,
      recalibration: j.recalibration || null,
      recalibrationRates: j.recalibrationRates || null,
      recalibrationPerformed: j.recalibrationPerformed || null,
      pricing: j.pricing || null, laborRate: (j.laborRate === undefined ? null : j.laborRate),
      status: j.status || "Referral Received",
      scheduledDate: j.scheduledDate || null, installDate: j.installDate || null,
      invoiceNumber: j.invoiceNumber || null, invoiceDate: j.invoiceDate || null,
      invoiceAmount: (j.invoiceAmount === undefined ? null : j.invoiceAmount),
      glassCost: (j.glassCost === undefined ? null : j.glassCost),
      salesTax: (j.salesTax === undefined ? null : j.salesTax),
      laborHours: (j.laborHours === undefined ? null : j.laborHours),
      otherJobCosts: Number(j.otherJobCosts || 0),
      glueMode: j.glueMode || "per-job",
      paymentStatus: j.paymentStatus || "Not Invoiced",
      checkNumber: j.checkNumber || null, checkDate: j.checkDate || null,
      checkAmount: (j.checkAmount === undefined ? null : j.checkAmount),
      deductibleCollected: (j.deductibleCollected === undefined ? null : j.deductibleCollected),
      w9OnFile: !!j.w9OnFile, notes: j.notes || ""
    };
    // Split vehicle display "2016 Toyota Tacoma" into year/make/model.
    if (d.vehicle && !d.vehicleYear) {
      var m = d.vehicle.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
      if (m) { d.vehicleYear = Number(m[1]); d.vehicleMake = m[2]; d.vehicleModel = m[3]; }
    }
    return d;
  }

  var jobs = loadJobs();
  var selectedJobId = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtMoney(n) { return (typeof money === "function") ? money(n) : (n === null || n === undefined ? "—" : "$" + Number(n).toFixed(2)); }
  function val(v) { return (v === null || v === undefined || v === "") ? "—" : esc(v); }
  function getJob(id) { return jobs.find(function (j) { return j.id === id; }); }
  function jobLabel(j) { return "#" + j.referral + " — " + j.customer + " (" + j.vehicle + ")"; }

  /* ---------------- tabs ---------------- */
  document.querySelectorAll("#tabs button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll("section.tab").forEach(function (s) { s.classList.remove("active"); });
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
      renderTab(btn.dataset.tab);
    });
  });
  function renderTab(tab) {
    if (tab === "jobs") renderJobs();
    if (tab === "order") renderOrder();
    if (tab === "invoice") renderInvoice();
    if (tab === "profit") renderProfit();
    if (tab === "brief") renderBrief();
    if (tab === "tech") renderTech();
    if (tab === "pricing") renderPricing();
  }

  /* ---------------- 1 · intake ---------------- */
  var pdfjsReady = false;
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    pdfjsReady = true;
    $("pdfjs-status").textContent = "PDF reader ready (pdf.js, in-browser).";
  } else {
    $("pdfjs-status").textContent = "PDF reader (pdf.js CDN) did not load — check your connection. Paste-the-text still works.";
  }

  function showParsed(parsed, filenameHint) {
    var job = jobFromParsed(parsed, parsed.referral || "");
    var html = '<h3>Parsed referral</h3><div class="card"><div class="kv">';
    var rows = [
      ["Referral #", parsed.referral || "— (masked on sheet: " + (parsed.referral_sheet || "?") + ")"],
      ["Sheet date", parsed.referral_date], ["Customer", parsed.customer],
      ["Phone", parsed.phone], ["Address", parsed.address],
      ["Vehicle", parsed.vehicle], ["Work", (parsed.work_type || "") + " " + (parsed.nags || "")],
      ["Insurer", parsed.insurer], ["Approved amount", parsed.approved_amount === null ? "none on sheet" : fmtMoney(parsed.approved_amount)],
      ["Deductible", parsed.deductible === null ? "not stated" : fmtMoney(parsed.deductible)],
      ["Coverage", parsed.no_coverage ? "NO COMP COVERAGE — cash job only" : (parsed.coverage_verified ? "verified" : "NOT yet verified")],
      ["Date of loss", parsed.date_of_loss], ["Service", parsed.service],
      ["Recalibration", parsed.recalibration_required ? ("REQUIRED — " + (parsed.recalibration || "")) : "none on sheet"],
      ["Pricing", parsed.pricing], ["VIN on sheet", parsed.vin || "none (sheets do not print one)"]
    ];
    rows.forEach(function (r) { html += "<div><b>" + r[0] + ":</b> " + val(r[1]) + "</div>"; });
    html += "</div></div>";
    if (parsed.override_applied) html += '<div class="flag">' + esc(parsed.override_applied) + "</div>";
    if (!parsed.coverage_verified && !parsed.no_coverage) html += '<div class="flag">Coverage NOT yet verified — check with ShopCare before billing.</div>';
    if (parsed.no_coverage) html += '<div class="flag">NO COMP COVERAGE — cash job only. No insurer money on this job.</div>';
    if (!parsed.referral) html += '<div class="err">No referral number found on the sheet or in the filename. Enter it manually when creating the job.</div>';
    html += '<p><button class="btn-primary" id="create-job-btn">Create job from this referral</button> <span class="muted">Status starts at “Referral Received”.</span></p>';
    $("intake-result").innerHTML = html;
    $("create-job-btn").addEventListener("click", function () {
      if (!parsed.referral) { alert("Enter a referral number first — it is missing from this sheet."); return; }
      if (jobs.some(function (j) { return j.referral === parsed.referral; })) {
        $("intake-result").innerHTML += '<div class="flag">A job for referral #' + esc(parsed.referral) + " already exists — not duplicated.</div>";
        return;
      }
      var nj = normalizeJob({
        referral: parsed.referral, referralDate: parsed.referral_date,
        customer: parsed.customer, phone: parsed.phone, address: parsed.address,
        vehicle: parsed.vehicle, vin: parsed.vin, nags: parsed.nags,
        workType: parsed.work_type, service: parsed.service, insurer: parsed.insurer,
        approvedAmount: parsed.approved_amount, deductible: parsed.deductible,
        coverageVerified: parsed.coverage_verified, noCoverage: parsed.no_coverage,
        dateOfLoss: parsed.date_of_loss, recalibrationRequired: parsed.recalibration_required,
        recalibration: parsed.recalibration, recalibrationRates: parsed.recalibration_rates || null,
        pricing: parsed.pricing, laborRate: parsed.labor_rate,
        invoiceAmount: parsed.approved_amount, notes: parsed.override_applied || ""
      });
      jobs.push(nj);
      saveJobs(jobs);
      $("intake-result").innerHTML += '<div class="ok">Job #' + esc(nj.referral) + " created (Referral Received). See the Jobs tab.</div>";
    });
  }

  function parsePdfFile(file) {
    if (!pdfjsReady) { $("intake-result").innerHTML = '<div class="err">pdf.js did not load — paste the sheet text instead.</div>'; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
        var texts = [], chain = Promise.resolve();
        for (var p = 1; p <= pdf.numPages; p++) {
          (function (pageNum) {
            chain = chain.then(function () {
              return pdf.getPage(pageNum).then(function (page) {
                return page.getTextContent().then(function (tc) {
                  texts[pageNum - 1] = tc.items.map(function (it) { return it.str; }).join("\n");
                });
              });
            });
          })(p);
        }
        return chain.then(function () {
          var parsed = parseReferralText(texts.join("\n"), file.name);
          showParsed(parsed, file.name);
        });
      }).catch(function (err) {
        $("intake-result").innerHTML = '<div class="err">Could not read that PDF: ' + esc(err.message) + "</div>";
      });
    };
    reader.readAsArrayBuffer(file);
  }

  var dz = $("dropzone");
  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
  dz.addEventListener("drop", function (e) {
    e.preventDefault(); dz.classList.remove("over");
    if (e.dataTransfer.files.length) parsePdfFile(e.dataTransfer.files[0]);
  });
  $("pickfile").addEventListener("click", function () { $("fileinput").click(); });
  $("fileinput").addEventListener("change", function () { if (this.files.length) parsePdfFile(this.files[0]); });
  $("parse-paste").addEventListener("click", function () {
    var t = $("pastetext").value;
    if (!t.trim()) { $("intake-result").innerHTML = '<div class="err">Paste the sheet text first.</div>'; return; }
    showParsed(parseReferralText(t, null));
  });
  $("load-fixture-text").addEventListener("click", function () {
    fetch("fixtures/synthetic-referral-1.txt").then(function (r) { return r.text(); })
      .then(function (t) { $("pastetext").value = t; showParsed(parseReferralText(t, "ref-700006.pdf")); })
      .catch(function () { $("intake-result").innerHTML = '<div class="err">Could not load the fixture file — serve this folder over HTTP (python3 -m http.server) or open via the Pages preview. The embedded demo jobs still work.</div>'; });
  });
  $("load-fixtures").addEventListener("click", function () {
    jobs = SYNTHETIC_JOBS.map(normalizeJob);
    saveJobs(jobs);
    $("intake-result").innerHTML = '<div class="ok">Loaded 8 synthetic demo jobs (fake names/phones). See the Jobs tab. Nothing real was loaded.</div>';
    renderJobs();
  });
  $("reset-data").addEventListener("click", function () {
    if (!confirm("Clear all jobs stored in this browser?")) return;
    jobs = []; selectedJobId = null; saveJobs(jobs);
    $("intake-result").innerHTML = '<div class="ok">Demo data cleared.</div>';
    renderJobs();
  });
  $("download-synth-pdf").addEventListener("click", function () {
    var job = SYNTHETIC_JOBS[5]; // Sara Wilson, 2023 Honda HR-V, #700006
    var pdfStr = buildSyntheticReferralPdf(job);
    var bytes = new Uint8Array(pdfStr.length);
    for (var i = 0; i < pdfStr.length; i++) bytes[i] = pdfStr.charCodeAt(i) & 0xff;
    var blob = new Blob([bytes], { type: "application/pdf" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "synthetic-referral-700006.pdf";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    $("intake-result").innerHTML = '<div class="ok">Downloaded synthetic-referral-700006.pdf (Sara Wilson, 2023 Honda HR-V). Drop it back into the box above — it should parse to referral #700006, $1,117.58 approved, recalibration required.</div>';
  });

  /* ---------------- 2 · jobs ---------------- */
  function renderJobs() {
    var el = $("jobs-list");
    if (!jobs.length) { el.innerHTML = '<p class="muted">No jobs yet. Load the 8 synthetic demo jobs from the Intake tab, or parse a referral.</p>'; $("job-editor").innerHTML = ""; return; }
    var html = "<table><tr><th>Referral</th><th>Customer / Vehicle</th><th>Insurer / Approved</th><th>Status</th><th>Install</th><th>Invoice deadline</th><th></th></tr>";
    jobs.forEach(function (j) {
      var clock = invoiceClock(j);
      var dl = clock.deadline ? clock.deadline + (clock.state === "overdue" ? " — OVERDUE " + Math.abs(clock.daysLeft) + "d" : (clock.state === "due-today" ? " — DUE TODAY" : (clock.state === "on-time" ? " (" + clock.daysLeft + "d left)" : ""))) : "—";
      html += "<tr><td>#" + esc(j.referral) + "<br><span class='muted'>" + esc(j.referralDate || "") + "</span></td>"
        + "<td>" + esc(j.customer) + "<br>" + esc(j.vehicle) + "<br><span class='muted'>" + esc(j.nags || "") + "</span></td>"
        + "<td>" + esc(j.insurer) + "<br>" + fmtMoney(j.approvedAmount) + (j.approvedAmount !== null ? " <span class='muted'>(approved)</span>" : "") + "</td>"
        + "<td>" + esc(j.status) + "<br><span class='muted'>" + esc(j.paymentStatus) + "</span></td>"
        + "<td>" + esc(j.installDate || "—") + "</td><td>" + dl + "</td>"
        + '<td><button data-edit="' + j.id + '">Edit</button></td></tr>';
    });
    el.innerHTML = html + "</table>";
    el.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function () { selectedJobId = b.dataset.edit; renderEditor(); });
    });
    if (selectedJobId) renderEditor();
  }

  function renderEditor() {
    var j = getJob(selectedJobId);
    if (!j) { $("job-editor").innerHTML = ""; return; }
    var opts = function (list, cur) {
      return list.map(function (s) { return '<option value="' + esc(s) + '"' + (s === cur ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("");
    };
    var num = function (v) { return (v === null || v === undefined) ? "" : v; };
    $("job-editor").innerHTML =
      "<h3>#" + esc(j.referral) + " — " + esc(j.customer) + " · " + esc(j.vehicle) + "</h3>"
      + '<div class="grid">'
      + '<div><label>Job status</label><select id="e-status">' + opts(JOB_STATUSES, j.status) + "</select></div>"
      + '<div><label>Scheduled date</label><input id="e-sched" type="date" value="' + (j.scheduledDate || "") + '"></div>'
      + '<div><label>Install date</label><input id="e-install" type="date" value="' + (j.installDate || "") + '"></div>'
      + '<div><label>Invoice #</label><input id="e-invnum" value="' + esc(j.invoiceNumber || "") + '"></div>'
      + '<div><label>Invoice date</label><input id="e-invdate" type="date" value="' + (j.invoiceDate || "") + '"></div>'
      + '<div><label>Invoice amount ($) — approved amount</label><input id="e-invamt" type="number" step="0.01" value="' + num(j.invoiceAmount) + '"></div>'
      + '<div><label>Glass / parts cost ($)</label><input id="e-glass" type="number" step="0.01" value="' + num(j.glassCost) + '"></div>'
      + '<div><label>Sales tax ($)</label><input id="e-tax" type="number" step="0.01" value="' + num(j.salesTax) + '"></div>'
      + '<div><label>Labor hours (enter — never guessed)</label><input id="e-hours" type="number" step="0.1" min="0" value="' + num(j.laborHours) + '"></div>'
      + '<div><label>Labor rate ($/hr, from referral sheet)</label><input id="e-rate" type="number" step="0.01" value="' + num(j.laborRate) + '"></div>'
      + '<div><label>Other job costs ($)</label><input id="e-other" type="number" step="0.01" value="' + num(j.otherJobCosts) + '"></div>'
      + '<div><label>Glue accounting</label><select id="e-glue"><option value="per-job"' + (j.glueMode !== "general-expense" ? " selected" : "") + '>Per-job column ($22.66)</option><option value="general-expense"' + (j.glueMode === "general-expense" ? " selected" : "") + '>General expense (not here)</option></select></div>'
      + '<div><label>Payment status</label><select id="e-pay">' + opts(PAYMENT_STATUSES, j.paymentStatus) + "</select></div>"
      + '<div><label>Check #</label><input id="e-checknum" value="' + esc(j.checkNumber || "") + '"></div>'
      + '<div><label>Check date</label><input id="e-checkdate" type="date" value="' + (j.checkDate || "") + '"></div>'
      + '<div><label>Check amount ($)</label><input id="e-checkamt" type="number" step="0.01" value="' + num(j.checkAmount) + '"></div>'
      + '<div><label>Deductible collected ($)</label><input id="e-dedcoll" type="number" step="0.01" value="' + num(j.deductibleCollected) + '"></div>'
      + '<div><label>Recalibration actually performed</label><select id="e-recal"><option value="">— none / not recorded —</option><option value="static"' + (j.recalibrationPerformed === "static" ? " selected" : "") + '>Static ($300)</option><option value="dynamic"' + (j.recalibrationPerformed === "dynamic" ? " selected" : "") + '>Dynamic ($275)</option><option value="dual"' + (j.recalibrationPerformed === "dual" ? " selected" : "") + '>Dual ($500)</option></select></div>'
      + '<div><label>VIN</label><input id="e-vin" value="' + esc(j.vin || "") + '" maxlength="17" placeholder="17 characters"></div>'
      + "</div>"
      + '<p><label><input type="checkbox" id="e-w9"' + (j.w9OnFile ? " checked" : "") + '> Signed W-9 on file (required with first Progressive invoice)</label></p>'
      + '<p><label>Notes / flags</label><textarea id="e-notes" rows="2" style="width:100%">' + esc(j.notes || "") + "</textarea></p>"
      + '<p><button class="btn-primary" id="e-save">Save job</button> <span class="muted">Invoice amount is the approved amount — flagged as approved, never money received.</span></p>';
    $("e-save").addEventListener("click", function () {
      var g = function (id) { var el = $(id); return el ? el.value : ""; };
      var gn = function (id) { var v = g(id); return v === "" ? null : Number(v); };
      j.status = g("e-status"); j.scheduledDate = g("e-sched") || null;
      j.installDate = g("e-install") || null; j.invoiceNumber = g("e-invnum") || null;
      j.invoiceDate = g("e-invdate") || null; j.invoiceAmount = gn("e-invamt");
      j.glassCost = gn("e-glass"); j.salesTax = gn("e-tax");
      j.laborHours = gn("e-hours"); j.laborRate = gn("e-rate");
      j.otherJobCosts = Number(g("e-other") || 0); j.glueMode = g("e-glue");
      j.paymentStatus = g("e-pay"); j.checkNumber = g("e-checknum") || null;
      j.checkDate = g("e-checkdate") || null; j.checkAmount = gn("e-checkamt");
      j.deductibleCollected = gn("e-dedcoll");
      j.recalibrationPerformed = g("e-recal") || null;
      j.vin = g("e-vin").toUpperCase() || null;
      j.w9OnFile = $("e-w9").checked; j.notes = g("e-notes");
      if (j.status === "Invoiced - Awaiting Payment" && j.paymentStatus === "Not Invoiced") j.paymentStatus = "Unpaid";
      if (j.status === "Paid" && j.paymentStatus === "Unpaid") j.paymentStatus = "Paid - Insurance Check";
      saveJobs(jobs); renderJobs(); renderEditor();
      $("job-editor").insertAdjacentHTML("beforeend", '<div class="ok">Saved.</div>');
    });
  }

  /* ---------------- 3 · order ---------------- */
  function fillJobSelect(sel, filterFn) {
    sel.innerHTML = jobs.filter(filterFn || function () { return true; })
      .map(function (j) { return '<option value="' + j.id + '">' + esc(jobLabel(j)) + "</option>"; }).join("")
      || '<option value="">(no jobs yet)</option>';
  }
  function renderOrder() {
    fillJobSelect($("order-job"), function (j) { return j.status === "Referral Received" || j.status === "Scheduled"; });
    renderOrderDraft();
  }
  function renderOrderDraft() {
    var j = getJob($("order-job").value);
    if (!j) { $("order-draft").innerHTML = '<p class="muted">No booked job selected. Book a job first (Jobs tab: status Scheduled).</p>'; return; }
    $("order-draft").innerHTML = '<h3>Order draft — DRAFT ONLY, not placed</h3><div class="card"><div class="kv">'
      + "<div><b>Supplier:</b> Mygrant Glass (mygrantglassonline.com)</div>"
      + "<div><b>NAGS part:</b> " + esc(j.nags || "—") + " — " + esc(j.vehicle) + "</div>"
      + "<div><b>Quantity:</b> 1</div>"
      + "<div><b>Ship-to:</b> C034125-001 — R&amp;R's Finest Auto Glass, 118 Terrace St, Roxbury MA 02120</div>"
      + "<div><b>For job:</b> #" + esc(j.referral) + " — " + esc(j.customer) + "</div>"
      + "<div><b>Work type:</b> " + esc(j.workType || "") + " · " + esc(j.service || "") + "</div>"
      + "</div><p class='muted'>To place this for real: sign in to Mygrant in the browser, check stock for the NAGS part, and order with Pedro's go-ahead. Then come back here and record the glass cost below.</p></div>";
  }
  $("order-job").addEventListener("change", renderOrderDraft);
  $("save-glass-cost").addEventListener("click", function () {
    var j = getJob($("order-job").value);
    if (!j) { $("order-result").innerHTML = '<div class="err">Select a booked job first.</div>'; return; }
    var cost = $("glass-cost").value === "" ? null : Number($("glass-cost").value);
    var tax = $("glass-tax").value === "" ? null : Number($("glass-tax").value);
    if (cost === null) { $("order-result").innerHTML = '<div class="err">Enter the glass cost from the Mygrant receipt.</div>'; return; }
    j.glassCost = cost;
    if (tax !== null) j.salesTax = tax;
    saveJobs(jobs);
    $("order-result").innerHTML = '<div class="ok">Glass cost ' + fmtMoney(cost) + (tax !== null ? " + tax " + fmtMoney(tax) : "") + " recorded against job #" + esc(j.referral) + ". See True Profit — the job math now includes it.</div>";
  });

  /* ---------------- 4 · invoice ---------------- */
  function renderInvoice() {
    fillJobSelect($("invoice-job"));
    renderInvoiceDraft();
  }
  function renderInvoiceDraft() {
    var j = getJob($("invoice-job").value);
    if (!j) { $("invoice-draft").innerHTML = '<p class="muted">No jobs yet.</p>'; return; }
    var clock = invoiceClock(j);
    var p = computeProfit(j);
    var recal = recalibrationAmount(j, j.recalibrationPerformed);
    // The invoice amount IS the approved amount until the invoice is
    // filed; a job that has not been invoiced yet still drafts at the
    // approved amount, flagged as approved.
    var draftAmount = (j.invoiceAmount === null || j.invoiceAmount === undefined) ? j.approvedAmount : j.invoiceAmount;
    var html = '<h3>Invoice draft — #' + esc(j.referral) + " — " + esc(j.customer) + "</h3>";
    html += '<div class="flag">DRAFT ONLY — Pedro files the real invoice at safelitesolutionsnetwork.com. This preview files nothing.</div>';
    if (clock.state === "not-installed") html += '<div class="flag">No install date yet — the 10-day clock starts at install. Set the install date in the Jobs tab.</div>';
    else if (clock.state === "overdue") html += '<div class="err">OVERDUE: invoice deadline was ' + clock.deadline + " (" + Math.abs(clock.daysLeft) + " days ago). File as soon as possible.</div>";
    else if (clock.state === "due-today") html += '<div class="flag">Invoice is due TODAY (' + clock.deadline + ").</div>";
    else if (clock.state === "on-time") html += '<div class="ok">Invoice deadline ' + clock.deadline + " — " + clock.daysLeft + " day(s) left.</div>";
    else if (clock.state === "invoiced") html += '<div class="ok">Already invoiced' + (j.invoiceDate ? " " + j.invoiceDate : "") + ".</div>";
    if (needsW9(j)) html += '<div class="flag">W-9 REMINDER: signed W-9 goes with the FIRST Progressive invoice. Tick “Signed W-9 on file” in the Jobs tab once it is done.</div>';
    html += '<div class="card"><div class="kv">'
      + "<div><b>Referral #:</b> " + esc(j.referral) + "</div>"
      + "<div><b>Customer:</b> " + esc(j.customer) + " — " + esc(j.phone) + "</div>"
      + "<div><b>Vehicle:</b> " + esc(j.vehicle) + "</div>"
      + "<div><b>VIN:</b> " + (j.vin ? esc(j.vin) : '<span style="color:#c0392b">NOT on the referral sheet — get it from the vehicle before filing</span>') + "</div>"
      + "<div><b>NAGS part:</b> " + esc(j.nags || "—") + "</div>"
      + "<div><b>Insurer:</b> " + esc(j.insurer) + "</div>"
      + "<div><b>Invoice amount:</b> " + fmtMoney(draftAmount) + " — <strong>approved amount, not confirmed billed total, NOT money received</strong></div>"
      + "<div><b>Sales tax:</b> " + fmtMoney(j.salesTax) + "</div>"
      + "<div><b>Recalibration:</b> " + (j.recalibrationRequired ? "required on sheet (" + esc(j.recalibration || "") + "). " : "not required on sheet. ")
      + (recal.amount !== null ? "Performed: " + esc(j.recalibrationPerformed) + " — " + fmtMoney(recal.amount) + " (billed separately, only what was performed)." : "Type performed: not recorded — bill only what was actually performed.") + "</div>"
      + "<div><b>Customer signature:</b> collect at install; the signed invoice goes back with the referral sheet.</div>"
      + "<div><b>Deductible to collect:</b> " + (j.deductible ? fmtMoney(j.deductible) : "$0.00") + "</div>"
      + "</div></div>";
    html += '<p><button class="btn-primary" id="mark-invoiced">Mark as invoiced (app only — does not file)</button></p><div id="invoice-result"></div>';
    $("invoice-draft").innerHTML = html;
    $("mark-invoiced").addEventListener("click", function () {
      if (!j.installDate) { $("invoice-result").innerHTML = '<div class="err">Set the install date first — the 10-day clock needs it.</div>'; return; }
      j.status = "Invoiced - Awaiting Payment";
      j.invoiceDate = j.invoiceDate || todayIso();
      if (j.invoiceAmount === null || j.invoiceAmount === undefined) j.invoiceAmount = j.approvedAmount;
      j.paymentStatus = "Unpaid";
      saveJobs(jobs);
      $("invoice-result").innerHTML = '<div class="ok">Marked invoiced in this app (status → Invoiced - Awaiting Payment). The real filing still happens at safelitesolutionsnetwork.com.</div>';
      renderInvoice();
    });
  }
  $("invoice-job").addEventListener("change", renderInvoiceDraft);

  /* ---------------- 5 · profit ---------------- */
  function renderProfit() {
    if (!jobs.length) { $("profit-table").innerHTML = '<p class="muted">No jobs yet.</p>'; return; }
    var tInv = 0, tGlass = 0, tNet = 0, counted = 0;
    var html = "<table><tr><th>Job</th><th>Invoice (approved)</th><th>Glass</th><th>Tax</th><th>Gross</th><th>Glue</th><th>Labor</th><th>Other</th><th>Net</th><th>Flags</th></tr>";
    jobs.forEach(function (j) {
      var p = computeProfit(j);
      if (p.invoice !== null) tInv += p.invoice;
      if (p.glass !== null) tGlass += p.glass;
      if (p.net !== null) { tNet += p.net; counted++; }
      html += "<tr><td>#" + esc(j.referral) + "<br>" + esc(j.customer) + "</td>"
        + "<td>" + fmtMoney(p.invoice) + "</td><td>" + fmtMoney(p.glass) + "</td><td>" + fmtMoney(p.tax) + "</td>"
        + "<td>" + fmtMoney(p.gross) + "</td><td>" + fmtMoney(p.glue) + "<br><span class='muted'>" + esc(p.glueNote) + "</span></td>"
        + "<td>" + (p.laborCost === null ? "—" : fmtMoney(p.laborCost)) + "<br><span class='muted'>" + (p.laborHours === null ? "hours not entered" : p.laborHours + "h × " + fmtMoney(p.laborRate)) + "</span></td>"
        + "<td>" + fmtMoney(p.other) + "</td>"
        + "<td><strong>" + fmtMoney(p.net) + "</strong>" + (p.netExcludesLabor ? "<br><span class='muted'>excl. labor</span>" : "") + "</td>"
        + "<td>" + (p.flags.length ? p.flags.map(esc).join("<br>") : "—") + "</td></tr>";
    });
    html += "<tr><td><strong>Totals</strong></td><td><strong>" + fmtMoney(tInv) + "</strong></td><td><strong>" + fmtMoney(tGlass) + "</strong></td><td></td><td></td><td></td><td></td><td></td><td><strong>" + fmtMoney(tNet) + "</strong><br><span class='muted'>" + counted + " job(s) with complete math</span></td><td></td></tr></table>";
    html += '<p class="muted">Invoice amounts are approved amounts, not money received. Net excludes labor wherever hours are not entered — flagged per job. Glue appears once per job (per-job column) unless the job is marked “general expense”, in which case it is $0 here and must be counted in Expenses instead.</p>';
    $("profit-table").innerHTML = html;
  }

  /* ---------------- 6 · brief ---------------- */
  function renderBrief() {
    var dateInput = $("brief-date");
    if (!dateInput.value) dateInput.value = todayIso();
    var b = buildBrief(jobs, dateInput.value);
    var html = "<h3>Brief for " + esc(b.date) + "</h3>";
    html += '<p class="muted">' + esc(b.coverageNote) + "</p>";
    if (b.isEmpty) {
      html += '<div class="flag">No jobs in the jobs data for this date. That only means nothing is entered here for this date — it does <strong>not</strong> mean the shop is free.</div>';
    }
    function jobLine(j) {
      return "<li>#" + esc(j.referral) + " — " + esc(j.customer) + " — " + esc(j.vehicle) + " — " + esc(j.address)
        + ' — <a href="' + mapsDirLink(j.address) + '" target="_blank" rel="noopener">Route from shop ↗</a></li>';
    }
    if (b.scheduled.length) html += "<h3>Scheduled today</h3><ul>" + b.scheduled.map(jobLine).join("") + "</ul>";
    if (b.installs.length) html += "<h3>Installs today</h3><ul>" + b.installs.map(jobLine).join("") + "</ul>";
    if (b.toOrder.length) html += "<h3>To order (Mygrant — booked, no glass cost yet)</h3><ul>" + b.toOrder.map(function (j) { return "<li>#" + esc(j.referral) + " — " + esc(j.nags) + " — " + esc(j.vehicle) + " — " + esc(j.customer) + "</li>"; }).join("") + "</ul>";
    if (b.toBill.length) html += "<h3>To bill (10-day clock)</h3><ul>" + b.toBill.map(function (e) { return "<li>#" + esc(e.job.referral) + " — " + esc(e.job.customer) + " — deadline " + esc(e.deadline) + (e.daysLeft < 0 ? " — OVERDUE " + Math.abs(e.daysLeft) + "d" : " — " + e.daysLeft + "d left") + "</li>"; }).join("") + "</ul>";
    if (b.overdue.length) html += '<div class="err"><strong>Overdue invoices:</strong> ' + b.overdue.map(function (e) { return "#" + esc(e.job.referral) + " (" + Math.abs(e.daysLeft) + "d past deadline)"; }).join(", ") + "</div>";
    $("brief-result").innerHTML = html;
  }
  $("brief-go").addEventListener("click", renderBrief);

  /* ---------------- 7 · tech helper ---------------- */
  function renderTech() {
    fillJobSelect($("tech-job"));
    renderTechJob();
  }
  function renderTechJob() {
    var j = getJob($("tech-job").value);
    if (!j) { $("tech-job-result").innerHTML = '<p class="muted">No jobs yet.</p>'; return; }
    var recal = recalibrationAmount(j, j.recalibrationPerformed);
    var html = '<h3>#' + esc(j.referral) + " — " + esc(j.vehicle) + " — " + esc(j.nags) + "</h3><div class='card'><div class='kv'>"
      + "<div><b>Recalibration:</b> " + (j.recalibrationRequired ? "REQUIRED on the referral sheet (" + esc(j.recalibration || "") + "). " : "Not required on the referral sheet. ")
      + (j.recalibrationPerformed ? "Performed: " + esc(j.recalibrationPerformed) + " — " + fmtMoney(recal.amount) + "." : "Type performed: not recorded yet — bill only what was actually performed.") + "</div>"
      + "<div><b>Urethane:</b> Express 30 — safe drive-away about 30 minutes per the product rating. Confirm the exact time on the tube/box label for temperature and humidity conditions. Glue use: 1.5 tubes per job.</div>"
      + "<div><b>Windshield variant:</b> the VIN alone does NOT give the exact variant (rain sensor / ADAS camera / HUD / acoustic / heated). Where the variant matters, ask for a photo of the old glass or the option sticker — never guess it.</div>"
      + "</div></div>";
    $("tech-job-result").innerHTML = html;
  }
  $("tech-job").addEventListener("change", renderTechJob);
  $("decode-vin").addEventListener("click", function () {
    var vin = $("vin-input").value.trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      $("vin-result").innerHTML = '<div class="err">Enter a valid 17-character VIN (letters I, O, Q are never used in VINs).</div>';
      return;
    }
    $("vin-result").innerHTML = '<p class="muted">Decoding via NHTSA…</p>';
    fetch("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/" + vin + "?format=json")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var res = d.Results && d.Results[0];
        if (!res || res.ErrorCode !== "0") {
          $("vin-result").innerHTML = '<div class="err">NHTSA could not decode this VIN' + (res && res.ErrorText ? ": " + esc(res.ErrorText) : ".") + " Check the VIN and try again.</div>";
          return;
        }
        var rows = [["Year", res.ModelYear], ["Make", res.Make], ["Model", res.Model], ["Trim", res.Trim], ["Series", res.Series], ["Body", res.BodyClass], ["Drive type", res.DriveType], ["Engine", [res.EngineModel, res.DisplacementL ? res.DisplacementL + "L" : "", res.FuelTypePrimary].filter(Boolean).join(" ")], ["Transmission", res.TransmissionStyle], ["Plant country", res.PlantCountry], ["Doors", res.Doors]];
        var html = '<h3>Decoded VIN</h3><div class="card"><div class="kv">';
        rows.forEach(function (r) { html += "<div><b>" + r[0] + ":</b> " + val(r[1] || "not stated by NHTSA") + "</div>"; });
        html += "</div></div>";
        html += '<div class="flag">Trim and options come from NHTSA where available — anything marked “not stated” is unknown, not absent. The exact windshield variant (rain sensor / ADAS / HUD / acoustic / heated) is NOT in the VIN decode; confirm with a photo where it matters.</div>';
        $("vin-result").innerHTML = html;
      })
      .catch(function (err) {
        $("vin-result").innerHTML = '<div class="err">NHTSA decode failed (network?): ' + esc(err.message) + "</div>";
      });
  });

  /* ---------------- 8 · pricing ---------------- */
  var pricingLoaded = false;
  function renderPricing() {
    if (pricingLoaded) return;
    fetch("config/pricing.json")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (cfg) {
        pricingLoaded = true;
        var html = "<table><tr><th>Service</th><th>Price (USD)</th></tr>";
        html += "<tr><td>VIN decode</td><td>" + fmtMoney(cfg.prices.decode) + "</td></tr>";
        html += "<tr><td>VIN decode + glass</td><td>" + fmtMoney(cfg.prices.decode_plus_glass) + "</td></tr>";
        html += "<tr><td>Full vehicle (whole-car parts)</td><td>" + fmtMoney(cfg.prices.full_vehicle) + "</td></tr>";
        html += "<tr><td>Location addon</td><td>+" + fmtMoney(cfg.prices.location_addon) + "</td></tr></table>";
        html += '<p class="muted">Source: <code>config/pricing.json</code> — status: <strong>' + esc(cfg.status || "draft") + "</strong>. Edit the numbers there and reload; no prices are hardcoded in the app.</p>";
        $("pricing-result").innerHTML = html;
      })
      .catch(function () {
        $("pricing-result").innerHTML = '<div class="err">Could not load <code>config/pricing.json</code> — serve this folder over HTTP (<code>python3 -m http.server</code> in the <code>shop-ops</code> folder) or open it via the Pages preview. No prices are hardcoded in the app, so nothing is shown until the config loads.</div>';
      });
  }

  /* ---------------- init ---------------- */
  renderJobs();
})();
