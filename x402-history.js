// x402-history.js v1.0.0 - append-only time series of the live x402 ecosystem.
// The index tells you what exists NOW. History tells you what CHANGED, which is the
// thing no directory publishes: new services, vanished services, verdict drift.
// Zero deps. Append-only JSONL = audit-friendly and restart-safe.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'x402-history.jsonl');
const MAX_ENTRIES = 4000;

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* skip torn line */ }
  }
  return out;
}

// A compact, comparable row per service. Keeps the file small enough to grow for years.
function rows(entries) {
  return (entries || [])
    .filter(e => e && e.url && !String(e.url).startsWith('seed:'))
    .map(e => ({
      url: e.url,
      verdict: e.verdict || 'UNKNOWN',
      score: typeof e.score === 'number' ? e.score : null,
      dialect: e.dialect || null,
      status: typeof e.status === 'number' ? e.status : null
    }));
}

function stamp(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  return t.toISOString().slice(0, 10);
}

// Snapshot = a dated row set. Deterministic: derived only from the live scan.
function snapshot(entries, when) {
  const r = rows(entries);
  const tally = {};
  for (const x of r) tally[x.verdict] = (tally[x.verdict] || 0) + 1;
  const healthy = r.filter(x => x.verdict === 'CONFORMANT').length;
  return {
    ts: new Date(when || Date.now()).toISOString(),
    day: stamp(when),
    total: r.length,
    conformant: healthy,
    healthPct: r.length ? Math.round((healthy / r.length) * 1000) / 10 : 0,
    tally,
    rows: r
  };
}

function append(snap) {
  fs.appendFileSync(FILE, JSON.stringify(snap) + '\n');
  // Keep the file bounded: rewrite if it grew past MAX_ENTRIES (rare, cheap).
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
  if (lines.length > MAX_ENTRIES) {
    fs.writeFileSync(FILE, lines.slice(-MAX_ENTRIES).join('\n') + '\n');
  }
  return snap;
}

function series(limit) {
  const all = readAll();
  return all.slice(-(limit || 30));
}

function latest() {
  const all = readAll();
  return all.length ? all[all.length - 1] : null;
}

// Deltas between the two most recent DISTINCT days. Same-day rescans do not fake a delta.
function deltas(snaps) {
  const s = (snaps || series(60)).filter(x => x && x.rows);
  if (s.length < 2) return null;
  const prev = s[s.length - 2], cur = s[s.length - 1];
  if (prev.day === cur.day) {
    // find the last entry from a different day
    let i = s.length - 2;
    while (i >= 0 && s[i].day === cur.day) i--;
    if (i < 0) return null;
    return diff(s[i], cur);
  }
  return diff(prev, cur);
}

function diff(prev, cur) {
  const p = new Map(prev.rows.map(r => [r.url, r]));
  const c = new Map(cur.rows.map(r => [r.url, r]));
  const added = [], removed = [], changed = [];
  for (const [url, r] of c) if (!p.has(url)) added.push(url);
  for (const [url, r] of p) if (!c.has(url)) removed.push(url);
  for (const [url, r] of c) {
    const o = p.get(url);
    if (!o) continue;
    if (o.verdict !== r.verdict || o.score !== r.score) {
      changed.push({ url, from: o.verdict, to: r.verdict, fromScore: o.score, toScore: r.score });
    }
  }
  return {
    fromDay: prev.day, toDay: cur.day,
    fromTotal: prev.total, toTotal: cur.total,
    fromHealthPct: prev.healthPct, toHealthPct: cur.healthPct,
    added, removed, changed
  };
}

// Human-readable markdown digest - the form that is actually useful to a reader.
function report() {
  const all = series(4000);
  if (!all.length) return '# x402 Ecosystem History\n\nNo snapshots recorded yet.\n';
  const d = deltas(all);
  const first = all[0], last = all[all.length - 1];
  const L = [];
  L.push('# x402 Ecosystem History');
  L.push('');
  L.push('Observed span: **' + first.day + ' -> ' + last.day + '** (' + all.length + ' snapshot(s))');
  L.push('');
  L.push('| day | total | conformant | health |');
  L.push('|-----|-------|------------|--------|');
  for (const s of all.slice(-30)) L.push('| ' + s.day + ' | ' + s.total + ' | ' + s.conformant + ' | ' + s.healthPct + '% |');
  L.push('');
  if (d) {
    L.push('## Change: ' + d.fromDay + ' -> ' + d.toDay);
    L.push('');
    L.push('- services: ' + d.fromTotal + ' -> ' + d.toTotal);
    L.push('- health: ' + d.fromHealthPct + '% -> ' + d.toHealthPct + '%');
    L.push('- added: ' + d.added.length + (d.added.length ? ' (' + d.added.join(', ') + ')' : ''));
    L.push('- removed: ' + d.removed.length + (d.removed.length ? ' (' + d.removed.join(', ') + ')' : ''));
    if (d.changed.length) {
      L.push('- verdict drift:');
      for (const ch of d.changed) L.push('  - ' + ch.url + ': ' + ch.from + ' -> ' + ch.to);
    } else {
      L.push('- verdict drift: none');
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

module.exports = { FILE, snapshot, append, series, latest, deltas, diff, report, rows, stamp };
