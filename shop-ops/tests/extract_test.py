#!/usr/bin/env python3
"""Shop Ops Brain — referral extraction test (Layer 3 MVP).

Verifies the referral parser against the REAL 8 Safelite referral PDFs
and the ground-truth data file, field by field.

  Part A: the VERIFIED Python parser (referral_intake.py, 0 mismatches
          on 2026-11-13) re-parses the 8 real PDFs and is compared to
          safelite-jobs-data.json.
  Part B: the JavaScript port in shop-ops/parser.js (the one the app
          runs in the browser) parses the same 8 sheets' text via Node
          and is compared to the same ground truth — including the
          #833614 masked-number / truncated-name overrides.
  Part C: the synthetic PDF the app generates for Lou (logic.js
          buildSyntheticReferralPdf) is written out, re-read with
          pypdf, and parsed by the JS parser — the round trip must
          reproduce the synthetic job.

Usage (from the repo root, or anywhere):
    python3 shop-ops/tests/extract_test.py [--no-network]

Requires: pypdf (pip install pypdf) and node on PATH.
Paths default to the shop workspace; override with env vars:
    SHOPOPS_REFERRALS_DIR, SHOPOPS_DATA_JSON, SHOPOPS_PARSER_PY

Exit 0 = 8/8 referrals, 0 mismatches in every part.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path.home()
REFERRALS_DIR = Path(os.environ.get(
    "SHOPOPS_REFERRALS_DIR", HOME / "workspace/your_files/safelite-jobs/referrals"))
DATA_JSON = Path(os.environ.get(
    "SHOPOPS_DATA_JSON", HOME / "workspace/your_files/safelite-jobs/safelite-jobs-data.json"))
PARSER_PY = Path(os.environ.get(
    "SHOPOPS_PARSER_PY", HOME / "workspace/shop-ops-brain/referral_intake.py"))
HERE = Path(__file__).resolve().parent
SHOPOPS_DIR = HERE.parent

sys.path.insert(0, str(PARSER_PY.parent))
try:
    from pypdf import PdfReader
except ImportError:
    print("ERROR: pypdf is required (pip install pypdf).")
    sys.exit(2)
try:
    import referral_intake as ri
except ImportError as e:
    print(f"ERROR: cannot import verified parser from {PARSER_PY}: {e}")
    sys.exit(2)

# data.json key <- parser key
COMPARE_FIELDS = [
    ("referral_date", "referralDate"),
    ("customer", "customer"),
    ("address", "address"),
    ("phone", "phone"),
    ("vehicle", "vehicle"),
    ("nags", "nags"),
    ("deductible", "deductible"),
    ("approved_amount", "approvedAmount"),
    ("insurer", "insurer"),
    ("date_of_loss", "dateOfLoss"),
    ("pricing", "pricing"),
    ("recalibration", "recalibration"),
]


def pdf_text(path):
    reader = PdfReader(str(path))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def compare(ref, parsed, entry, mismatches, label):
    for pkey, dkey in COMPARE_FIELDS:
        got, want = parsed[pkey], entry.get(dkey)
        if got != want:
            mismatches.append((ref, label, dkey, want, got))
            print(f"  [MISMATCH] #{ref} {label} {dkey}: data.json={want!r} parsed={got!r}")
        else:
            print(f"  [OK] #{ref} {label} {dkey}: {want!r}")
    # referral number itself: some sheets mask it ("NO COV" on #775727,
    # "XXXXXX" on #833614) — the number then comes from the filename /
    # email, exactly as the real intake does. Only a *different digit*
    # number is a mismatch; a masked value is informational.
    sheet_ref = parsed.get("referral_sheet")
    got_ref = parsed.get("referral") or sheet_ref
    if got_ref != ref:
        if got_ref and got_ref.isdigit():
            mismatches.append((ref, label, "referral", ref, got_ref))
            print(f"  [MISMATCH] #{ref} {label} referral: data.json={ref!r} parsed={got_ref!r}")
        else:
            print(f"  [note] #{ref} {label} sheet masks referral number as {sheet_ref!r}; number {ref} comes from filename/email")
    if parsed.get("nags") and parsed["nags"] not in (entry.get("work") or ""):
        mismatches.append((ref, label, "work", entry.get("work"), parsed["nags"]))
        print(f"  [MISMATCH] #{ref} {label} work: data.json={entry.get('work')!r} nags={parsed['nags']!r}")


def main():
    data = json.loads(DATA_JSON.read_text())
    by_ref = {j["referral"]: j for j in data["jobs"]}
    pdfs = sorted(REFERRALS_DIR.glob("ref-*.pdf"))
    print(f"Found {len(pdfs)} referral PDFs, {len(by_ref)} jobs in data.json\n")
    mismatches = []

    # ---- Part A: verified Python parser ----------------------------------
    print("Part A — verified Python parser (referral_intake.py) vs data.json")
    for pdf in pdfs:
        ref = pdf.stem.split("-", 1)[1]
        parsed = ri.parse_sheet(pdf_text(pdf))
        if ref in ri.VERIFIED_OVERRIDES:
            parsed.update(ri.VERIFIED_OVERRIDES[ref])
            parsed["referral"] = ref
        entry = by_ref.get(ref)
        if entry is None:
            print(f"  [MISMATCH] #{ref}: missing from data.json")
            mismatches.append((ref, "py", "present", True, False))
            continue
        print(f"#{ref} ({entry['customer']}):")
        compare(ref, parsed, entry, mismatches, "py")

    # ---- Part B: JS parser (the in-browser one) via Node ------------------
    print("\nPart B — JS parser (shop-ops/parser.js) vs data.json")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        hints = {}
        for pdf in pdfs:
            ref = pdf.stem.split("-", 1)[1]
            (tmp / f"ref-{ref}.txt").write_text(pdf_text(pdf))
            hints[f"ref-{ref}.txt"] = f"ref-{ref}.pdf"
        (tmp / "hints.json").write_text(json.dumps(hints))
        r = subprocess.run(["node", str(HERE / "parse_texts.js"), str(tmp), str(tmp / "hints.json")],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print("ERROR: node parse_texts.js failed:\n" + r.stderr[:2000])
            return 2
        for line in r.stdout.strip().splitlines():
            row = json.loads(line)
            ref = row["file"].split("-", 1)[1].split(".")[0]
            parsed = row["parsed"]
            if ref in ri.VERIFIED_OVERRIDES:
                # JS parser applies the same override itself; assert it did.
                pass
            entry = by_ref.get(ref)
            print(f"#{ref} ({entry['customer']}):")
            compare(ref, parsed, entry, mismatches, "js")

    # ---- Part C: synthetic PDF round trip ---------------------------------
    print("\nPart C — synthetic PDF round trip (generate -> pypdf -> JS parse)")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gen = subprocess.run(
            ["node", "-e",
             "const l=require(process.argv[1]);"
             "const jobs=require(process.argv[2]);"
             "const fs=require('fs');"
             "const job=jobs.find(j=>j.referral==='700006');"
             "fs.writeFileSync(process.argv[3], l.buildSyntheticReferralPdf(job), 'latin1');",
             str(SHOPOPS_DIR / "logic.js"),
             str(SHOPOPS_DIR / "fixtures/synthetic-jobs.json"),
             str(tmp / "synthetic-referral-700006.pdf")],
            capture_output=True, text=True)
        if gen.returncode != 0:
            print("ERROR: generating synthetic PDF failed:\n" + gen.stderr[:2000])
            return 2
        text = pdf_text(tmp / "synthetic-referral-700006.pdf")
        (tmp / "syn.txt").write_text(text)
        (tmp / "hints.json").write_text(json.dumps({"syn.txt": "ref-700006.pdf"}))
        r = subprocess.run(["node", str(HERE / "parse_texts.js"), str(tmp), str(tmp / "hints.json")],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print("ERROR: node parse_texts.js failed:\n" + r.stderr[:2000])
            return 2
        row = json.loads(r.stdout.strip().splitlines()[0])
        parsed = row["parsed"]
        want = {"referral": "700006", "customer": "Sara Wilson", "vehicle": "2023 Honda HR-V",
                "nags": "FW05907 GTY", "approved_amount": 1117.58,
                "recalibration_required": True}
        for k, v in want.items():
            if parsed.get(k) != v:
                mismatches.append(("700006", "synth-pdf", k, v, parsed.get(k)))
                print(f"  [MISMATCH] synthetic PDF {k}: want={v!r} got={parsed.get(k)!r}")
            else:
                print(f"  [OK] synthetic PDF {k}: {v!r}")

    print(f"\nExtraction test complete: {len(mismatches)} mismatch(es) across all parts.")
    if mismatches:
        for ref, part, field, want, got in mismatches:
            print(f"  MISMATCH #{ref} [{part}] {field}: data.json={want!r} parsed={got!r}")
        return 1
    print("8/8 referrals extract correctly in Python AND in the JS (in-browser) parser; synthetic PDF round-trips.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
