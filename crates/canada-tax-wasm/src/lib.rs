//! The LoonTax engine for the browser.
//!
//! One function: a JSON request in (accounts, trades, Bank of Canada answers),
//! one JSON report out. Everything runs on the user's machine; this crate does
//! no I/O. [`report_json`] is plain Rust and is what the tests call; the
//! `wasm32` build adds three exported functions so a page can call it without
//! any JavaScript glue generator:
//!
//! ```text
//! const ptr = engine.alloc(len); copy UTF-8 request to memory[ptr..ptr+len]
//! const out = engine.report(ptr, len);  // pointer to: u32 length (LE) + UTF-8 JSON
//! read the JSON, then engine.free(out, 4 + jsonLength)
//! ```

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use loontax_canada_tax::{
    parse_observations, summarize_year, CanadaAccountInfo, IssueReason, RateTable, Rules,
    TaxActivity, TaxActivityKind, TaxBook,
};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

/// What the page sends.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Today, as the user's computer sees it: decides which recent sales are
    /// still provisional under the 30-day rule.
    pub as_of: NaiveDate,
    /// Account id to its CRA registration. `null` when the user has not said.
    pub accounts: HashMap<String, Option<CanadaAccountInfo>>,
    /// In the order they happened.
    pub activities: Vec<RequestActivity>,
    /// Currency code to the raw answer of the Bank of Canada Valet API.
    #[serde(default)]
    pub rates: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestActivity {
    pub id: String,
    pub account_id: String,
    pub security_id: String,
    pub date: NaiveDate,
    pub currency: String,
    #[serde(flatten)]
    pub kind: RequestKind,
}

/// Amounts are positive and final: a buy's cost includes commissions, a
/// sale's proceeds are net of them.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum RequestKind {
    Buy {
        units: Decimal,
        cost: Decimal,
    },
    Sell {
        units: Decimal,
        net_proceeds: Decimal,
    },
    Split {
        ratio: Decimal,
    },
    ReturnOfCapital {
        amount: Decimal,
    },
    NotionalDistribution {
        amount: Decimal,
    },
}

/// What the page gets back. Amounts are Canadian dollars, as strings rounded
/// to the cent.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub years: Vec<Year>,
    pub dispositions: Vec<Sale>,
    pub holdings: Vec<Holding>,
    pub issues: Vec<Problem>,
    pub fx_fallbacks: Vec<Fallback>,
    /// A currency whose Bank of Canada answer could not be read.
    pub rate_errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Year {
    pub year: i32,
    pub gains: String,
    pub losses: String,
    pub denied_losses: String,
    pub net: String,
    pub taxable: String,
    pub provisional: bool,
    pub needs_review: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sale {
    pub holder: String,
    pub security_id: String,
    pub date: NaiveDate,
    pub units: String,
    pub proceeds: String,
    pub acb: String,
    /// Gain or loss to report, after the superficial loss rule.
    pub gain: String,
    pub denied_loss: String,
    pub provisional: bool,
    pub needs_review: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub holder: String,
    pub security_id: String,
    pub units: String,
    pub acb: String,
    pub acb_per_unit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub security_id: String,
    pub holder: Option<String>,
    /// Machine-readable: `UNCLASSIFIED_ACCOUNT`, `MISSING_FX_RATE`, ...
    pub reason: String,
    /// Account id, activity id or date the reason is about.
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fallback {
    pub activity_id: String,
    pub currency: String,
    pub date: NaiveDate,
    pub rate_date: NaiveDate,
}

fn cents(value: Decimal) -> String {
    let rounded = value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
    format!("{rounded:.2}")
}

fn units(value: Decimal) -> String {
    value.normalize().to_string()
}

/// Builds the report. An error only when the request itself cannot be read;
/// problems with the data come back inside the report.
pub fn report(request: Request) -> Result<Report, String> {
    let rules = Rules::embedded().map_err(|e| e.to_string())?;
    let mut report = Report::default();

    let mut table = RateTable::new();
    for (currency, answer) in &request.rates {
        match parse_observations(answer, currency) {
            Ok(rates) => table.extend(currency, rates),
            Err(e) => report.rate_errors.push(format!("{currency}: {e}")),
        }
    }

    let activities: Vec<TaxActivity> = request
        .activities
        .into_iter()
        .map(|a| TaxActivity {
            id: a.id,
            account_id: a.account_id,
            security_id: a.security_id,
            date: a.date,
            currency: a.currency,
            kind: match a.kind {
                RequestKind::Buy { units, cost } => TaxActivityKind::Buy { units, cost },
                RequestKind::Sell {
                    units,
                    net_proceeds,
                } => TaxActivityKind::Sell {
                    units,
                    net_proceeds,
                },
                RequestKind::Split { ratio } => TaxActivityKind::Split { ratio },
                RequestKind::ReturnOfCapital { amount } => {
                    TaxActivityKind::ReturnOfCapital { amount }
                }
                RequestKind::NotionalDistribution { amount } => {
                    TaxActivityKind::NotionalDistribution { amount }
                }
            },
        })
        .collect();

    let book = TaxBook::build(
        &activities,
        &request.accounts,
        &table,
        &rules.superficial_loss,
        request.as_of,
    );

    let mut years: BTreeMap<i32, (Decimal, Decimal, Decimal, bool, bool)> = BTreeMap::new();
    for position in &book.positions {
        let ledger = &position.ledger;
        for record in &ledger.dispositions {
            report.dispositions.push(Sale {
                holder: position.holder.clone(),
                security_id: position.security_id.clone(),
                date: record.date,
                units: units(record.units),
                proceeds: cents(record.net_proceeds_cad),
                acb: cents(record.acb_relieved_cad),
                gain: cents(record.reportable_gain_cad()),
                denied_loss: cents(record.denied_loss_cad),
                provisional: record.provisional,
                needs_review: record.needs_review,
            });
        }
        let mut seen: Vec<i32> = ledger
            .dispositions
            .iter()
            .map(|r| chrono::Datelike::year(&r.date))
            .chain(
                ledger
                    .deemed_gains
                    .iter()
                    .map(|g| chrono::Datelike::year(&g.date)),
            )
            .collect();
        seen.sort_unstable();
        seen.dedup();
        for year in seen {
            if let Some(summary) = summarize_year(ledger, year, &rules) {
                let entry = years.entry(year).or_default();
                entry.0 += summary.gains_cad;
                entry.1 += summary.losses_cad;
                entry.2 += summary.denied_losses_cad;
                entry.3 |= summary.provisional;
                entry.4 |= summary.needs_review;
            }
        }
        if ledger.pool.units() > Decimal::ZERO {
            report.holdings.push(Holding {
                holder: position.holder.clone(),
                security_id: position.security_id.clone(),
                units: units(ledger.pool.units()),
                acb: cents(ledger.pool.total_cad()),
                acb_per_unit: ledger.pool.per_unit_cad().map(|v| {
                    v.round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero)
                        .to_string()
                }),
            });
        }
    }
    report
        .dispositions
        .sort_by(|a, b| a.date.cmp(&b.date).then(a.security_id.cmp(&b.security_id)));

    for (year, (gains, losses, denied, provisional, needs_review)) in years {
        let net = gains - losses;
        let rate = rules
            .capital_gains_inclusion_rate(year)
            .unwrap_or(Decimal::ZERO);
        report.years.push(Year {
            year,
            gains: cents(gains),
            losses: cents(losses),
            denied_losses: cents(denied),
            net: cents(net),
            taxable: cents(net * rate),
            provisional,
            needs_review,
        });
    }

    for issue in book.issues {
        let (reason, detail) = match issue.reason {
            IssueReason::UnclassifiedAccount { account_id } => ("UNCLASSIFIED_ACCOUNT", account_id),
            IssueReason::MissingFxRate { currency, date } => {
                ("MISSING_FX_RATE", format!("{currency} {date}"))
            }
            IssueReason::UnsupportedTransfer { activity_id } => {
                ("UNSUPPORTED_TRANSFER", activity_id)
            }
            IssueReason::UnreadableActivity { activity_id } => ("UNREADABLE_ACTIVITY", activity_id),
            IssueReason::ConflictingSplits { date } => ("CONFLICTING_SPLITS", date.to_string()),
            IssueReason::InvalidHistory(e) => ("INVALID_HISTORY", e.to_string()),
        };
        report.issues.push(Problem {
            security_id: issue.security_id,
            holder: issue.holder,
            reason: reason.to_string(),
            detail,
        });
    }
    report.fx_fallbacks = book
        .fx_fallbacks
        .into_iter()
        .map(|f| Fallback {
            activity_id: f.activity_id,
            currency: f.currency,
            date: f.date,
            rate_date: f.rate_date,
        })
        .collect();
    Ok(report)
}

/// JSON in, JSON out. A request that cannot be read answers
/// `{"error": "..."}`.
pub fn report_json(request: &str) -> String {
    let answer = serde_json::from_str::<Request>(request)
        .map_err(|e| format!("The request cannot be read: {e}"))
        .and_then(report);
    let json = match answer {
        Ok(report) => serde_json::to_string(&report),
        Err(error) => serde_json::to_string(&serde_json::json!({ "error": error })),
    };
    json.unwrap_or_else(|_| r#"{"error":"The report could not be written."}"#.to_string())
}

#[cfg(target_arch = "wasm32")]
#[allow(
    unsafe_code,
    reason = "FFI: unmangled exports and the buffers the page passes in and out"
)]
mod exports {
    //! The browser calls these through the WebAssembly memory. Every buffer
    //! is a boxed byte slice (capacity equals length), handed back to `free`
    //! with its length.

    fn leak(bytes: Vec<u8>) -> *mut u8 {
        Box::into_raw(bytes.into_boxed_slice()).cast::<u8>()
    }

    /// Reserves `len` bytes for the page to write a request into.
    #[no_mangle]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        leak(vec![0; len])
    }

    /// Gives back a buffer from `alloc` or `report`.
    ///
    /// # Safety
    /// `ptr` and `len` must be exactly what `alloc` or `report` produced, and
    /// the buffer must not be used afterwards.
    #[no_mangle]
    #[allow(
        unsafe_code,
        reason = "FFI: rebuilds the boxed slice the page received"
    )]
    pub unsafe extern "C" fn free(ptr: *mut u8, len: usize) {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }

    /// Reads `len` bytes of UTF-8 JSON at `ptr` (from `alloc`, freed here)
    /// and returns a buffer: a little-endian u32 length, then the report JSON.
    ///
    /// # Safety
    /// `ptr` must come from `alloc(len)`.
    #[no_mangle]
    #[allow(
        unsafe_code,
        reason = "FFI: takes back the request buffer the page wrote"
    )]
    pub unsafe extern "C" fn report(ptr: *mut u8, len: usize) -> *mut u8 {
        let request = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
        let json = match std::str::from_utf8(&request) {
            Ok(text) => super::report_json(text),
            Err(_) => r#"{"error":"The request is not UTF-8."}"#.to_string(),
        };
        let length = u32::try_from(json.len()).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(4 + json.len());
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(json.as_bytes());
        leak(out)
    }
}
