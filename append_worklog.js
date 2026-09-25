// append_worklog.js - idempotently append the badge worklog note to the real WORKLOG.
'use strict';
const fs = require('fs');
const W = 'C:\\Users\\marce\\.automaton\\WORKLOG.md';
const add = fs.readFileSync('worklog_badge.md', 'utf8');
let cur = '';
try { cur = fs.readFileSync(W, 'utf8'); } catch (e) {}
if (cur.includes('VIRAL DISTRIBUTION MECHANISM: EMBEDDABLE x402 BADGE')) {
  console.log('WORKLOG already has badge note');
} else {
  fs.appendFileSync(W, add);
  console.log('WORKLOG appended, bytes=' + fs.statSync(W).size);
}
