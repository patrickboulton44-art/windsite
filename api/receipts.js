// "Show the receipts" — every switch-off payment to a wind farm for a given
// day, straight from Elexon's settlement stacks, grouped by farm. Powers
// /receipts.html. Same counting rules as api/wasted.js: wind units only,
// system-operator-flagged (grid constraint) turn-downs only.

var history = require('../data/wasted-daily.json');

var BASE = 'https://data.elexon.co.uk/bmrs/api/v1';

// warm-instance caches
var windCache = null;          // Map: unit id -> unit name
var dayCache = {};             // date -> { at: ms, payload }

async function getJson(url) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var r = await fetch(url);
      if (r.ok) {
        var j = await r.json();
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

var FUEL_LABELS = {
  CCGT: 'gas', OCGT: 'gas peaker', COAL: 'coal', BIOMASS: 'biomass',
  NUCLEAR: 'nuclear', NPSHYD: 'hydro', PS: 'pumped storage', WIND: 'wind', OTHER: 'other'
};

async function allUnits() {
  if (windCache) return windCache;
  var all = await getJson(BASE + '/reference/bmunits/all');
  windCache = new Map(all
    .filter(function (u) { return u.elexonBmUnit; })
    .map(function (u) {
      return [u.elexonBmUnit, {
        name: u.bmUnitName || u.elexonBmUnit,
        fuelType: u.fuelType || null
      }];
    }));
  return windCache;
}

// "London Array BMU4" / "Greater Gabbard Module 3" -> "London Array",
// so a farm's separate grid units roll up into one human line.
function farmName(unitName) {
  return unitName
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s*[-–]?\s*(BMU|Module|Mod|Unit|Phase|Windfarm|Wind Farm|WF|OWF)\s*\d*\s*$/i, '')
    .replace(/\s*[-–]\s*\d+\s*$/, '')
    .trim() || unitName;
}

function londonToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

async function dayReceipts(date) {
  var units = await allUnits();
  var urls = [];
  ['bid', 'offer'].forEach(function (k) {
    for (var p = 1; p <= 50; p++) urls.push(BASE + '/balancing/settlement/stack/all/' + k + '/' + date + '/' + p);
  });
  var res = await pool(urls, 25, getJson);
  var bidsByPeriod = res.slice(0, 50);
  var offersByPeriod = res.slice(50);

  // --- the wind farms paid to switch off ---
  var farms = {}; // name -> { name, units:Set, cost, mwh, periods:Set }
  var paymentCount = 0;
  var perPeriodNeed = {}; // curtailed volume per half-hour, for the replacement walk
  bidsByPeriod.forEach(function (rows, idx) {
    rows.forEach(function (e) {
      var u = units.get(e.id);
      if (!u || u.fuelType !== 'WIND' || !e.soFlag) return;
      paymentCount++;
      var name = farmName(u.name);
      var f = farms[name] || (farms[name] = { name: name, units: {}, cost: 0, mwh: 0, periods: {} });
      f.units[e.id] = true;
      f.cost += e.originalPrice * e.volume;
      f.mwh += Math.abs(e.volume);
      f.periods[idx + 1] = true;
      perPeriodNeed[idx + 1] = (perPeriodNeed[idx + 1] || 0) + Math.abs(e.volume);
    });
  });

  // --- the generators paid to fill the gap ---
  // The ledger doesn't tag which purchase replaced which wind farm, so we
  // pair them the standard way: same half-hour, cheapest accepted offers
  // first (short-spike CADL acceptances excluded) — the same walk that
  // produces the replacement totals in api/wasted.js and the data file.
  var gap = {}; // name|fuel -> { name, fuel, units:Set, cost, mwh, periods:Set }
  var replaceCost = 0;
  Object.keys(perPeriodNeed).forEach(function (p) {
    var need = perPeriodNeed[p];
    var acc = 0;
    var stack = (offersByPeriod[p - 1] || [])
      .filter(function (e) { return !e.cadlFlag; })
      .sort(function (a, b) {
        if (!a.soFlag !== !b.soFlag) return a.soFlag ? 1 : -1;
        return (a.sequenceNumber || 0) - (b.sequenceNumber || 0);
      });
    for (var i = 0; i < stack.length; i++) {
      var e = stack[i];
      var vol = e.volume;
      if (acc + vol > need) vol = vol * Math.min(Math.max((need - acc) / e.volume, 0), 1);
      acc += vol;
      var cost = e.originalPrice * vol;
      replaceCost += cost;
      var u = units.get(e.id) || { name: e.id, fuelType: null };
      var fuel = FUEL_LABELS[u.fuelType] || 'other';
      var key = farmName(u.name) + '|' + fuel;
      var g = gap[key] || (gap[key] = { name: farmName(u.name), fuel: fuel, units: {}, cost: 0, mwh: 0, periods: {} });
      g.units[e.id] = true;
      g.cost += cost;
      g.mwh += vol;
      g.periods[p] = true;
      if (acc >= need) break;
    }
  });

  function finish(obj, extra) {
    return Object.values(obj).map(function (f) {
      var row = {
        name: f.name,
        units: Object.keys(f.units).sort(),
        cost: Math.round(f.cost * 100) / 100,
        mwh: Math.round(f.mwh * 100) / 100,
        periods: Object.keys(f.periods).map(Number).sort(function (a, b) { return a - b; })
      };
      if (extra) row.fuel = f.fuel;
      return row;
    }).sort(function (a, b) { return b.cost - a.cost; });
  }
  var list = finish(farms, false);
  var gapList = finish(gap, true);

  var worst = history.reduce(function (best, r) {
    var t = r.switchOffCost + r.replaceCost;
    return (!best || t > best.total) ? { date: r.date, total: Math.round(t) } : best;
  }, null);

  return {
    date: date,
    isToday: date === londonToday(),
    paymentCount: paymentCount,
    farmCount: list.length,
    switchOffCost: Math.round(list.reduce(function (s, f) { return s + f.cost; }, 0) * 100) / 100,
    curtailedMWh: Math.round(list.reduce(function (s, f) { return s + f.mwh; }, 0) * 100) / 100,
    replaceCost: Math.round(replaceCost * 100) / 100,
    farms: list,
    replacements: gapList,
    worstDay: worst,
    source: 'Elexon Insights API (data.elexon.co.uk)'
  };
}

module.exports = async function handler(req, res) {
  try {
    var today = londonToday();
    var date = (req.query && req.query.date) || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '2026-01-01' || date > today) {
      return res.status(400).json({ ok: false, error: 'date must be between 2026-01-01 and today' });
    }
    var ttl = date === today ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
    var hit = dayCache[date];
    var payload = (hit && Date.now() - hit.at < ttl) ? hit.payload : await dayReceipts(date);
    dayCache[date] = { at: Date.now(), payload: payload };

    res.setHeader('Cache-Control', date === today
      ? 'public, s-maxage=900, stale-while-revalidate=3600'
      : 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('receipts failed:', err);
    return res.status(500).json({ ok: false });
  }
};
