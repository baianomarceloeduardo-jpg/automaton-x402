// patch-selfprobe.js — remove the self-fetch probe from the request path.
//
// ROOT CAUSE (measured, not guessed): resolveBase() proved liveness by fetching the candidate's
// /health. When called from inside the server that is serving that same tunnel, the server had to
// fetch ITSELF through the tunnel to answer its own request -> the inner fetch starved/failed ->
// reachable=false -> the endpoint returned 503 for a base that was demonstrably alive (the very
// request proved it). Standalone the module worked, which is exactly why this only showed up live.
//
// FIX: if the candidate base IS the live tunnel base, it is reachable BY CONSTRUCTION — the
// request we are answering arrived through it. Accept it with via='request_origin' and make
// ZERO network calls. Self-fetch is now impossible in the hot path.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const F = path.join(DIR, 'resolve-base.js');

let s = fs.readFileSync(F, 'utf8');
const before = s;

// 1. probeCandidate takes a trustedBase and short-circuits on it (no I/O at all).
s = s.replace(
  'async function probeCandidate(base) {',
  'async function probeCandidate(base, trustedBase) {\n' +
  '  const norm = (x) => String(x || "").replace(/\\/+$/, "");\n' +
  '  if (trustedBase && norm(base) === norm(trustedBase)) {\n' +
  '    return { reachable: true, via: "request_origin", status: 200,\n' +
  '             note: "candidate is the live tunnel base; the request being answered proves it is up" };\n' +
  '  }'
);

// 2. resolveBase computes the trusted base from the live tunnel file (no I/O beyond one read).
s = s.replace(
  '  const addr = address || DEFAULT_ADDR;\n  const tried = [];',
  '  const addr = address || DEFAULT_ADDR;\n  const trustedBase = opts.trustedBase || currentTunnelBase();\n  const tried = [];'
);

// 3. pass it through to the probe.
s = s.replace(
  '    const p = await probeCandidate(c.base);',
  '    const p = await probeCandidate(c.base, trustedBase);'
);

if (s === before) { console.log('PATCH=NOOP reason=patterns_not_found'); process.exit(1); }
const applied = ['trustedBase param', 'trustedBase compute', 'trustedBase pass-through'].length;
fs.writeFileSync(F, s);
fs.writeFileSync(F + '.bak-selfprobe', before);

// syntax check
try { require(F); console.log('PATCH=APPLIED syntax=OK bytes=' + s.length); }
catch (e) { fs.writeFileSync(F, before); console.log('PATCH=REVERTED syntax_error=' + e.message); process.exit(1); }
