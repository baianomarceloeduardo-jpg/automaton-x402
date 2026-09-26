// patch-selftest-error.js — surface the real broadcast error instead of swallowing it.
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'local-settler.js');
let s = fs.readFileSync(F, 'utf8');

// 1. settleAuthorization: return errors as data, never throw away the message
s = s.replace(
  /  const gas = opts\.gasOverride \|\| \{\};\n/,
  "  const gas = opts.gasOverride || {};\n  try {\n"
);
s = s.replace(
  /  const rc = await tx\.wait\(1\);\n  const ok = rc && Number\(rc\.status\) === 1;\n  return \{ ok, tx: tx\.hash, status: rc && rc\.status, block: rc && rc\.blockNumber \};\n\}/,
  "  const rc = await tx.wait(1);\n  const ok = rc && Number(rc.status) === 1;\n  return { ok, tx: tx.hash, status: rc && rc.status, block: rc && rc.blockNumber };\n  } catch (e) {\n    return { ok: false, error: 'broadcast_failed: ' + (e.shortMessage || e.message), code: e.code, tx: (e.transaction && e.transaction.hash) || null };\n  }\n}"
);

// 2. selftest: print the reason on failure
s = s.replace(
  /  console\.log\('\[' \+ \(r\.ok \? 'D' : 'D-FAIL'\) \+ '\] settled on-chain tx=' \+ r\.tx \+ ' status=' \+ r\.status\);/,
  "  console.log('[' + (r.ok ? 'D' : 'D-FAIL') + '] settled on-chain tx=' + r.tx + ' status=' + r.status + ' error=' + (r.error || 'none'));"
);

fs.writeFileSync(F, s);
console.log('error-surfacing patch applied');
