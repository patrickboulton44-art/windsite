// Real "wasted wind" totals for the page.
// History (settled days) comes from data/wasted-daily.json, which a daily
// GitHub Action keeps up to date from Elexon — the official body that
// settles Britain's electricity market. Today's partial figure is computed
// live from Elexon here, and the whole answer is cached for 15 minutes.
//
// Response: { asOf, week: {start,total,...}, year: {total,...}, ratePerSec }

var history = require('../data/wasted-daily.json');

var BASE = 'https://data.elexon.co.uk/bmrs/api/v1';

// warm-instance caches
var windCache = null;
var liveCache = {}; // date -> { at: ms, row }

async function getJson(url) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var r = await fetch(url);
      if (r.ok) {
        var j = await r.json();
        // stack endpoints wrap rows in {data: []}; reference endpoints return a bare array
        return Array.isArray(j) ? j : (j.data || []);
      }
    } catch (e) { /* retry */ }
    await new Promise(function (s) { setTimeout(s, 500 * (attempt + 1)); });
  }
  return [];
}

async function pool(items, n, fn) {
  var out = new Array(items.length);
  var i = 0;
  await Promise.all(Array.from({ length: n }, async function () {
    while (i < items.length) { var k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function windUnits() {
  if (windCache) return windCache;
  var all = await getJson(BASE + '/reference/bmunits/all');
  windCache = new Set(all.filter(function (u) { return u.fuelType === 'WIND' && u.elexonBmUnit; })
                         .map(function (u) { return u.elexonBmUnit; }));
  return windCache;
}

// Same sums as scripts/update-data.mjs — SO-flagged wind turn-downs plus
// the replacement energy bought in the same half-hour.
async function dayTotals(date) {
  var wind = await windUnits();
  var urls = [];
  ['bid', 'offer'].forEach(function (k) {
    for (var p = 1; p <= 50; p++) urls.push(BASE + '/balancing/settlement/stack/all/' + k + '/' + date + '/' + p);
  });
  var res = await pool(urls, 25, getJson);
  var bids = res.slice(0, 50).flat();
  var offers = res.slice(50).flat();

  var wb = bids.filter(function (e) { return wind.has(e.id) && e.soFlag; });
  var curtailedMWh = Math.abs(wb.reduce(function (s, e) { return s + e.volume; }, 0));
  var switchOffCost = wb.reduce(function (s, e) { return s + e.originalPrice * e.volume; }, 0);

  var perPeriod = {};
  wb.forEach(function (e) { perPeriod[e.settlementPeriod] = (perPeriod[e.settlementPeriod] || 0) + e.volume; });
  var ok = offers.filter(function (e) { return !e.cadlFlag; });
  var replaceCost = 0;
  Object.keys(perPeriod).forEach(function (p) {
    var need = Math.abs(perPeriod[p]);
    var acc = 0, cost = 0;
    var stack = ok.filter(function (e) { return String(e.settlementPeriod) === String(p); })
      .sort(function (a, b) {
        if (!a.soFlag !== !b.soFlag) return a.soFlag ? 1 : -1;
        return (a.sequenceNumber || 0) - (b.sequenceNumber || 0);
      });
    for (var i = 0; i < stack.length; i++) {
      var e = stack[i];
      if (acc + e.volume > need) {
        var frac = Math.min(Math.max((need - acc) / e.volume, 0), 1);
        acc += e.volume * frac; cost += e.originalPrice * e.volume * frac;
      } else {
        acc += e.volume; cost += e.originalPrice * e.volume;
      }
      if (acc >= need) break;
    }
    replaceCost += cost;
  });
  return { date: date, curtailedMWh: curtailedMWh, switchOffCost: switchOffCost, replaceCost: replaceCost };
}

async function dayTotalsCached(date, ttlMs) {
  var hit = liveCache[date];
  if (hit && Date.now() - hit.at < ttlMs) return hit.row;
  var row = await dayTotals(date);
  liveCache[date] = { at: Date.now(), row: row };
  return row;
}

function londonToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}
function londonSecondsToday() {
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  var v = {};
  parts.forEach(function (p) { v[p.type] = Number(p.value); });
  return (v.hour % 24) * 3600 + v.minute * 60 + v.second;
}
function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function mondayOf(iso) {
  var dow = new Date(Date.parse(iso + 'T12:00:00Z')).getUTCDay(); // Sun=0…Sat=6
  return addDays(iso, -((dow + 6) % 7));
}

module.exports = async function handler(req, res) {
  try {
    var map = new Map(history.map(function (r) { return [r.date, r]; }));
    var today = londonToday();
    var weekStart = mondayOf(today);
    var jan1 = today.slice(0, 4) + '-01-01';

    // Live-compute only the most recent missing days (normally just today,
    // plus yesterday if the morning data update hasn't landed yet).
    var missing = [];
    for (var d = jan1; d <= today; d = addDays(d, 1)) if (!map.has(d)) missing.push(d);
    var live = missing.slice(-2);
    for (var i = 0; i < live.length; i++) {
      // today keeps changing — cache it briefly; settled days cache longer
      var ttl = live[i] === today ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
      map.set(live[i], await dayTotalsCached(live[i], ttl));
    }

    function sumRange(fromISO) {
      var t = { total: 0, switchOff: 0, replace: 0, mwh: 0 };
      map.forEach(function (r) {
        if (r.date >= fromISO && r.date <= today) {
          t.switchOff += r.switchOffCost; t.replace += r.replaceCost; t.mwh += r.curtailedMWh;
        }
      });
      t.total = t.switchOff + t.replace;
      return t;
    }
    var week = sumRange(weekStart);
    var year = sumRange(jan1);

    // Recent pace for the live tick: yesterday + today spread over the
    // elapsed seconds. Never negative.
    var y = map.get(addDays(today, -1));
    var t0 = map.get(today);
    var recentCost = (y ? y.switchOffCost + y.replaceCost : 0) + (t0 ? t0.switchOffCost + t0.replaceCost : 0);
    var recentSecs = (y ? 86400 : 0) + Math.max(londonSecondsToday(), 1);
    var ratePerSec = Math.max(recentCost / recentSecs, 0);

    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json({
      asOf: new Date().toISOString(),
      week: { start: weekStart, total: week.total, switchOff: week.switchOff, replace: week.replace, mwh: week.mwh },
      year: { total: year.total, switchOff: year.switchOff, replace: year.replace, mwh: year.mwh },
      ratePerSec: ratePerSec,
      source: 'Elexon Insights API (data.elexon.co.uk)'
    });
  } catch (err) {
    console.error('wasted totals failed:', err);
    return res.status(500).json({ ok: false });
  }
};
