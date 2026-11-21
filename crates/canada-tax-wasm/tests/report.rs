//! The browser report, end to end through JSON, on hand-checked figures.
//! USD rates are the Bank of Canada's real answer for 2026-06-29..07-03
//! (canada-tax's fixture); 2026-07-01 had no rate (Canada Day).

use serde_json::{json, Value};

const VALET_USD: &str =
    include_str!("../../canada-tax/tests/fixtures/valet-FXUSDCAD-2026-06-29-to-2026-07-03.json");

fn run(request: Value) -> Value {
    let out = loontax_canada_tax_wasm::report_json(&request.to_string());
    serde_json::from_str(&out).expect("the report is JSON")
}

// One row of a broker export: the fields are what a row has.
#[allow(clippy::too_many_arguments)]
fn trade(
    id: &str,
    account: &str,
    security: &str,
    date: &str,
    currency: &str,
    kind: &str,
    units: &str,
    amount: &str,
) -> Value {
    let amount_key = if kind == "BUY" { "cost" } else { "netProceeds" };
    json!({ "id": id, "accountId": account, "securityId": security, "date": date,
            "currency": currency, "kind": kind, "units": units, amount_key: amount })
}

fn base(activities: Vec<Value>) -> Value {
    json!({
        "asOf": "2026-11-21",
        "accounts": {
            "Q-MARGIN": { "registration": "NON_REGISTERED" },
            "Q-TFSA": { "registration": "TFSA" },
            "UNKNOWN": null
        },
        "activities": activities,
        "rates": { "USD": VALET_USD }
    })
}

#[test]
fn usd_gain_and_loss_with_bank_of_canada_rates() {
    let report = run(base(vec![
        // 2000 USD x 1.4206 = 2841.20; 2200 x 1.4181 = 3119.82; gain 278.62
        trade(
            "1",
            "Q-MARGIN",
            "AAPL",
            "2026-06-29",
            "USD",
            "BUY",
            "10",
            "2000",
        ),
        trade(
            "2",
            "Q-MARGIN",
            "AAPL",
            "2026-07-02",
            "USD",
            "SELL",
            "10",
            "2200",
        ),
        // 1000 x 1.4210 = 1421.00; 900 on Canada Day at 06-30's 1.4210 = 1278.90; loss 142.10
        trade(
            "3",
            "Q-MARGIN",
            "MSFT",
            "2026-06-30",
            "USD",
            "BUY",
            "5",
            "1000",
        ),
        trade(
            "4",
            "Q-MARGIN",
            "MSFT",
            "2026-07-01",
            "USD",
            "SELL",
            "5",
            "900",
        ),
    ]));
    assert!(report.get("error").is_none(), "{report}");
    let year = &report["years"][0];
    assert_eq!(year["year"], 2026);
    assert_eq!(year["gains"], "278.62");
    assert_eq!(year["losses"], "142.10");
    assert_eq!(year["net"], "136.52");
    assert_eq!(year["taxable"], "68.26");
    let sales = report["dispositions"].as_array().expect("sales");
    assert_eq!(sales.len(), 2);
    assert_eq!(sales[1]["securityId"], "AAPL");
    assert_eq!(sales[1]["proceeds"], "3119.82");
    assert_eq!(sales[1]["acb"], "2841.20");
    let fallback = &report["fxFallbacks"][0];
    assert_eq!(fallback["activityId"], "4");
    assert_eq!(fallback["rateDate"], "2026-06-30");
    assert_eq!(report["holdings"].as_array().map(Vec::len), Some(0));
}

#[test]
fn superficial_loss_is_denied_and_added_to_the_new_shares() {
    let report = run(base(vec![
        trade(
            "1",
            "Q-MARGIN",
            "XYZ",
            "2026-03-02",
            "CAD",
            "BUY",
            "10",
            "1000",
        ),
        trade(
            "2",
            "Q-MARGIN",
            "XYZ",
            "2026-03-10",
            "CAD",
            "SELL",
            "10",
            "800",
        ),
        trade(
            "3",
            "Q-MARGIN",
            "XYZ",
            "2026-03-20",
            "CAD",
            "BUY",
            "10",
            "820",
        ),
    ]));
    let sale = &report["dispositions"][0];
    assert_eq!(sale["gain"], "0.00");
    assert_eq!(sale["deniedLoss"], "200.00");
    assert_eq!(report["years"][0]["deniedLosses"], "200.00");
    assert_eq!(report["years"][0]["net"], "0.00");
    let holding = &report["holdings"][0];
    assert_eq!(holding["units"], "10");
    assert_eq!(holding["acb"], "1020.00");
}

#[test]
fn a_tfsa_rebuy_also_denies_the_loss() {
    let report = run(base(vec![
        trade(
            "1",
            "Q-MARGIN",
            "XYZ",
            "2026-03-02",
            "CAD",
            "BUY",
            "10",
            "1000",
        ),
        trade(
            "2",
            "Q-MARGIN",
            "XYZ",
            "2026-03-10",
            "CAD",
            "SELL",
            "10",
            "800",
        ),
        trade(
            "3",
            "Q-TFSA",
            "XYZ",
            "2026-03-20",
            "CAD",
            "BUY",
            "10",
            "820",
        ),
    ]));
    let sale = &report["dispositions"][0];
    assert_eq!(sale["deniedLoss"], "200.00");
    // Shares kept in the TFSA: the denied loss is gone, nothing is held outside.
    assert_eq!(report["holdings"].as_array().map(Vec::len), Some(0));
}

#[test]
fn unknown_accounts_and_missing_rates_are_reported_not_guessed() {
    let report = run(base(vec![
        trade(
            "1",
            "UNKNOWN",
            "SHOP",
            "2026-02-02",
            "CAD",
            "BUY",
            "1",
            "100",
        ),
        trade(
            "2",
            "Q-MARGIN",
            "SAP",
            "2026-02-02",
            "EUR",
            "BUY",
            "1",
            "100",
        ),
        trade(
            "3",
            "Q-MARGIN",
            "SAP",
            "2026-02-09",
            "EUR",
            "SELL",
            "1",
            "120",
        ),
    ]));
    let reasons: Vec<&str> = report["issues"]
        .as_array()
        .expect("issues")
        .iter()
        .filter_map(|i| i["reason"].as_str())
        .collect();
    assert!(reasons.contains(&"UNCLASSIFIED_ACCOUNT"), "{report}");
    assert!(reasons.contains(&"MISSING_FX_RATE"), "{report}");
    assert_eq!(report["dispositions"].as_array().map(Vec::len), Some(0));
}

#[test]
fn an_unreadable_request_answers_with_an_error() {
    let report = run(json!({ "asOf": "not a date" }));
    assert!(report["error"]
        .as_str()
        .is_some_and(|e| e.contains("cannot be read")));
}
