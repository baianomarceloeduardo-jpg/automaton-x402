// patch-procure-normalize.js — fix a REAL defect found by the stdio suite (test 5 FAIL).
//
// DEFECT: x402_procure's toolConformance assumed the checker returns {verdict, total, passed}.
// The live endpoint returns a different shape, so `verdict=undefined undefined/undefined`.
// The MCP server must not depend on my server's exact field names -- it should normalize any
// reasonable shape into {verdict, passed, total, checks}. This is the difference between a client
// that works against one deployment and a client that works against the protocol.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const T = path.join(DIR, 'x402-procure-mcp.js');

let s = fs.readFileSync(T, 'utf8');
if (s.indexOf('__NORMALIZE__') !== -1) { console.log('[procure] already normalized'); process.exit(0); }

const OLD = `  try { return Object.assign({ ok: true }, JSON.parse(r.body)); } catch (e) { return { ok: false, error: 'unparseable' }; }
}`;

const NEW = `  /* __NORMALIZE__ do not depend on my server's exact field names */
  let raw; try { raw = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'unparseable' }; }
  const results = raw.results || raw.checks || [];
  const passed = raw.passed != null ? raw.passed : (raw.pass != null ? raw.pass : results.filter(x => x.ok === true || x.pass === true).length);
  const total = raw.total != null ? raw.total : (results.length || raw.count || null);
  const verdict = raw.verdict || raw.status || raw.conformance
    || (total != null ? (passed === total ? 'CONFORMANT' : (passed > 0 ? 'PARTIAL' : 'NON_CONFORMANT')) : 'UNKNOWN');
  return { ok: true, verdict, passed, total, url: raw.url || args.url,
    checks: results.slice(0, 12).map(c => ({ name: c.name || c.check || c.id, ok: c.ok === true || c.pass === true, detail: c.detail || c.note || null })),
    rawKeys: Object.keys(raw) };
}`;

if (s.indexOf(OLD) === -1) { console.log('[procure] FATAL: anchor not found'); process.exit(1); }
s = s.replace(OLD, NEW);
fs.writeFileSync(T, s);
console.log('[procure] toolConformance now normalizes {verdict,passed,total,checks} from any shape');
