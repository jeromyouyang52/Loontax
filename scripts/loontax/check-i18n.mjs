#!/usr/bin/env node
// LoonTax translation check.
// Every locale's canada.json must have every key in en/canada.json, and a value
// may only equal the English one if it is a term that is not translated
// (product and form names, codes). Run: node scripts/loontax/check-i18n.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = "apps/frontend/src/i18n/locales";
const NS = ["canada.json"];
// Values that are correctly identical in every language.
const SAME_OK = /^(LoonTax|ACB|TFSA|RRSP|FHSA|RESP|RDSP|LIRA|LIF|RRIF|CRA|T5008|CSV|PDF|IBKR|Questrade|Wealthsimple|Schedule 3|ROC|USD|CAD|FX|OK|N\/A|[-–—:/%.,()\s\d{}#+]*|\{\{[^}]+\}\}[\s\S]*)$/;

// Words that are spelled the same in that language (checked by hand).
const SAME_IN = {
  es: ["years.provisional"],
  fr: ["years.gains", "years.net", "dispositions.title", "dispositions.date", "statement.dispositions", "statement.note"],
};

const flat = (o, p = "") =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? flat(v, `${p}${k}.`) : [[`${p}${k}`, String(v)]]);

let problems = 0;
const locales = readdirSync(dir).filter((l) => l !== "en" && existsSync(join(dir, l, NS[0])));
for (const ns of NS) {
  const en = new Map(flat(JSON.parse(readFileSync(join(dir, "en", ns), "utf8"))));
  for (const loc of locales) {
    const t = new Map(flat(JSON.parse(readFileSync(join(dir, loc, ns), "utf8"))));
    const missing = [...en.keys()].filter((k) => !t.has(k));
    const same = [...en].filter(([k, v]) => t.get(k) === v && !SAME_OK.test(v.trim()) && !(SAME_IN[loc] || []).includes(k)).map(([k]) => k);
    if (missing.length || same.length) {
      problems += missing.length + same.length;
      console.log(`${loc}/${ns}: ${missing.length} missing, ${same.length} still English`);
      for (const k of missing.slice(0, 5)) console.log(`  missing: ${k}`);
      for (const k of same.slice(0, 5)) console.log(`  english: ${k} = ${JSON.stringify(en.get(k)).slice(0, 60)}`);
    }
  }
}
console.log(problems ? `\n${problems} problem(s).` : `OK: ${locales.length} locales match en/${NS.join(", ")}.`);
process.exit(problems ? 1 : 0);
