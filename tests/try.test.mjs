// End-to-end test of /try: real page, real try.js, real engine.wasm, sample
// broker exports, the Bank of Canada answer saved in samples/. Expected figures
// are hand-computed (see crates/canada-tax-wasm/tests/report.rs on main).
// Run: npm i --no-save jsdom@24 && node tests/try.test.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (n) => join(root, 'tests/samples', n);
const valet = readFileSync(sample('valet-usd.json'), 'utf8');

async function run(names, { pick = 'NON_REGISTERED', today = '2026-11-21' } = {}) {
  const dom = new JSDOM(readFileSync(join(root, 'try.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://loontax.test/try' });
  const w = dom.window;
  Object.assign(w, { WebAssembly, TextEncoder, TextDecoder, DecompressionStream, Response, Blob });
  w.__LOONTAX_TODAY = today;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async (url) => {
    if (url === '/engine.wasm') { const b = readFileSync(join(root, 'engine.wasm')); return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
    if (String(url).includes('bankofcanada.ca')) return { ok: true, text: async () => valet };
    throw new Error('unexpected fetch ' + url);
  };
  w.eval(readFileSync(join(root, 'try.js'), 'utf8'));
  const $ = (s) => w.document.querySelector(s);
  const files = names.map((n) => {
    const bytes = readFileSync(sample(n));
    return { name: n, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  });
  const drop = new w.Event('drop', { bubbles: true, cancelable: true });
  drop.dataTransfer = { files };
  $('#drop').dispatchEvent(drop);
  await new Promise((r) => setTimeout(r, 300));
  const fileLines = [...w.document.querySelectorAll('.file')].map((e) => e.textContent);
  const accounts = {};
  for (const s of w.document.querySelectorAll('select[data-acct]')) {
    accounts[s.getAttribute('data-acct')] = s.value;
    if (!s.value) { s.value = pick; s.dispatchEvent(new w.Event('change')); }
  }
  $('#run').click();
  await new Promise((r) => setTimeout(r, 1500));
  const cells = (sel) => [...w.document.querySelectorAll(sel + ' tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
  const harvest = async (symbol, price) => {
    const tr = [...w.document.querySelectorAll('#harvest tbody tr')].find((t) => t.children[0].textContent === symbol);
    const input = tr.querySelector('input[type=number]');
    input.value = String(price);
    input.dispatchEvent(new w.Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    return { unrealized: tr.querySelector('.out-unreal').textContent, sim: tr.querySelector('.out-sim').textContent, picked: tr.querySelector('.pick input').checked };
  };
  return {
    harvest, deadline: () => $('#harvest-deadline').textContent, total: () => $('#harvest-total').textContent,
    fileLines, accounts, message: $('#run-msg').textContent,
    kpis: [...w.document.querySelectorAll('#kpis .kpi strong')].map((k) => k.textContent),
    sales: cells('#sales'), holdings: cells('#holdings'), issues: $('#issues').textContent,
  };
}

const ALL_2026 = ['$278.62', '$142.10', '$200.00', '$136.52', '$68.26'];
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); }
}

await check('Questrade CSV + IBKR statement + IBKR Flex', async () => {
  const r = await run(['questrade.csv', 'ibkr-statement.csv', 'ibkr-flex.csv']);
  assert.equal(r.accounts['Questrade 51234567'], 'NON_REGISTERED');
  assert.equal(r.accounts['Questrade 59990000'], 'TFSA');
  assert.deepEqual(r.kpis, ALL_2026);
  assert.deepEqual(r.sales.map((s) => [s[0], s[1], s[3], s[4], s[5]]), [
    ['2026-03-10', 'XYZ', '$800.00', '$1,000.00', '$0.00'],
    ['2026-07-01', 'MSFT', '$1,278.90', '$1,421.00', '−$142.10'],
    ['2026-07-02', 'AAPL', '$3,119.82', '$2,841.20', '$278.62'],
  ]);
  assert.deepEqual(r.holdings, [['SHOP', '4', '$601.00', '$150.2500']]);
  assert.equal(r.issues.trim(), '');
});

await check('Questrade Excel file with real date cells', async () => {
  const r = await run(['questrade.xlsx', 'ibkr-statement.csv']);
  assert.match(r.fileLines[0], /Questrade · 读到 5 笔买卖/);
  assert.deepEqual(r.kpis, ALL_2026);
});

await check('Day-first dates (29/6/2026) are read as day/month', async () => {
  const r = await run(['questrade-dmy.csv', 'ibkr-statement.csv']);
  assert.deepEqual(r.kpis, ALL_2026);
});

await check('An account left without a type is reported, not guessed', async () => {
  const r = await run(['ibkr-flex.csv'], { pick: '' });
  assert.match(r.message, /没选类型/);
});

await check('Year-end check: selling SHOP at a loss today lowers the year', async () => {
  const r = await run(['questrade.csv', 'ibkr-statement.csv', 'ibkr-flex.csv']);
  assert.match(r.deadline(), /2026-12-30/);
  assert.match(r.deadline(), /还有 39 天/);
  const row = await r.harvest('SHOP', 100); // 4 x 100 = 400 CAD against an ACB of 601
  assert.equal(row.unrealized, '−$201.00');
  assert.match(row.sim, /可抵扣亏损 \$201\.00/);
  assert.match(row.sim, /2026-12-22 之前不要/);
  assert.equal(row.picked, true);
  assert.match(r.total(), /净额变成 −\$64\.48/);   // 136.52 - 201.00
  assert.match(r.total(), /计入收入的部分 −\$32\.24/);
});

await check('Year-end check: a TFSA purchase 11 days ago denies the loss', async () => {
  const r = await run(['generic-tfsa.csv']);
  const row = await r.harvest('ABC', 50); // 10 x 50 = 500 against 1000
  assert.equal(row.unrealized, '−$500.00');
  // 5 of the 10 units were rebought in the TFSA: half of the 500 loss is denied.
  assert.match(row.sim, /亏损 \$250\.00 会被否认/);
});

await check('Year-end check: a USD holding uses the latest Bank of Canada rate', async () => {
  const r = await run(['generic-usd.csv'], { today: '2026-07-06' });
  // ACB 2000 x 1.4206 = 2841.20; 10 x 190 x 1.4201 (Jul 3, latest) = 2698.19
  const row = await r.harvest('AAPL', 190);
  assert.equal(row.unrealized, '−$143.01');
  assert.match(row.sim, /可抵扣亏损 \$143\.01/);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
