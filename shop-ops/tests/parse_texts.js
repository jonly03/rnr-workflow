// Parse referral sheet text files with the in-browser parser (parser.js)
// and print one JSON object per line: { file, parsed }.
// Usage: node tests/parse_texts.js <dir-of-.txt-files> [filename-hint-map.json]
// The optional hint map is { "ref-833614.txt": "ref-833614.pdf", ... } so
// the parser can take a referral number from the filename when the sheet
// masks it (XXXXXX), exactly as the app does for a dropped PDF.
const fs = require("fs");
const path = require("path");
const { parseReferralText } = require("../parser.js");

const dir = process.argv[2];
const hintMap = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], "utf8")) : {};

fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort().forEach((f) => {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const parsed = parseReferralText(text, hintMap[f] || null);
  console.log(JSON.stringify({ file: f, parsed }));
});
