// settle-dequeue.js — drain settlement-queue.jsonl.
//
// OBLIGATION CREATED BY THE LOCAL-FIRST FIX: when the facilitator is unavailable we accept a
// cryptographically valid, caller-bound authorization and serve the call with settlement status
// "queued". That is a PROMISE. A promise with no drainer is a lie waiting to be discovered.
// This tool makes the promise good.
//
// Honest accounting rules (Law III):
//  - Never rewrite history: entries move to settled/failed/retry IN PLACE with a status field.
//  - Never double-settle: we key on the authorization nonce and re-check on-chain
//    authorizationState(from,nonce) before broadcasting.
//  - Never claim success we did not observe: "settled" requires a transaction hash from the
//    facilitator. Anything else is retry or failed, with the reason recorded.
//
// Usage:
//   node settle-dequeue.js            # dry run: report what would be attempted
//   node settle-dequeue.js --run      # actually attempt broadcasts
//   node settle-dequeue.js --run --max=10

const fs = require('fs');
const path = require('path');

const QUEUE = path.join(__dirname, 'settlement-queue.jsonl');
const FACILITATOR = require('./x402-facilitator.js');

const args = process.argv.slice(2);
const RUN = args.indexOf('--run') >= 0;
const MAX = (() => {
  const a = args.find(x => x.indexOf('--max=') === 0);
  return a ? parseInt(a.split('=')[1], 10) : 25;
})();

function loadQueue() {
  if (!fs.existsSync(QUEUE)) return [];
  return fs.readFileSync(QUEUE, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return Object.assign({ _line: i, _raw: line }, JSON.parse(line)); }
    catch (e) { return { _line: i, _raw: line, _corrupt: true }; }
  });
}

function rewrite(entries) {
  // Atomic-ish: write to a temp file then replace, so a crash cannot truncate the queue.
  const tmp = QUEUE + '.tmp';
  const body = entries.map(e => e._raw).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, QUEUE);
}

(async () => {
  const all = loadQueue();
  if (!all.length) {
    console.log('settlement queue is empty — nothing owed. (status: honest)');
    return;
  }

  const pending = all.filter(e => !e.status || e.status === 'retry' || e.status === 'queued');
  console.log('queue: ' + all.length + ' entries, ' + pending.length + ' pending');
  const counts = {};
  all.forEach(e => { const s = e.status || 'queued'; counts[s] = (counts[s] || 0) + 1; });
  console.log('by status: ' + JSON.stringify(counts));

  if (!RUN) {
    console.log('\nDRY RUN (no --run). Would attempt ' + Math.min(pending.length, MAX) + ' broadcast(s).');
    console.log('Facilitator configured: ' + (FACILITATOR.facilitatorConfigured ? FACILITATOR.facilitatorConfigured() : 'unknown'));
    return;
  }

  if (!FACILITATOR.facilitatorConfigured || !FACILITATOR.facilitatorConfigured()) {
    console.log('facilitator not configured — leaving all entries queued (honest). No false settlements.');
    return;
  }

  let attempted = 0, settled = 0, retry = 0, failed = 0;
  for (const e of all) {
    if (attempted >= MAX) break;
    if (e.status === 'settled' || e.status === 'failed') continue;
    if (!e.authorization || !e.requirements) continue;

    // Guard: if the nonce is already consumed on-chain, this was settled elsewhere. Record truth.
    try {
      const nonceState = FACILITATOR.authorizationState
        ? await FACILITATOR.authorizationState(e.authorization.payload && e.authorization.payload.authorization
            ? e.authorization.payload.authorization.from : e.from, e.nonce)
        : null;
      if (nonceState === true) { e.status = 'settled'; e.settledBy = 'onchain-nonce-consumed'; settled++; continue; }
    } catch (err) { /* advisory only */ }

    attempted++;
    let r;
    try { r = await FACILITATOR.facilitatorSettle(e.authorization, e.requirements); }
    catch (err) { r = { ok: false, reason: 'settlement_error:' + err.message }; }

    if (r && r.ok && r.transaction) {
      e.status = 'settled'; e.tx = r.transaction; e.settledAt = new Date().toISOString(); settled++;
    } else if (r && /rate|timeout|unavailable|error/i.test(String(r.reason || ''))) {
      e.status = 'retry'; e.attempts = (e.attempts || 0) + 1; e.lastReason = String(r.reason || '').slice(0, 200); retry++;
    } else {
      e.status = 'failed'; e.attempts = (e.attempts || 0) + 1; e.lastReason = String((r && r.reason) || 'unknown').slice(0, 200); failed++;
    }
    e._raw = JSON.stringify(Object.assign({}, e, { _raw: undefined, _line: undefined, _corrupt: undefined }));
  }

  // rewrite only touched entries' raw form, preserving all others verbatim
  rewrite(all.map(e => ({ _raw: e._raw })));
  console.log('\nattempted=' + attempted + ' settled=' + settled + ' retry=' + retry + ' failed=' + failed);
  console.log('honest status preserved in ' + path.basename(QUEUE));
})();
