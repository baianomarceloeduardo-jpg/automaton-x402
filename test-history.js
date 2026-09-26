// test-history.js - self-test for x402-history.js. Deterministic, no network.
'use strict';
const fs = require('fs');
const H = require('./x402-history.js');

let pass = 0, n = 0;
function ok(name, cond, extra) {
  n++;
  if (cond) { pass++; console.log('PASS  ' + name); }
  else console.log('FAIL  ' + name + (extra ? '  ' + extra : ''));
}

const backup = fs.existsSync(H.FILE) ? fs.readFileSync(H.FILE, 'utf8') : null;
try {
  fs.writeFileSync(H.FILE, '');

  const A = [
    { url: 'https://a.example/mcp', verdict: 'CONFORMANT', score: 100, dialect: 'v2', status: 200 },
    { url: 'https://b.example/mcp', verdict: 'NON_CONFORMANT', score: 40, dialect: 'v1', status: 200 },
    { url: 'seed:curated', verdict: 'CONFORMANT', score: 100 }
  ];
  const s1 = H.snapshot(A, '2026-09-24T00:00:00Z');
  ok('snapshot counts rows', s1.total === 2, 'total=' + s1.total);
  ok('seed rows excluded', s1.rows.every(r => !r.url.startsWith('seed:')));
  ok('health pct', s1.healthPct === 50, 'got ' + s1.healthPct);
  H.append(s1);
  ok('append persists', H.series(10).length === 1);

  ok('single snapshot -> no deltas', H.deltas() === null);

  const B = [
    { url: 'https://a.example/mcp', verdict: 'CONFORMANT', score: 100, dialect: 'v2', status: 200 },
    { url: 'https://c.example/mcp', verdict: 'CONFORMANT', score: 100, dialect: 'v2', status: 200 }
  ];
  H.append(H.snapshot(B, '2026-09-25T00:00:00Z'));

  const d = H.deltas();
  ok('delta computed', !!d);
  ok('detects added', d.added.length === 1 && d.added[0] === 'https://c.example/mcp', JSON.stringify(d.added));
  ok('detects removed', d.removed.length === 1 && d.removed[0] === 'https://b.example/mcp', JSON.stringify(d.removed));
  ok('health improved', d.fromHealthPct === 50 && d.toHealthPct === 100);
  ok('day span', d.fromDay === '2026-09-24' && d.toDay === '2026-09-25', d.fromDay + '->' + d.toDay);

  const rep = H.report();
  ok('report has table', rep.includes('| 2026-09-24 |'));
  ok('report has change section', rep.includes('## Change: 2026-09-24 -> 2026-09-25'));

  // verdict drift detection
  const C = [
    { url: 'https://a.example/mcp', verdict: 'NON_CONFORMANT', score: 40, dialect: 'v2', status: 200 }
  ];
  H.append(H.snapshot(C, '2026-09-26T00:00:00Z'));
  const d2 = H.deltas();
  ok('detects verdict drift', d2.changed.length === 1 && d2.changed[0].from === 'CONFORMANT' && d2.changed[0].to === 'NON_CONFORMANT',
     JSON.stringify(d2.changed));

  // resilient to a torn/corrupt line
  fs.appendFileSync(H.FILE, '{"ts":"broken"\n');
  ok('survives torn line', H.series(10).length === 3, 'len=' + H.series(10).length);

  ok('latest returns last', H.latest().day === '2026-09-26');
} finally {
  if (backup !== null) fs.writeFileSync(H.FILE, backup); else { try { fs.unlinkSync(H.FILE); } catch (e) {} }
}

console.log('\nHISTORY SELF-TEST ' + pass + '/' + n + (pass === n ? ' ALL PASS' : ' FAILURES'));
process.exit(pass === n ? 0 : 1);
