# CLAUDE.md — LoonTax

LoonTax is a Canadian investor tax assistant (ACB, superficial losses, Bank of
Canada FX, TFSA/RRSP/FHSA room, Schedule 3). This repository is Wealthfolio
(AGPL-3.0, imported at upstream 52008d7) plus LoonTax's own code. Follow
`AGENTS.md` for everything about the Wealthfolio codebase; this file adds what
is specific to LoonTax. Product and architecture: `docs/loontax/`.

## What matters and where it lives

The product's value is correct tax figures that people can trust. The only
core asset is the tax engine and the cases that prove it right; the desktop
app, the planned web report and the landing page are shells around it.

| Name you will see | What it is |
| --- | --- |
| `crates/canada-tax` (package `loontax-canada-tax`) | The engine. Pure calculation: rule table, ACB pool, superficial loss, year summary, FX fallback, contribution room. No I/O, no Wealthfolio dependency; must keep compiling to `wasm32-unknown-unknown` (CI checks it). Original code, owned by the founder. |
| `crates/canada-tax-service` (package `loontax-canada-tax-service`) | Glue between the engine and Wealthfolio: reads stored activities, fetches Bank of Canada rates, builds the reports. Desktop/server only. |
| `crates/storage-sqlite/src/loontax_fx`, migrations `*_loontax_*` | Stored BoC rates and import templates. Never edit a shipped migration. |
| `apps/frontend/src/features/canada/` | Tax pages (`/tax`, `/tax?view=room`, `/tax/statement`). |
| `apps/frontend/src/i18n/locales/*/canada.json` | Tax UI text, 11 languages. |
| `/api/v1/loontax/*`, Tauri `get_tax_report` etc. | Endpoints for the tax pages. |
| Account `meta.canada` | Where an account's CRA registration type and holder are stored. |
| "Maple Ledger" | Old code name. Same product. |

About 86 upstream files carry small LoonTax edits (rename, Connect hidden,
import fix). Keep upstream edits minimal: every one makes upstream updates
harder. Prefer adding LoonTax code in the places above.

## Direction (2026-11-21)

- Engine first. Both shells use the same engine; fix a rule once.
- Desktop app: maintenance only, no new features until the web report is
  validated.
- Web report (planned): the engine compiled to WebAssembly, running in the
  browser; trade files never leave the user's machine.
- Presale validation until 2027-01-15: landing page at
  https://loontax.vercel.app (source: branch `landing-site`, Vercel project
  `loontax`; waitlist in Supabase project `loontax-waitlist`, ca-central-1).

## Done means verified

Most rework so far came from calling something done without seeing it work.

- UI change: show the founder a screenshot of the changed screen (and `?dir=rtl`
  where layout changed) before saying it is done.
- Deploy: open the live URL afterwards and exercise the changed path (submit the
  form, load the page). If the environment cannot reach it, say so and ask the
  founder to check; do not report it as working.
- Claims in docs or messages ("all translated", "tests pass"): back each with
  the command that proves it. `node scripts/loontax/check-i18n.mjs` checks that
  no `canada.json` string is left in English.
- Visible design work: agree on the look (references, colours) before building.
- Tax rules: cite the CRA or Government of Canada page in the rule table; a
  change to a rule needs a golden test in `crates/canada-tax/tests/`.

## Known environment limits (Claude's cloud workspace)

- Outbound network is allowlisted: GitHub and package registries work; the
  Bank of Canada, Supabase, Vercel sites, `static.rust-lang.org` (so no new
  rustup targets) and most websites do not. Check those in CI or with the
  founder.
- `rust-toolchain.toml` pins 1.99.1, which cannot be downloaded here. Run
  cargo with `RUSTUP_TOOLCHAIN=stable` locally; CI uses the pinned one.
- The GitHub proxy refuses repository settings changes (visibility, etc.) and
  GraphQL; use `gh api` REST.
- Vercel cannot read this repository through Git. Deploy the landing page with
  files in the deployment request.
- The Windows installer cannot be built here; `loontax-windows.yml` builds it
  on a `loontax-v*` tag or by hand (~15 min). `loontax-check.yml` runs the fast
  checks on every push.
- Do not put the founder's personal email in scripts or pages; the site uses a
  contact form.

## Commands

| Task | Command |
| --- | --- |
| Engine tests | `cargo test -p loontax-canada-tax --locked` |
| Service tests | `cargo test -p loontax-canada-tax-service --locked` |
| Translation completeness | `node scripts/loontax/check-i18n.mjs` and `pnpm --filter frontend i18n:check` |
| Installer | push tag `loontax-vX.Y.Z`, or run "LoonTax Windows installer" by hand |
