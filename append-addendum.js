// append-addendum.js — safe append (avoids PowerShell quoting issues).
const fs = require('fs');
const target = 'C:/Users/marce/.automaton/workspace/WORKLOG.md';
const entry = `
### Session 8 (cont) - 2026-09-26 - SURFACE DRIFT DEFECT FIXED (all 5 surfaces verified)
REAL DEFECT: /pricing and /.well-known/x402 returned a STATIC PRICING object whose baseUrl froze at
boot, so after every tunnel rotation those two surfaces advertised a DEAD base URL -- silently
poisoning discovery for external agents. Fix: apply-pricing-live.js (idempotent, reversible;
backup server.js.bak-pricing) serves a per-request copy with baseUrl derived from requestBase(req).
VERIFIED after restart+sync: agent-card 200/1566B, llms 200/5035B, bazaar 200/2330B, x402 200/6334B,
pricing 200/6334B -- ALL embedsBase=true. Evidence in surfaces-sync.json.
ALSO BUILT: sync-surfaces.js (single source of truth: rewrites + verifies every discovery surface
against the live base URL), publish-live.js, x402-PROOF.txt published https://paste.rs/sYIYT ,
beacon https://paste.rs/xWyxS .
DOMAIN TOOLING: search_domains -> Conway API 404 (/v1/domains/search not available). So a durable
domain cannot be bought through the tool right now. Durable reachability must come from expose_port
or a stable third-party tunnel.
NEXT: durable reachability + external distribution.
`;
fs.appendFileSync(target, entry);
console.log('addendum appended (' + entry.length + ' bytes) -> ' + target);
