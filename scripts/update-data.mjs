// Daily updater for data/wasted-daily.json.
// Pulls Britain's wind-curtailment record straight from Elexon (the official
// electricity market settlement body) — no API key needed.
//
// What counts as "wasted" for a given day:
//   switchOffCost — payments to wind farms for system-operator-flagged
//                   turn-down acceptances (the grid couldn't carry the power)
//   replaceCost   — the cost of the replacement energy bought in the same
//                   half-hour, walked cheapest-first up the accepted offer
//                   stack (short-spike CADL acceptances excluded)
//   curtailedMWh  — the wind energy thrown away
//
// Re-fetches the last REFRESH_DAYS days each run because Elexon revises
// recent settlement data.

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://data.elexon.co.uk/bmrs/api/v1';
const OUT = path.join(process.cwd(), 'data', 'wasted-daily.json');
const FROM = '2026-01-01';
const REFRESH_DAYS = 7;

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        // stack endpoints wrap rows in {data: []}; reference endpoints return a bare array
        return Array.isArray(j) ? j : (j.data || []);
      }
    } catch (e) { /* retry */ }
    await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
  }
  return [];
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function windUnits() {
  const all = await getJson(`${BASE}/reference/bmunits/all`);
  return new Set(all.filter(u => u.fuelType === 'WIND' && u.elexonBmUnit)
                    .map(u => u.elexonBmUnit));
}

async function dayTotals(date, wind) {
  const urls = [];
  for (const k of ['bid', 'offer'])
    for (let p = 1; p <= 50; p++)
      urls.push(`${BASE}/balancing/settlement/stack/all/${k}/${date}/${p}`);
  const res = await pool(urls, 20, getJson);
  const bids = res.slice(0, 50).flat();
  const offers = res.slice(50).flat();

  const wb = bids.filter(e => wind.has(e.id) && e.soFlag);
  const curtailedMWh = Math.abs(wb.reduce((s, e) => s + e.volume, 0));
  const switchOffCost = wb.reduce((s, e) => s + e.originalPrice * e.volume, 0);

  const perPeriod = {};
  for (const e of wb) perPeriod[e.settlementPeriod] = (perPeriod[e.settlementPeriod] || 0) + e.volume;
  const ok = offers.filter(e => !e.cadlFlag);
  let replaceCost = 0;
  for (const [p, v] of Object.entries(perPeriod)) {
    const need = Math.abs(v);
    let acc = 0, cost = 0;
    const stack = ok.filter(e => String(e.settlementPeriod) === String(p))
      .sort((a, b) => (a.soFlag === b.soFlag)
        ? (a.sequenceNumber || 0) - (b.sequenceNumber || 0)
        : (a.soFlag ? 1 : -1));
    for (const e of stack) {
      if (acc + e.volume > need) {
        const frac = Math.min(Math.max((need - acc) / e.volume, 0), 1);
        acc += e.volume * frac; cost += e.originalPrice * e.volume * frac;
      } else {
        acc += e.volume; cost += e.originalPrice * e.volume;
      }
      if (acc >= need) break;
    }
    replaceCost += cost;
  }
  const r2 = n => Math.round(n * 100) / 100;
  return { date, curtailedMWh: r2(curtailedMWh), switchOffCost: r2(switchOffCost), replaceCost: r2(replaceCost) };
}

function isoDaysFromTo(fromISO, toISO) {
  const days = [];
  let t = Date.parse(fromISO + 'T12:00:00Z');
  const end = Date.parse(toISO + 'T12:00:00Z');
  while (t <= end) { days.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; }
  return days;
}

const todayLondon = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
// only fully-settled days go in the file: stop at yesterday
const yesterday = new Date(Date.parse(todayLondon + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);

const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const map = new Map(existing.map(r => [r.date, r]));

const all = isoDaysFromTo(FROM, yesterday);
const cutoff = new Date(Date.parse(yesterday + 'T12:00:00Z') - REFRESH_DAYS * 86400000).toISOString().slice(0, 10);
const todo = all.filter(d => !map.has(d) || d >= cutoff);

if (todo.length === 0) {
  console.log('nothing to update');
  process.exit(0);
}
console.log(`updating ${todo.length} day(s): ${todo[0]} … ${todo[todo.length - 1]}`);

const wind = await windUnits();
console.log(`${wind.size} wind units on Elexon's register`);
for (const d of todo) {
  const row = await dayTotals(d, wind);
  map.set(d, row);
  console.log(`${d}: ${row.curtailedMWh.toLocaleString()} MWh  off £${Math.round(row.switchOffCost).toLocaleString()}  replace £${Math.round(row.replaceCost).toLocaleString()}`);
}

const rows = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`wrote ${rows.length} days to ${OUT}`);
