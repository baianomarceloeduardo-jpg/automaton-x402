// index-populate.js — brings the public x402 leaderboard back to life.
// DEFECT: GET /v1/index returned entries=0, so the "any service can add itself for free and
// appear on an objective public leaderboard" growth loop distributed NOTHING.
//
// This script:
//   1. Discovers the index engine's real export shape (tolerant — no guessing).
//   2. Builds a candidate URL list from (a) any SEED list in the engine, (b) the public MCP
//      registry read API (unauthenticated), (c) my own service.
//   3. Runs real conformance against each candidate and persists scored results.
//   4. Verifies /v1/index now returns N>0 with real scores; writes evidence.
//
// Zero dependencies. Idempotent. Safe to re-run.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function req(url, opts = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: 'bad_url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { method: opts.method || 'GET', timeout: 20000, headers: Object.assign({ accept: 'application/json', 'user-agent': 'automaton-index/1.1' }, opts.headers || {}) }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.end();
  });
}
const j = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

// ---------- 1. discover the engine ----------
function loadEngine() {
  const cands = ['x402-index.js', 'x402-index.bak.js', 'index-engine.js'];
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    try {
      const m = require(path.resolve(f));
      return { file: f, mod: m, keys: Object.keys(m || {}) };
    } catch (e) { /* try next */ }
  }
  return null;
}

// ---------- 2. candidate sources ----------
function seedFromEngine(mod) {
  const out = [];
  const seen = new Set();
  const push = (v) => { if (typeof v === 'string' && /^https?:\/\//.test(v) && !seen.has(v)) { seen.add(v); out.push(v); } };
  const walk = (o, depth) => {
    if (!o || depth > 4) return;
    if (Array.isArray(o)) return o.forEach(x => walk(x, depth + 1));
    if (typeof o === 'string') return push(o);
    if (typeof o === 'object') return Object.values(o).forEach(x => walk(x, depth + 1));
  };
  // only look at obviously seed-ish exports, never functions
  for (const k of Object.keys(mod || {})) {
    if (/seed|curated|default|list|services/i.test(k)) walk(mod[k], 0);
  }
  return out;
}

async function fromRegistry() {
  const out = [];
  for (const q of ['x402', 'payment', 'usdc']) {
    const r = await req('https://registry.modelcontextprotocol.io/v0/servers?search=' + encodeURIComponent(q) + '&limit=50');
    const d = j(r.body);
    const arr = (d && (d.servers || d.data || d.items)) || [];
    for (const s of (Array.isArray(arr) ? arr : [])) {
      const home = (s && (s.homepage || s.repository || (s.server && s.server.homepage))) || '';
      const url = (s && (s.url || (s.server && s.server.url))) || home;
      if (typeof url === 'string' && /^https?:\/\//.test(url)) out.push(url.replace(/\/+$/, ''));
    }
  }
  return out;
}

(async () => {
  const base = fs.existsSync('tunnel.url') ? fs.readFileSync('tunnel.url', 'utf8').trim().replace(/\/+$/, '') : '';
  const ev = { at: new Date().toISOString(), base, engine: null, candidates: 0, scored: 0, entriesBefore: 0, entriesAfter: 0, detail: [] };

  const eng = loadEngine();
  ev.engine = eng ? { file: eng.file, keys: eng.keys } : null;
  console.log('engine: ' + (eng ? eng.file + '  exports=[' + eng.keys.join(',') + ']' : 'NONE FOUND'));

  // entries before
  if (base) {
    const before = await req(base + '/v1/index');
    const d = j(before.body);
    ev.entriesBefore = (d && (d.count || (d.services && d.services.length) || (Array.isArray(d) && d.length))) || 0;
  }
  console.log('entries before: ' + ev.entriesBefore);

  // build candidate list
  const set = new Set();
  if (eng) seedFromEngine(eng.mod).forEach(u => set.add(u));
  const reg = await fromRegistry();
  reg.forEach(u => set.add(u));
  if (base) { set.add(base + '/v1/uuid'); set.add(base); }
  const candidates = Array.from(set).filter(u => !/facebook|twitter|reddit|github\.com\/[^/]+\/[^/]+$/i.test(u)).slice(0, 60);
  ev.candidates = candidates.length;
  console.log('candidates: ' + candidates.length);

  // ---------- 3. score with the engine ----------
  // Prefer an exported batch builder; fall back to conformance module directly.
  let engineRun = null;
  if (eng && eng.mod) {
    for (const name of ['runPass', 'run', 'benchmark', 'build', 'update', 'scan']) {
      if (typeof eng.mod[name] === 'function') { engineRun = { name, fn: eng.mod[name] }; break; }
    }
  }
  let conf = null;
  try { conf = require(path.resolve('x402-conformance.js')); } catch (e) { try { conf = require(path.resolve('x402-conformance')); } catch (e2) {} }
  const confRun = conf && typeof conf.run === 'function' ? conf.run : null;

  if (engineRun && engineRun.name === 'runPass') {
    try {
      const r = await engineRun.fn(candidates.slice(0, 40));
      console.log('engine.runPass -> ' + JSON.stringify(r).slice(0, 300));
    } catch (e) { console.log('runPass failed: ' + e.message); }
  } else if (confRun) {
    // direct scoring path
    const scored = [];
    for (const u of candidates.slice(0, 40)) {
      try {
        const v = await confRun(u);
        if (v && typeof v.passed === 'number') {
          scored.push({ url: u, verdict: v.verdict, passed: v.passed, total: v.total, score: Math.round((v.passed / Math.max(1, v.total)) * 100) });
          ev.detail.push({ url: u, verdict: v.verdict, passed: v.passed, total: v.total });
        } else {
          ev.detail.push({ url: u, verdict: 'unreachable' });
        }
      } catch (e) { ev.detail.push({ url: u, error: e.message }); }
      await new Promise(r => setTimeout(r, 120));
    }
    ev.scored = scored.length;
    fs.writeFileSync('index-populate-scored.json', JSON.stringify(scored.sort((a, b) => b.score - a.score), null, 2));
    console.log('scored: ' + scored.length + '  (top: ' + (scored[0] ? scored[0].score + '% ' + scored[0].url : 'n/a') + ')');
    // hand to the engine if it exposes a persist/upsert
    if (eng && typeof eng.mod.upsert === 'function') {
      try { eng.mod.upsert(scored); console.log('upserted into engine'); } catch (e) { console.log('upsert failed: ' + e.message); }
    } else if (eng && typeof eng.mod.add === 'function') {
      try { scored.forEach(s => eng.mod.add(s)); console.log('added into engine'); } catch (e) { console.log('add failed: ' + e.message); }
    }
  } else {
    console.log('no scoring path available (no engine run fn, no conformance.run)');
  }

  // ---------- 4. verify ----------
  if (base) {
    await new Promise(r => setTimeout(r, 1500));
    const after = await req(base + '/v1/index');
    const d = j(after.body);
    ev.entriesAfter = (d && (d.count || (d.services && d.services.length) || (Array.isArray(d) && d.length))) || 0;
    ev.indexShape = d ? Object.keys(d).slice(0, 12) : null;
  }
  console.log('entries after:  ' + ev.entriesAfter);
  fs.writeFileSync('index-populate-evidence.json', JSON.stringify(ev, null, 2));
  console.log('evidence -> index-populate-evidence.json');
})().catch(e => { console.log('ERR ' + e.message); process.exitCode = 1; });
