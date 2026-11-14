# LoonTax

Canadian investment tax tracking that stays on your computer.

LoonTax keeps your holdings across brokers and works out what the Canada Revenue
Agency asks for:

- **Adjusted cost base** averaged per holder across all non-registered accounts,
  in Canadian dollars at the Bank of Canada's daily rate.
- **Superficial loss rule**: losses denied when the security is bought back
  within 30 days, including inside a TFSA or RRSP.
- **Capital gains by year**, and an **annual statement** laid out for Schedule
  3, as CSV or PDF.
- **TFSA, RRSP and FHSA contribution room**, with the over-contribution tax an
  excess would cost.
- **Broker CSV import** templates for Questrade and Interactive Brokers.

Everything is stored locally in SQLite. The only network request LoonTax adds is
for Bank of Canada exchange rates (currency codes and dates only).

For information only: not tax or investment advice. Check the figures against
your own records before you file; the CRA's rules decide.

## Install

Windows installers are built by GitHub Actions on every push to `main` (Actions
→ "LoonTax Windows installer" → Artifacts). They are not code-signed yet, so
Windows SmartScreen asks for confirmation. A user guide in Chinese is in
[`docs/loontax/user-guide.zh.md`](docs/loontax/user-guide.zh.md).

## Build from source

Requirements and commands are those of Wealthfolio (Rust, Node, pnpm; see
[`AGENTS.md`](AGENTS.md)). To build the LoonTax desktop app:

```sh
pnpm install --frozen-lockfile
pnpm tauri build --config apps/tauri/tauri.loontax.conf.json
```

The Canadian tax code lives in `crates/canada-tax` (pure calculation),
`crates/canada-tax-service` and `apps/frontend/src/features/canada`. Design
notes are in [`docs/loontax/`](docs/loontax/).

## License and credits

LoonTax is built on [Wealthfolio](https://github.com/wealthfolio/wealthfolio) by
Teymz Inc. and contributors. The first commit of this repository is
Wealthfolio's source at upstream commit `52008d7`; everything after it is
LoonTax's work. Wealthfolio's original README is kept as
[`README.wealthfolio.md`](README.wealthfolio.md).

Both are licensed under the [GNU Affero General Public License v3.0](LICENSE).
If you distribute LoonTax, or offer it to users over a network, you must offer
them its complete source code under the same license.
