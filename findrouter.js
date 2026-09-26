// findrouter.js - locate the exact dispatch point in server.js so the overlay can hook in.
const fs = require('fs');
const lines = fs.readFileSync('server.js', 'utf8').split(/\r?\n/);
const pats = [/pathname/i, /routes\s*[=\[]/i, /function handle/i, /createServer/, /\.listen\(/, /dispatch/i, /routeMap/i, /handlers\s*=/i];
lines.forEach((l, i) => {
  if (pats.some(p => p.test(l))) console.log((i + 1) + ': ' + l.trim().slice(0, 180));
});
console.log('\n--- total lines: ' + lines.length + ' ---');
