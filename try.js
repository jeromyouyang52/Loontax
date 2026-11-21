(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var REG = [
    ['', '请选择'], ['NON_REGISTERED', '非注册（Margin / Cash）'], ['TFSA', 'TFSA'], ['RRSP', 'RRSP'],
    ['SPOUSAL_RRSP', '配偶 RRSP'], ['FHSA', 'FHSA'], ['RESP', 'RESP'], ['LIRA', 'LIRA'], ['RRIF', 'RRIF']
  ];
  var state = { files: [], activities: [], accounts: {}, report: null, year: null };

  // ---------- CSV ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    var rows = [], row = [], field = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function num(v) {
    if (v == null) return NaN;
    var s = String(v).trim().replace(/[$,\s]/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    return s === '' ? NaN : Number(s);
  }
  function dec(n) { // a positive number as a decimal string the engine reads
    var s = Math.abs(n).toFixed(8).replace(/\.?0+$/, '');
    return s === '' ? '0' : s;
  }
  // Slash dates are M/D/Y or D/M/Y depending on the export's settings; each
  // file is read one way, decided from all its dates (see slashOrder).
  var slashOrder = 'MDY';
  function isoDate(v) {
    var s = String(v || '').trim();
    var m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?!\d)/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    if (/^\d{5}(\.\d+)?$/.test(s)) { // an Excel date serial (days since 1899-12-30)
      var d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 864e5);
      return d.toISOString().slice(0, 10);
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?!\d)/);
    if (m) {
      var y = m[3].length === 2 ? '20' + m[3] : m[3];
      var mo = slashOrder === 'DMY' ? m[2] : m[1], da = slashOrder === 'DMY' ? m[1] : m[2];
      if (Number(mo) > 12) { var t = mo; mo = da; da = t; }
      return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
    }
    return null;
  }
  // 'DMY' when some date's first number is over 12, 'MDY' when some second number is,
  // 'AMBIGUOUS' when slash dates exist but none tells, null when there are none.
  function slashOrderOf(rows) {
    var seen = false, dmy = false, mdy = false;
    rows.forEach(function (r) { r.forEach(function (c) {
      var m = String(c).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?!\d)/);
      if (!m) return; seen = true;
      if (Number(m[1]) > 12) dmy = true; if (Number(m[2]) > 12) mdy = true;
    }); });
    if (!seen) return null;
    return dmy && !mdy ? 'DMY' : mdy && !dmy ? 'MDY' : 'AMBIGUOUS';
  }
  function headerIndex(header) {
    var idx = {};
    header.forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
    return function (name) { var i = idx[name.toLowerCase()]; return i == null ? -1 : i; };
  }

  // ---------- Excel (.xlsx): unzip with the browser's own inflater, read sheet 1 ----------
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function unzip(buffer) {
    var b = new Uint8Array(buffer), end = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { end = i; break; }
    if (end < 0) return Promise.reject(new Error('不是 Excel 文件'));
    var count = u16(b, end + 10), p = u32(b, end + 16), entries = {};
    for (var n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) break;
      var method = u16(b, p + 10), size = u32(b, p + 20), nameLen = u16(b, p + 28), extra = u16(b, p + 30), comment = u16(b, p + 32), local = u32(b, p + 42);
      var name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, size: size, local: local };
      p += 46 + nameLen + extra + comment;
    }
    return function read(name) {
      var e = entries[name];
      if (!e) return Promise.resolve(null);
      var start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
      var data = b.subarray(start, start + e.size);
      if (e.method === 0) return Promise.resolve(new TextDecoder().decode(data));
      if (e.method !== 8 || typeof DecompressionStream === 'undefined') return Promise.reject(new Error('浏览器不支持解压'));
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    };
  }
  function readXlsx(buffer) {
    var read;
    try { read = unzip(buffer); } catch (e) { return Promise.reject(e); }
    if (typeof read !== 'function') return read;
    return Promise.all([read('xl/sharedStrings.xml'), read('xl/workbook.xml'), read('xl/_rels/workbook.xml.rels')]).then(function (parts) {
      var xml = function (t) { return new DOMParser().parseFromString(t, 'application/xml'); };
      var shared = parts[0] ? Array.prototype.map.call(xml(parts[0]).getElementsByTagName('si'), function (si) {
        return Array.prototype.map.call(si.getElementsByTagName('t'), function (t) { return t.textContent; }).join('');
      }) : [];
      var path = 'xl/worksheets/sheet1.xml';
      if (parts[1] && parts[2]) {
        var first = xml(parts[1]).getElementsByTagName('sheet')[0];
        var rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
        Array.prototype.forEach.call(xml(parts[2]).getElementsByTagName('Relationship'), function (r) {
          if (r.getAttribute('Id') === rid) { var t = r.getAttribute('Target').replace(/^\//, ''); path = /^xl\//.test(t) ? t : 'xl/' + t; }
        });
      }
      return read(path).then(function (sheet) {
        if (!sheet) throw new Error('找不到工作表');
        var rows = [];
        Array.prototype.forEach.call(xml(sheet).getElementsByTagName('row'), function (row) {
          var out = [];
          Array.prototype.forEach.call(row.getElementsByTagName('c'), function (c) {
            var ref = (c.getAttribute('r') || '').replace(/\d+$/, ''), col = 0;
            for (var k = 0; k < ref.length; k++) col = col * 26 + ref.charCodeAt(k) - 64;
            var type = c.getAttribute('t'), v = c.getElementsByTagName('v')[0], value = '';
            if (type === 's') value = shared[Number(v && v.textContent)] || '';
            else if (type === 'inlineStr') value = Array.prototype.map.call(c.getElementsByTagName('t'), function (t) { return t.textContent; }).join('');
            else value = v ? v.textContent : '';
            out[(col || out.length + 1) - 1] = value;
          });
          for (var j = 0; j < out.length; j++) if (out[j] == null) out[j] = '';
          rows.push(out);
        });
        return rows;
      });
    });
  }

  // ---------- broker formats ----------
  function guessRegistration(text) {
    var t = String(text || '').toUpperCase();
    if (/FHSA/.test(t)) return 'FHSA';
    if (/TFSA/.test(t)) return 'TFSA';
    if (/SPOUSAL/.test(t) && /RSP/.test(t)) return 'SPOUSAL_RRSP';
    if (/RRIF|\bRIF\b/.test(t)) return 'RRIF';
    if (/RESP/.test(t)) return 'RESP';
    if (/LIRA/.test(t)) return 'LIRA';
    if (/RRSP|\bRSP\b/.test(t)) return 'RRSP';
    if (/MARGIN|CASH|INDIVIDUAL|JOINT|NON.?REG/.test(t)) return 'NON_REGISTERED';
    return '';
  }

  function fromQuestrade(rows, file) {
    var h = headerIndex(rows[0]), out = [], skipped = 0;
    var c = { date: h('Transaction Date'), action: h('Action'), sym: h('Symbol'), qty: h('Quantity'), price: h('Price'),
      net: h('Net Amount'), cur: h('Currency'), acct: h('Account #'), type: h('Account Type') };
    rows.slice(1).forEach(function (r) {
      var action = String(r[c.action] || '').trim().toUpperCase();
      var kind = action === 'BUY' || action === 'REI' ? 'BUY' : action === 'SELL' ? 'SELL' : null;
      var date = isoDate(r[c.date]), sym = String(r[c.sym] || '').trim().toUpperCase();
      var units = Math.abs(num(r[c.qty])), amount = Math.abs(num(r[c.net]));
      if (kind && (!amount || isNaN(amount))) amount = Math.abs(num(r[c.qty]) * num(r[c.price]));
      if (!kind || !date || !sym || !units || isNaN(amount) || !amount) { skipped++; return; }
      out.push({ date: date, account: 'Questrade ' + String(r[c.acct] || '').trim(), broker: 'Questrade',
        accountType: c.type >= 0 ? r[c.type] : '', symbol: sym, kind: kind, units: units, amount: amount,
        currency: String(r[c.cur] || 'CAD').trim().toUpperCase() });
    });
    // Questrade lists newest first: put the day's trades back in the order they happened.
    if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse();
    return { activities: out, skipped: skipped, format: 'Questrade' };
  }

  function fromIbkrFlex(rows) {
    var h = headerIndex(rows[0]), out = [], skipped = 0;
    var c = { date: h('TradeDate'), side: h('Buy/Sell'), sym: h('Symbol'), qty: h('Quantity'), net: h('NetCash'),
      cur: h('CurrencyPrimary'), acct: h('ClientAccountID'), cls: h('AssetClass') };
    rows.slice(1).forEach(function (r) {
      if (r[0] === 'HEADER' || r[0] === 'TRAILER' || String(r[c.date]) === 'TradeDate') return;
      var cls = c.cls >= 0 ? String(r[c.cls]).toUpperCase() : 'STK';
      var side = String(r[c.side] || '').toUpperCase(), kind = side.indexOf('BUY') === 0 ? 'BUY' : side.indexOf('SELL') === 0 ? 'SELL' : null;
      var date = isoDate(r[c.date]), sym = String(r[c.sym] || '').trim().toUpperCase();
      var units = Math.abs(num(r[c.qty])), amount = Math.abs(num(r[c.net]));
      if (!/^(STK|FUND|ETF)$/.test(cls) || !kind || !date || !sym || !units || !amount) { skipped++; return; }
      out.push({ date: date, account: 'IBKR ' + String(r[c.acct] || '').trim(), broker: 'Interactive Brokers', accountType: '',
        symbol: sym, kind: kind, units: units, amount: amount, currency: String(r[c.cur] || '').trim().toUpperCase() });
    });
    return { activities: out, skipped: skipped, format: 'IBKR Flex Query' };
  }

  function fromIbkrStatement(rows) {
    var out = [], skipped = 0, header = null, account = 'IBKR';
    rows.forEach(function (r) {
      if (r[0] === 'Account Information' && r[1] === 'Data' && /^Account$/i.test(r[2])) account = 'IBKR ' + String(r[3]).trim();
      if (r[0] !== 'Trades') return;
      if (r[1] === 'Header') { header = headerIndex(r); return; }
      if (r[1] !== 'Data' || !header) return;
      var g = function (n) { var i = header(n); return i < 0 ? '' : r[i]; };
      if (g('DataDiscriminator') && g('DataDiscriminator') !== 'Order') return;
      var cat = String(g('Asset Category'));
      var qty = num(g('Quantity')), proceeds = num(g('Proceeds')), comm = num(g('Comm/Fee')) || 0;
      var date = isoDate(g('Date/Time')), sym = String(g('Symbol') || '').trim().toUpperCase();
      if (!/Stocks/i.test(cat) || !date || !sym || !qty || isNaN(proceeds)) { skipped++; return; }
      var kind = qty > 0 ? 'BUY' : 'SELL';
      var amount = Math.abs(proceeds + comm); // commissions are negative: cost up, proceeds down
      out.push({ date: date, account: account, broker: 'Interactive Brokers', accountType: '', symbol: sym, kind: kind,
        units: Math.abs(qty), amount: amount, currency: String(g('Currency')).trim().toUpperCase() });
    });
    return { activities: out, skipped: skipped, format: 'IBKR Activity Statement' };
  }

  function fromGeneric(rows) {
    var h = headerIndex(rows[0]), out = [], skipped = 0;
    rows.slice(1).forEach(function (r) {
      var g = function (n) { var i = h(n); return i < 0 ? '' : r[i]; };
      var kind = String(g('action')).trim().toUpperCase(), date = isoDate(g('date')), sym = String(g('symbol')).trim().toUpperCase();
      var units = Math.abs(num(g('quantity'))), amount = Math.abs(num(g('amount')));
      if (!/^(BUY|SELL)$/.test(kind) || !date || !sym || !units || !amount) { skipped++; return; }
      out.push({ date: date, account: String(g('account')).trim() || '账户', broker: 'CSV', accountType: g('account_type'),
        symbol: sym, kind: kind, units: units, amount: amount, currency: (String(g('currency')).trim() || 'CAD').toUpperCase() });
    });
    return { activities: out, skipped: skipped, format: '通用格式' };
  }

  function readRows(name, rows) {
    rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) return { error: '文件是空的' };
    var order = slashOrderOf(rows);
    if (order === 'AMBIGUOUS') return { error: '日期写成了“几/几/年”，而且每个日期的日和月都不超过 12，分不清哪个是月。请把导出的日期格式改成 年-月-日 后再试。' };
    slashOrder = order || 'MDY';
    var result = readByFormat(name, rows);
    return result;
  }
  function readByFormat(name, rows) {
    if (rows.some(function (r) { return r[0] === 'Trades' && r[1] === 'Header'; })) return fromIbkrStatement(rows);
    var h = rows[0].map(function (x) { return String(x).trim().toLowerCase(); });
    var has = function (n) { return h.indexOf(n.toLowerCase()) >= 0; };
    if (has('Transaction Date') && has('Action') && has('Net Amount')) return fromQuestrade(rows, name);
    if (has('TradeDate') && (has('Buy/Sell') || has('NetCash'))) return fromIbkrFlex(rows);
    if (has('date') && has('symbol') && has('action') && has('amount')) return fromGeneric(rows);
    return { error: '认不出格式。支持 Questrade、IBKR（Activity Statement 或 Flex Query）和通用格式。' };
  }

  // ---------- files ----------
  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    Promise.all(files.map(function (f) {
      var isXlsx = /\.xlsx$/i.test(f.name || '');
      var read = isXlsx ? f.arrayBuffer().then(readXlsx) : f.text().then(parseCSV);
      return read.then(function (rows) { var r = readRows(f.name, rows); r.name = f.name; return r; })
        .catch(function (e) { return { name: f.name, error: isXlsx ? '这个 Excel 文件读不出来（' + (e && e.message || e) + '）。可以先另存为 CSV 再试。' : '文件读不出来。' }; });
    })).then(function (results) {
      state.files = state.files.concat(results);
      rebuild();
    });
  }
  function rebuild() {
    state.activities = [];
    var accounts = {};
    state.files.forEach(function (f, fi) {
      (f.activities || []).forEach(function (a, i) {
        a.order = fi * 1e6 + i;
        state.activities.push(a);
        var acc = accounts[a.account] || (accounts[a.account] = { broker: a.broker, count: 0, guess: guessRegistration(a.accountType) });
        acc.count++;
        if (!acc.guess) acc.guess = guessRegistration(a.accountType);
      });
    });
    Object.keys(accounts).forEach(function (k) {
      accounts[k].registration = state.accounts[k] ? state.accounts[k].registration : accounts[k].guess;
    });
    state.accounts = accounts;
    $('#file-list').innerHTML = state.files.map(function (f) {
      return '<div class="file ' + (f.error ? 'bad' : '') + '"><b>' + esc(f.name) + '</b><span>' +
        (f.error ? esc(f.error) : esc(f.format) + ' · 读到 ' + f.activities.length + ' 笔买卖' + (f.skipped ? '，跳过 ' + f.skipped + ' 行（分红、存取款、期权、外汇等，不影响股票和基金的 ACB）' : '')) +
        '</span></div>';
    }).join('');
    var keys = Object.keys(accounts);
    $('#step-accounts').hidden = !keys.length;
    $('#acct-table tbody').innerHTML = keys.map(function (k) {
      var a = accounts[k];
      return '<tr><td>' + esc(k) + '</td><td>' + esc(a.broker) + '</td><td>' + a.count + '</td><td><select data-acct="' + esc(k) + '">' +
        REG.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === a.registration ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select>' + (a.guess && a.guess === a.registration ? ' <span class="mute small">按导出文件推断，请确认</span>' : '') + '</td></tr>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('select[data-acct]'), function (s) {
      s.addEventListener('change', function () { state.accounts[s.getAttribute('data-acct')].registration = s.value; });
    });
  }

  // ---------- engine ----------
  var enginePromise = null;
  function engine() {
    if (!enginePromise) {
      enginePromise = fetch('/engine.wasm').then(function (r) {
        if (!r.ok) throw new Error('engine ' + r.status);
        return r.arrayBuffer();
      }).then(function (b) { return WebAssembly.instantiate(b, {}); }).then(function (m) { return m.instance.exports; });
    }
    return enginePromise;
  }
  function callEngine(ex, request) {
    var bytes = new TextEncoder().encode(JSON.stringify(request));
    var ptr = ex.alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    var out = ex.report(ptr, bytes.length);
    var len = new DataView(ex.memory.buffer).getUint32(out, true);
    var json = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, out + 4, len));
    ex.free(out, len + 4);
    return JSON.parse(json);
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function fetchRates(acts) {
    var byCur = {};
    acts.forEach(function (a) {
      if (a.currency === 'CAD') return;
      var r = byCur[a.currency] || (byCur[a.currency] = { min: a.date, max: a.date });
      if (a.date < r.min) r.min = a.date; if (a.date > r.max) r.max = a.date;
    });
    var rates = {}, failed = [];
    return Promise.all(Object.keys(byCur).map(function (cur) {
      var r = byCur[cur];
      var url = 'https://www.bankofcanada.ca/valet/observations/FX' + encodeURIComponent(cur) + 'CAD/json?start_date=' + addDays(r.min, -10) + '&end_date=' + r.max;
      return fetch(url).then(function (res) { if (!res.ok) throw 0; return res.text(); })
        .then(function (t) { rates[cur] = t; }).catch(function () { failed.push(cur); });
    })).then(function () { return { rates: rates, failed: failed }; });
  }

  function run() {
    var msg = $('#run-msg');
    var missing = Object.keys(state.accounts).filter(function (k) { return !state.accounts[k].registration; });
    if (missing.length) { msg.textContent = '还有 ' + missing.length + ' 个账户没选类型。'; return; }
    msg.textContent = '计算中…'; $('#run').disabled = true;
    var acts = state.activities.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order; });
    Promise.all([engine(), fetchRates(acts)]).then(function (res) {
      var ex = res[0], fx = res[1], accounts = {};
      Object.keys(state.accounts).forEach(function (k) { accounts[k] = { registration: state.accounts[k].registration }; });
      var request = {
        asOf: new Date().toISOString().slice(0, 10),
        accounts: accounts,
        rates: fx.rates,
        activities: acts.map(function (a, i) {
          var x = { id: String(i + 1), accountId: a.account, securityId: a.symbol, date: a.date, currency: a.currency, kind: a.kind, units: dec(a.units) };
          if (a.kind === 'BUY') x.cost = dec(a.amount); else x.netProceeds = dec(a.amount);
          return x;
        })
      };
      var report = callEngine(ex, request);
      if (report.error) throw new Error(report.error);
      report.ratesFailed = fx.failed;
      state.report = report;
      state.year = report.years.length ? report.years[report.years.length - 1].year : null;
      render();
      msg.textContent = '';
      $('#step-report').hidden = false;
      $('#step-report').scrollIntoView({ behavior: 'smooth' });
      log('/try/report');
    }).catch(function (e) {
      msg.textContent = '出错了：' + (e && e.message ? e.message : '请刷新后再试') + '。';
    }).then(function () { $('#run').disabled = false; });
  }

  // ---------- report ----------
  var money = function (s) { var n = Number(s); return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var REASON = {
    UNCLASSIFIED_ACCOUNT: function (d) { return '账户 ' + d + ' 没有选类型，这只证券没有计算。'; },
    MISSING_FX_RATE: function (d) { return '缺少汇率（' + d + '），这只证券没有计算。加拿大央行只提供部分币种，且从 2017 年起。'; },
    UNSUPPORTED_TRANSFER: function () { return '有转入或转出记录，需要手动补成本，暂未计算。'; },
    UNREADABLE_ACTIVITY: function () { return '有无法识别的记录，暂未计算。'; },
    CONFLICTING_SPLITS: function (d) { return '两个账户在 ' + d + ' 附近记录了不同的拆股比例。'; },
    INVALID_HISTORY: function (d) { return '交易记录对不上（' + d + '）。常见原因：缺少更早年份的买入记录。请把更早的交易也导出来。'; }
  };
  function render() {
    var r = state.report;
    $('#years').innerHTML = r.years.map(function (y) {
      return '<button type="button" role="tab" class="ytab' + (y.year === state.year ? ' on' : '') + '" data-y="' + y.year + '">' + y.year + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.ytab'), function (b) {
      b.addEventListener('click', function () { state.year = Number(b.getAttribute('data-y')); render(); });
    });
    var y = r.years.filter(function (x) { return x.year === state.year; })[0];
    $('#kpis').innerHTML = y ? [
      ['资本利得', money(y.gains), ''], ['可抵扣亏损', money(y.losses), ''], ['被拒亏损（superficial）', money(y.deniedLosses), 'warn'],
      ['净额', money(y.net), 'em'], ['应税部分（计入收入）', money(y.taxable), 'em']
    ].map(function (k) { return '<div class="kpi ' + k[2] + '"><small>' + k[0] + '</small><strong class="mono">' + k[1] + '</strong></div>'; }).join('')
      + (y.provisional ? '<p class="note-line">有卖出发生在最近 30 天内，superficial loss 还可能变化。</p>' : '')
      : '<p class="mute">没有可计算的卖出记录。</p>';
    var issues = r.issues.map(function (i) { return '<li><b>' + esc(i.securityId) + '</b>：' + esc((REASON[i.reason] || function () { return i.reason; })(i.detail)) + '</li>'; });
    if (r.ratesFailed && r.ratesFailed.length) issues.unshift('<li>没能取到 ' + esc(r.ratesFailed.join(', ')) + ' 的央行汇率，相关证券没有计算。请检查网络后重试。</li>');
    $('#issues').innerHTML = issues.length ? '<div class="glass panel issues"><h3>有 ' + issues.length + ' 处需要你处理</h3><ul>' + issues.join('') + '</ul></div>' : '';
    var sales = r.dispositions.filter(function (s) { return Number(s.date.slice(0, 4)) === state.year; });
    $('#sales tbody').innerHTML = sales.map(function (s) {
      var notes = [];
      if (Number(s.deniedLoss) > 0) notes.push('superficial loss：' + money(s.deniedLoss) + ' 不可抵扣');
      if (s.provisional) notes.push('30 天未满');
      if (s.needsReview) notes.push('需复核');
      return '<tr><td>' + s.date + '</td><td>' + esc(s.securityId) + '</td><td class="num mono">' + esc(s.units) + '</td><td class="num mono">' + money(s.proceeds) +
        '</td><td class="num mono">' + money(s.acb) + '</td><td class="num mono ' + (Number(s.gain) < 0 ? 'neg' : 'pos') + '">' + money(s.gain) + '</td><td class="small">' + esc(notes.join('；')) + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="mute">这一年没有卖出。</td></tr>';
    $('#holdings tbody').innerHTML = r.holdings.map(function (h) {
      return '<tr><td>' + esc(h.securityId) + '</td><td class="num mono">' + esc(h.units) + '</td><td class="num mono">' + money(h.acb) + '</td><td class="num mono">' + (h.acbPerUnit ? '$' + Number(h.acbPerUnit).toFixed(4) : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="mute">没有。</td></tr>';
    $('#fx-notes').innerHTML = r.fxFallbacks.length ? '有 ' + r.fxFallbacks.length + ' 笔交易当天央行没有公布汇率（周末或假日），按之前最近一个工作日的汇率换算。' : '';
  }
  function downloadCSV() {
    var r = state.report; if (!r) return;
    var lines = [['date', 'security', 'units', 'proceeds_cad', 'acb_cad', 'outlays_cad', 'gain_cad', 'denied_superficial_loss_cad', 'notes']];
    r.dispositions.filter(function (s) { return Number(s.date.slice(0, 4)) === state.year; }).forEach(function (s) {
      lines.push([s.date, s.securityId, s.units, s.proceeds, s.acb, '0.00', s.gain, s.deniedLoss, [s.provisional ? 'provisional' : '', s.needsReview ? 'needs review' : ''].filter(Boolean).join('; ')]);
    });
    var csv = lines.map(function (l) { return l.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'loontax-schedule3-' + state.year + '.csv';
    a.click();
  }

  // ---------- usage counter (no cookies, no data) ----------
  function log(path) {
    if (!/(^|\.)loontax\.vercel\.app$/.test(location.hostname)) return;
    try {
      var q = new URLSearchParams(location.search);
      fetch('https://bmvoqeriqhcaxweuqjdz.supabase.co/rest/v1/visits', { method: 'POST', keepalive: true,
        headers: { apikey: 'sb_publishable_qDk-n67dGD4P5DmA4yQZ2g_653PbTlw', 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ path: path, src: (q.get('src') || '').slice(0, 64) || null, lang: 'zh', ref_host: null }) }).catch(function () {});
    } catch (_) {}
  }

  // ---------- wiring ----------
  $('#files').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });
  var drop = $('#drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
  $('#run').addEventListener('click', run);
  $('#dl-csv').addEventListener('click', downloadCSV);
  $('#sample').addEventListener('click', function (e) {
    e.preventDefault();
    var csv = 'date,account,account_type,symbol,action,quantity,amount,currency\n2026-01-15,My Margin,margin,XEQT,BUY,100,3210.95,CAD\n2026-03-02,My Margin,margin,AAPL,BUY,10,2004.95,USD\n2026-09-18,My Margin,margin,AAPL,SELL,10,2395.05,USD\n';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'loontax-sample.csv'; a.click();
  });
  engine().catch(function () {}); // start loading early
  log('/try');
})();
