// inspect-settle.js — locate every settlement hook already appended to server.js
const fs = require('fs');
const s = fs.readFileSync(__dirname + '/server.js', 'utf8');
const lines = s.split(/\r?\n/);
const pats = [
  /settle/i, /facilitator/i, /__[A-Z_]+OVERLAY__/, /VERIFY_URL/, /authorizationState/,
  /x402_facilitator|facilitator_verify_failed/, /X-PAYMENT/, /eip3009/i,
];
lines.forEach((l, i) => {
  if (pats.some(p => p.test(l))) {
    const t = l.trim();
    if (t.length > 0 && t.length < 160) console.log((i + 1) + '| ' + t);
  }
});
console.log('--- total lines=' + lines.length + ' bytes=' + s.length);
