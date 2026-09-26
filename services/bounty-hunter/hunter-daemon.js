'use strict';
/**
 * Automaton Bounty Hunter daemon — polls Bountycaster for open bounties the node can solve
 * without a human (a concrete EVM contract to audit), produces a bytecode security report,
 * signs it (EIP-191) when an operator key is configured, and records everything in the ledger.
 *
 * Feed: https://www.bountycaster.xyz/api/v1/bounties/open   (api.bountycaster.xyz does not resolve)
 *
 * Submission: Bountycaster claims are Farcaster replies to the bounty cast. Auto-reply only happens
 * when ALL of these are set: HUNTER_AUTO_SUBMIT=1, NEYNAR_API_KEY, NEYNAR_SIGNER_UUID.
 * Otherwise solved bounties stay in the ledger as `ready_to_submit`.
 *
 * Usage: node hunter-daemon.js [--once]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRpc } = require('../lib/rpc');
const { readJson, writeJsonAtomic, logger } = require('../lib/store');
const { loadSigner } = require('../lib/signer');
const { scanTokenContract } = require('../../token-security.js');

const FEED_URL = process.env.BOUNTY_FEED_URL || 'https://www.bountycaster.xyz/api/v1/bounties/open';
const LEDGER_FILE = process.env.BOUNTY_LEDGER || path.join(__dirname, 'bounty-ledger.json');
const REPORT_DIR = process.env.BOUNTY_REPORT_DIR || path.join(__dirname, 'reports');
const POLL_MS = +(process.env.HUNTER_POLL_MS || 60000);
const MIN_USD = +(process.env.HUNTER_MIN_USD || 5);
const PAYEE = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const AGENT_ID = '95791';
const log = logger('bounty-hunter');

// A bounty is only auto-solvable when it asks for this kind of work AND names a contract.
const STRONG = ['audit', 'honeypot', 'security', 'bytecode', 'simulat', 'rug', 'vulnerab', 'exploit', 'scam', 'malicious'];
const WEAK = ['token', 'contract', 'erc20', 'erc-20', 'verify', 'base', 'evm', 'smart contract'];
const ADDR_RE = /\b0x[a-fA-F0-9]{40}\b/g;

function normalize(b) {
  const r = b.reward_summary || {};
  const usd = Number(r.usd_value);
  return {
    uid: String(b.uid || ''),
    title: String(b.title || ''),
    text: String(b.summary_text || b.description || ''),
    usd: Number.isFinite(usd) ? usd : null,
    rewardAmount: r.unit_amount != null ? String(r.unit_amount) : null,
    rewardToken: (r.token && r.token.symbol) || null,
    castHash: (b.platform && b.platform.hash) || null,
    url: 'https://www.bountycaster.xyz/bounty/' + ((b.platform && b.platform.hash) || b.uid),
    tags: Array.isArray(b.tag_slugs) ? b.tag_slugs : [],
    expiresAt: b.expiration_date || null,
    hasReward: b.reward_summary != null
  };
}

function classify(n, now = Date.now()) {
  const text = (n.title + ' ' + n.text + ' ' + n.tags.join(' ')).toLowerCase();
  const strong = STRONG.filter(k => text.includes(k));
  const weak = WEAK.filter(k => text.includes(k));
  const addresses = [...new Set(((n.title + ' ' + n.text).match(ADDR_RE) || []).map(a => a.toLowerCase()))].slice(0, 5);
  const reasons = [];
  if (!n.uid) reasons.push('no_uid');
  if (!n.hasReward) reasons.push('no_reward');
  if (n.usd !== null && n.usd < MIN_USD) reasons.push(`reward_below_${MIN_USD}usd`);
  if (n.expiresAt && Date.parse(n.expiresAt) < now) reasons.push('expired');
  if (!strong.length) reasons.push('no_security_keyword');
  if (!addresses.length) reasons.push('no_contract_address');
  return { viable: reasons.length === 0, reasons, strong, weak, addresses };
}

async function solve(n, cls, { rpc, scan = scanTokenContract, signer, now = () => Date.now() }) {
  const findings = [];
  for (const addr of cls.addresses) {
    let s;
    try { s = await scan(addr, (m, p) => rpc.call(m, p)); } catch (e) { s = { error: 'scan_exception', message: e.message }; }
    findings.push({ address: addr, network: 'base', chainId: 8453, result: s });
  }
  const report = {
    kind: 'automaton.bounty-report.v1',
    bounty: { uid: n.uid, url: n.url, title: n.title },
    solver: { name: 'Automaton-Sovereign', erc8004AgentId: AGENT_ID, payee: PAYEE },
    generatedAt: new Date(now()).toISOString(),
    method: 'Static EVM bytecode analysis on Base mainnet (opcode walk skipping PUSH data, ERC-20 and admin selector detection, risk scoring) via token-security.js',
    limitations: [
      'Static bytecode analysis only: no source review, no dynamic buy/sell simulation, no off-chain context.',
      'Proxy contracts are analysed at the proxy address; implementation logic may differ.'
    ],
    findings
  };
  const body = JSON.stringify(report);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const message = `Automaton bounty report ${n.uid} sha256:${sha256}`;
  let attestation = { signed: false, reason: 'no_operator_key_configured' };
  if (signer) {
    attestation = {
      signed: true, scheme: 'EIP-191', message,
      signature: await signer.signMessage(message),
      signer: signer.address,
      signerIsPayee: signer.address.toLowerCase() === PAYEE.toLowerCase()
    };
  }
  return { report, sha256, attestation };
}

function castText(n, solved, reportUrl) {
  const lines = solved.report.findings.map(f => {
    const r = f.result || {};
    return r.error ? `${f.address}: scan failed (${r.error})` : `${f.address}: ${r.verdict} (risk ${r.riskScore}/100${r.flags && r.flags.length ? '; ' + r.flags.slice(0, 3).join(', ') : ''})`;
  });
  return [
    'Automated bytecode security report by Automaton (ERC-8004 #' + AGENT_ID + ').',
    ...lines,
    'sha256:' + solved.sha256.slice(0, 16) + '…' + (reportUrl ? ' ' + reportUrl : ''),
    'Payout: ' + PAYEE
  ].join('\n').slice(0, 1000);
}

function neynarSubmitter(env = process.env, fetchImpl = globalThis.fetch) {
  if (env.HUNTER_AUTO_SUBMIT !== '1' || !env.NEYNAR_API_KEY || !env.NEYNAR_SIGNER_UUID) return null;
  return async (n, text) => {
    if (!n.castHash) throw new Error('bounty has no cast hash to reply to');
    const r = await fetchImpl('https://api.neynar.com/v2/farcaster/cast', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.NEYNAR_API_KEY },
      body: JSON.stringify({ signer_uuid: env.NEYNAR_SIGNER_UUID, text, parent: n.castHash })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('neynar_' + r.status + ': ' + (j.message || ''));
    return { castHash: j.cast && j.cast.hash };
  };
}

class BountyHunter {
  constructor({ fetchImpl = globalThis.fetch, rpc = createRpc(), scan = scanTokenContract, signer = loadSigner(),
    submitter = neynarSubmitter(), ledgerFile = LEDGER_FILE, reportDir = REPORT_DIR, now = () => Date.now() } = {}) {
    Object.assign(this, { fetchImpl, rpc, scan, signer, submitter, ledgerFile, reportDir, now });
    this.ledger = readJson(ledgerFile, null) || { version: 1, seen: {}, claims: [] };
  }

  save() { writeJsonAtomic(this.ledgerFile, this.ledger); }

  async fetchOpen() {
    const r = await this.fetchImpl(FEED_URL, { headers: { 'user-agent': 'AutomatonBountyHunter/2.0' } });
    if (!r.ok) throw new Error('feed_http_' + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j : (j.bounties || []);
  }

  async tick() {
    const raw = await this.fetchOpen();
    const out = { open: raw.length, new: 0, viable: 0, solved: 0, submitted: 0 };
    for (const b of raw) {
      const n = normalize(b);
      if (!n.uid || this.ledger.seen[n.uid]) continue;
      out.new++;
      const cls = classify(n, this.now());
      this.ledger.seen[n.uid] = { firstSeenAt: new Date(this.now()).toISOString(), title: n.title.slice(0, 140), usd: n.usd, url: n.url, viable: cls.viable, reasons: cls.reasons };
      if (!cls.viable) continue;
      out.viable++;

      const solved = await solve(n, cls, { rpc: this.rpc, scan: this.scan, signer: this.signer, now: this.now });
      fs.mkdirSync(this.reportDir, { recursive: true });
      const reportFile = path.join(this.reportDir, n.uid.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
      fs.writeFileSync(reportFile, JSON.stringify({ ...solved.report, sha256: solved.sha256, attestation: solved.attestation }, null, 2));
      out.solved++;

      const claim = { uid: n.uid, url: n.url, usd: n.usd, at: new Date(this.now()).toISOString(), reportFile: path.basename(reportFile), sha256: solved.sha256, signed: solved.attestation.signed, status: 'ready_to_submit' };
      if (this.submitter) {
        try {
          const reportUrl = process.env.BOUNTY_REPORT_BASE_URL ? process.env.BOUNTY_REPORT_BASE_URL.replace(/\/$/, '') + '/' + claim.reportFile : null;
          const r = await this.submitter(n, castText(n, solved, reportUrl));
          Object.assign(claim, { status: 'submitted', castHash: r.castHash || null });
          out.submitted++;
        } catch (e) {
          Object.assign(claim, { status: 'submit_failed', error: e.message });
        }
      }
      this.ledger.claims.push(claim);
    }
    this.ledger.lastPollAt = new Date(this.now()).toISOString();
    this.ledger.lastOpenCount = raw.length;
    this.save();
    return out;
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const h = new BountyHunter();
  log('start', { feed: FEED_URL, signer: h.signer ? h.signer.address : 'none (reports unsigned)', autoSubmit: !!h.submitter });
  const stop = () => process.exit(0);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let failures = 0;
  for (;;) {
    try {
      const r = await h.tick();
      failures = 0;
      log(`open ${r.open} | new ${r.new} | viable ${r.viable} | solved ${r.solved} | submitted ${r.submitted}`);
    } catch (e) {
      failures++;
      log('tick error', e.message);
    }
    if (once) break;
    await new Promise(r => setTimeout(r, POLL_MS * Math.min(10, 1 + failures)));
  }
}

if (require.main === module) main();

module.exports = { BountyHunter, normalize, classify, solve, castText, neynarSubmitter, PAYEE, AGENT_ID };
