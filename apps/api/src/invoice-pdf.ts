import type { InvoiceClientView } from "./payments.js";

/**
 * Invoice PDF generation (Fulfillment Slice D) — the confirmed R&R
 * paper format (black band header, invoice box, vehicle table, item
 * table with the calibration line, 6.25% tax note, thank-you footer),
 * rendered by a small hand-rolled PDF writer: no new dependency, and the
 * content stream stays uncompressed so the leak test can read the text
 * straight out of the bytes.
 *
 * The ONLY input is the client projection (payments.buildInvoiceClientView):
 * the glass line carries cost+profit baked in. Supplier name, raw glass
 * cost, and profit are not in the projection and therefore cannot appear
 * here — the same leak law as every other client surface.
 */

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 46;
const CONTENT_W = PAGE_W - MARGIN * 2;
const RIGHT = MARGIN + CONTENT_W;

const INK: [number, number, number] = [0.1, 0.1, 0.1];
const BLACK: [number, number, number] = [0.04, 0.04, 0.04];
const RED: [number, number, number] = [0.757, 0.153, 0.106]; // #c1271b
const WHITE: [number, number, number] = [1, 1, 1];
const GREY: [number, number, number] = [0.36, 0.36, 0.36];
const DARKBOX: [number, number, number] = [0.12, 0.12, 0.12];

/** PDF strings are latin-1 here: fold typographic characters to ASCII. */
function ascii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-")
    .replace(/·/g, "|")
    .replace(/[^\x20-\x7E]/g, "");
}

function esc(text: string): string {
  return ascii(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Helvetica widths (1/1000 em) for the characters money is made of. */
function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of ascii(text)) {
    if (ch >= "0" && ch <= "9") units += 556;
    else if (ch === "$") units += 556;
    else if (ch === "." || ch === ",") units += 278;
    else if (ch === " ") units += 278;
    else if (ch === "-") units += 333;
    else units += 500;
  }
  return (units / 1000) * size;
}

export function fmtMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${rest}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

const GLASS_LABELS: Record<string, string> = {
  WINDSHIELD: "Windshield",
  BACK_GLASS: "Back glass",
  DOOR_GLASS: "Door glass",
  QUARTER_GLASS: "Quarter glass",
  VENT_GLASS: "Vent glass"
};

class PdfPage {
  private ops: string[] = [];

  /** y is measured from the TOP of the page (converted internally). */
  private y(top: number): number {
    return PAGE_H - top;
  }

  rect(x: number, top: number, w: number, h: number, fill: [number, number, number]) {
    this.ops.push(
      `${fill[0]} ${fill[1]} ${fill[2]} rg ${x} ${this.y(top + h)} ${w} ${h} re f`
    );
  }

  strokeRect(x: number, top: number, w: number, h: number, color: [number, number, number], width = 0.7) {
    this.ops.push(
      `${color[0]} ${color[1]} ${color[2]} RG ${width} w ${x} ${this.y(top + h)} ${w} ${h} re S`
    );
  }

  line(x1: number, top: number, x2: number, color: [number, number, number], width = 0.7) {
    this.ops.push(
      `${color[0]} ${color[1]} ${color[2]} RG ${width} w ${x1} ${this.y(top)} m ${x2} ${this.y(top)} l S`
    );
  }

  /** Baseline text; (x, top) is the top of the line box. */
  text(
    x: number,
    top: number,
    text: string,
    opts: { font?: "F1" | "F2"; size?: number; color?: [number, number, number] } = {}
  ) {
    const font = opts.font ?? "F1";
    const size = opts.size ?? 10;
    const color = opts.color ?? INK;
    const baseline = this.y(top) - size;
    this.ops.push(
      `${color[0]} ${color[1]} ${color[2]} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${baseline} Tm (${esc(text)}) Tj ET`
    );
  }

  textRight(
    right: number,
    top: number,
    text: string,
    opts: { font?: "F1" | "F2"; size?: number; color?: [number, number, number] } = {}
  ) {
    const size = opts.size ?? 10;
    this.text(right - textWidth(text, size), top, text, opts);
  }

  textCenter(
    centerX: number,
    top: number,
    text: string,
    opts: { font?: "F1" | "F2"; size?: number; color?: [number, number, number] } = {}
  ) {
    const size = opts.size ?? 10;
    this.text(centerX - textWidth(text, size) / 2, top, text, opts);
  }

  stream(): string {
    return this.ops.join("\n");
  }
}

/** Greedy word wrap at an approximate character width for a font size. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function renderInvoicePdf(view: InvoiceClientView): Buffer {
  const p = new PdfPage();
  const glassLabel = GLASS_LABELS[view.glass_type] ?? view.glass_type.replaceAll("_", " ");

  // --- Black band header -------------------------------------------------
  p.rect(MARGIN, 40, CONTENT_W, 54, BLACK);
  p.text(MARGIN + 18, 40 + 14, "R&R'S FINEST", { font: "F2", size: 25, color: WHITE });
  const tagW = 92;
  p.rect(RIGHT - tagW - 14, 40 + 14, tagW, 26, RED);
  p.textCenter(RIGHT - tagW / 2 - 14, 40 + 14 + 7, "Auto glass", {
    font: "F2",
    size: 11,
    color: WHITE
  });

  // --- Invoice box / Bill To / Job reference ------------------------------
  const boxTop = 110;
  p.rect(MARGIN, boxTop, 168, 88, DARKBOX);
  const boxLines: [string, { font?: "F1" | "F2"; size?: number }][] = [
    ["Invoice", { font: "F2", size: 13 }],
    ["857-266-1284", {}],
    ["RRsFinest1@gmail.com", {}],
    ["118 Terrace st.", {}],
    ["Roxbury, Ma 02021", {}]
  ];
  boxLines.forEach(([line, o], i) => {
    p.text(MARGIN + 12, boxTop + 8 + i * 15, line, {
      font: o.font ?? "F1",
      size: o.size ?? 9.5,
      color: WHITE
    });
  });

  const billX = MARGIN + 180;
  p.text(billX, boxTop + 2, "BILL TO", { font: "F2", size: 8.5, color: RED });
  p.text(billX, boxTop + 20, view.bill_to ?? "Customer", { font: "F2", size: 11.5 });
  p.text(billX, boxTop + 40, `${view.vehicle.year} ${view.vehicle.make} ${view.vehicle.model}`, {
    size: 9.5,
    color: GREY
  });

  const refX = MARGIN + 352;
  p.text(refX, boxTop + 2, "JOB REFERENCE", { font: "F2", size: 8.5, color: RED });
  p.text(refX, boxTop + 20, `Work Order: ${view.reference}`, { size: 9.5 });
  p.text(refX, boxTop + 36, `Invoice: v${view.invoice_version}`, { size: 9.5 });
  p.text(refX, boxTop + 52, `Date: ${fmtDate(view.issued_at)}`, { size: 9.5 });

  // --- Date / status row ---------------------------------------------------
  const rowTop = 214;
  const cells: { label: string; value: string; x: number; w: number }[] = [
    { label: "DATE", value: fmtDate(view.issued_at), x: MARGIN, w: 168 },
    {
      label: "INVOICE",
      value: `${view.reference} / v${view.invoice_version}`,
      x: MARGIN + 180,
      w: 160
    },
    {
      label: "PAYMENT",
      value:
        view.payment_status === "PAID"
          ? "Paid in full"
          : view.payment_status === "DISPUTED"
            ? "Under review"
            : "Due on receipt",
      x: MARGIN + 352,
      w: 168
    }
  ];
  for (const cell of cells) {
    p.rect(cell.x, rowTop, cell.w, 18, RED);
    p.textCenter(cell.x + cell.w / 2, rowTop + 3.5, cell.label, {
      font: "F2",
      size: 9,
      color: WHITE
    });
    p.strokeRect(cell.x, rowTop + 18, cell.w, 20, GREY);
    p.textCenter(cell.x + cell.w / 2, rowTop + 18 + 4, cell.value, { font: "F2", size: 9.5 });
  }

  // --- Vehicle table --------------------------------------------------------
  const vehTop = 272;
  p.rect(MARGIN, vehTop, CONTENT_W, 22, DARKBOX);
  const vehCols = [
    { label: "Year", x: MARGIN + 8, w: 52 },
    { label: "Vehicle", x: MARGIN + 60, w: 120 },
    { label: "Model", x: MARGIN + 180, w: 150 },
    { label: "Vin#", x: MARGIN + 330, w: 182 }
  ];
  for (const col of vehCols) {
    p.text(col.x, vehTop + 5, col.label, { font: "F2", size: 9.5, color: WHITE });
  }
  const vehVals = [
    String(view.vehicle.year),
    view.vehicle.make,
    view.vehicle.model,
    view.vehicle.vin
  ];
  vehCols.forEach((col, i) => {
    p.text(col.x, vehTop + 22 + 6, vehVals[i], { font: "F2", size: 10 });
  });
  p.line(MARGIN, vehTop + 46, RIGHT, GREY, 0.5);

  // --- Items table ------------------------------------------------------------
  const itemsTop = vehTop + 62;
  p.rect(MARGIN, itemsTop, CONTENT_W, 22, DARKBOX);
  const qtyX = MARGIN + 8;
  const partX = MARGIN + 44;
  const descX = MARGIN + 170;
  const sellRight = RIGHT - 78;
  const totalRight = RIGHT - 8;
  p.text(qtyX, itemsTop + 5, "Qty", { font: "F2", size: 9.5, color: WHITE });
  p.text(partX, itemsTop + 5, "Part Number", { font: "F2", size: 9.5, color: WHITE });
  p.text(descX, itemsTop + 5, "Description", { font: "F2", size: 9.5, color: WHITE });
  p.textRight(sellRight, itemsTop + 5, "Sell", { font: "F2", size: 9.5, color: WHITE });
  p.textRight(totalRight, itemsTop + 5, "Total", { font: "F2", size: 9.5, color: WHITE });

  let rowY = itemsTop + 22;
  const itemRow = (
    qty: string,
    part: string,
    desc: string,
    amount: number | null,
    bold = false
  ) => {
    rowY += 6;
    const font = bold ? "F2" : "F1";
    p.text(qtyX, rowY, qty, { font, size: 10 });
    p.text(partX, rowY, part, { font, size: 10 });
    p.text(descX, rowY, desc, { font, size: 10 });
    if (amount !== null) {
      p.textRight(sellRight, rowY, fmtMoney(amount), { font, size: 10 });
      p.textRight(totalRight, rowY, fmtMoney(amount), { font, size: 10 });
    }
    rowY += 16;
    p.line(MARGIN, rowY, RIGHT, GREY, 0.4);
    rowY += 4;
  };

  itemRow("1", view.part_number ?? "-", `${glassLabel} - replacement glass`, view.glass_cents);
  itemRow("1", "LABOR", "Labor - remove & install", view.labor_cents);
  // Calibration: quoted on the confirmed format, never in the total.
  rowY += 2;
  p.line(MARGIN, rowY, RIGHT, INK, 1.2);
  rowY += 6;
  p.text(partX, rowY, "Calibration", { font: "F2", size: 10 });
  p.text(descX, rowY, "If needed - additional", { font: "F2", size: 10 });
  p.textRight(totalRight, rowY, "$300.00", { font: "F2", size: 10 });
  rowY += 16;
  p.line(MARGIN, rowY, RIGHT, INK, 1.2);
  rowY += 8;

  // --- Totals ------------------------------------------------------------------
  const totLabelX = RIGHT - 190;
  const subtotal = view.glass_cents + view.labor_cents;
  const totalRow = (label: string, cents: number, bold = false, color = INK, size = 10) => {
    p.textRight(totLabelX + 100, rowY, label, { font: bold ? "F2" : "F1", size, color });
    p.textRight(totalRight, rowY, fmtMoney(cents), { font: bold ? "F2" : "F1", size, color });
    rowY += 16;
  };
  totalRow("Subtotal", subtotal);
  totalRow("Tax 6.25%", view.tax_cents);
  p.line(totLabelX, rowY, RIGHT, INK, 1.2);
  rowY += 5;
  totalRow("Total", view.total_cents, true, RED, 13);
  rowY += 2;
  p.text(
    MARGIN,
    rowY,
    `Tax is 6.25% on the glass (${fmtMoney(view.glass_cents)}). Calibration, if needed, is $300 additional and is not included in the total above.`,
    { size: 8.5, color: GREY }
  );
  rowY += 22;
  p.text(
    MARGIN,
    rowY,
    view.payment_status === "PAID"
      ? "Paid in full - thank you!"
      : `Balance due: ${fmtMoney(view.total_cents)}`,
    { font: "F2", size: 12, color: view.payment_status === "PAID" ? INK : RED }
  );

  // --- Thank-you footer ---------------------------------------------------------
  const thanks =
    "Thank you for your business. It's a pleasure to work with you on your project. " +
    "We really appreciate your business and hope that we will be able to grow a relationship " +
    "with your company. We are a small company that specialize in small companies to give " +
    "them the best service possible with accuracy and perfection.";
  let footY = 640;
  for (const line of wrap(thanks, 9.5, 480)) {
    p.text(MARGIN + 20, footY, line, { size: 9.5, color: GREY });
    footY += 13;
  }
  footY += 6;
  p.text(MARGIN + 20, footY, "Sincerely yours,", { size: 9.5, color: GREY });
  footY += 14;
  p.text(MARGIN + 20, footY, "R&R's FINEST,", { font: "F2", size: 9.5, color: GREY });
  p.line(MARGIN, 726, RIGHT, INK, 1.6);
  p.textCenter(
    PAGE_W / 2,
    734,
    "Invoice generated by Case Core | R&R's Finest Auto Glass, 118 Terrace St., Roxbury, MA 02021 | 857-266-1284",
    { size: 8, color: GREY }
  );

  // --- Assemble the document ------------------------------------------------------
  const content = p.stream();
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
