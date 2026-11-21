# LoonTax landing site

Static pages served at https://loontax.vercel.app (Vercel project `loontax`).

- `index.html`, `en/index.html`: presale landing page (zh, en)
- `try.html`, `try.js`, `engine.wasm`: the free beta report. `engine.wasm` is
  built from `crates/canada-tax-wasm` on `main` and committed here by CI.
- `privacy.html`, `contact.html`, `unsubscribe.html`
- `tests/`: end-to-end test of /try (`npm i --no-save jsdom@24 && node tests/try.test.mjs`),
  run by `.github/workflows/site-check.yml`. Not deployed.

- `tools/make_en.py`: rebuilds `en/index.html` from `index.html` (run from the branch root).

Deploy: the Vercel build copies this branch into `public/` and removes
`tests/`, `.github/` and `README.md`.
