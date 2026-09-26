'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const { BountyHunter, normalize, classify, solve, neynarSubmitter, PAYEE } = require('../bounty-hunter/hunter-daemon.js');
const { recoverSigner } = require('../lib/signer.js');

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-'));
const bounty = (uid, over = {}) => ({
  uid, title: 'Security audit: check honeypot risk of new Base token',
  summary_text: `Need a bytecode review of ${TOKEN} on Base.`,
  reward_summary: { unit_amount: '50', usd_value: '50', token: { symbol: 'USDC' } },
  platform: { hash: '0xcafe' + uid }, tag_slugs: ['dev'], expiration_date: '2099-01-01T00:00:00Z', ...over
});
const fakeScan = async addr => ({ address: addr, riskScore: 12, verdict: 'SAFE', flags: ['HAS_DELEGATECALL_PROXY'] });
const fakeRpc = { call: async () => { throw new Error('rpc should not be used with fakeScan'); } };
const signerFrom = w => ({ address: w.address, wallet: w, signMessage: m => w.signMessage(m) });

test('normalize maps the Bountycaster schema', () => {
  const n = normalize(bounty('u1'));
  assert.equal(n.uid, 'u1'); assert.equal(n.usd, 50); assert.equal(n.rewardToken, 'USDC');
  assert.equal(n.castHash, '0xcafeu1'); assert.equal(n.url, 'https://www.bountycaster.xyz/bounty/0xcafeu1');
});

test('classify requires a security ask, a contract address, a reward and no expiry', () => {
  assert.equal(classify(normalize(bounty('ok'))).viable, true);
  assert.deepEqual(classify(normalize(bounty('ok'))).addresses, [TOKEN.toLowerCase()]);
  assert.ok(classify(normalize(bounty('x', { summary_text: 'design a logo' , title: 'Logo'}))).reasons.includes('no_security_keyword'));
  assert.ok(classify(normalize(bounty('x', { summary_text: 'audit our protocol' }))).reasons.includes('no_contract_address'));
  assert.ok(classify(normalize(bounty('x', { reward_summary: null }))).reasons.includes('no_reward'));
  assert.ok(classify(normalize(bounty('x', { reward_summary: { usd_value: '1' } }))).reasons.includes('reward_below_5usd'));
  assert.ok(classify(normalize(bounty('x', { expiration_date: '2000-01-01T00:00:00Z' }))).reasons.includes('expired'));
});

test('solve produces a verifiable EIP-191 signature, or an explicit unsigned report', async () => {
  const n = normalize(bounty('sig'));
  const cls = classify(n);
  const w = ethers.Wallet.createRandom();
  const signed = await solve(n, cls, { rpc: fakeRpc, scan: fakeScan, signer: signerFrom(w) });
  assert.equal(signed.attestation.signed, true);
  assert.equal(recoverSigner(signed.attestation.message, signed.attestation.signature), w.address);
  assert.equal(signed.attestation.signerIsPayee, false);
  assert.match(signed.attestation.message, new RegExp(signed.sha256));
  assert.equal(signed.report.findings[0].result.verdict, 'SAFE');

  const unsigned = await solve(n, cls, { rpc: fakeRpc, scan: fakeScan, signer: null });
  assert.equal(unsigned.attestation.signed, false);
});

test('tick records every bounty once, solves only viable ones, and never auto-submits by default', async () => {
  const d = dir();
  const feed = [bounty('a'), bounty('b', { title: 'Write a thread', summary_text: 'marketing' }), { uid: '' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ bounties: feed }) });
  const h = new BountyHunter({ fetchImpl, rpc: fakeRpc, scan: fakeScan, signer: null, submitter: null, ledgerFile: path.join(d, 'ledger.json'), reportDir: path.join(d, 'reports') });
  const r1 = await h.tick();
  assert.deepEqual([r1.open, r1.new, r1.viable, r1.solved, r1.submitted], [3, 2, 1, 1, 0]);
  const ledger = JSON.parse(fs.readFileSync(path.join(d, 'ledger.json'), 'utf8'));
  assert.equal(ledger.claims.length, 1);
  assert.equal(ledger.claims[0].status, 'ready_to_submit');
  assert.equal(ledger.seen.b.viable, false);
  assert.ok(fs.existsSync(path.join(d, 'reports', 'a.json')));

  const r2 = await h.tick();
  assert.equal(r2.new, 0, 'idempotent across polls');
  const h2 = new BountyHunter({ fetchImpl, rpc: fakeRpc, scan: fakeScan, signer: null, submitter: null, ledgerFile: path.join(d, 'ledger.json'), reportDir: path.join(d, 'reports') });
  assert.equal((await h2.tick()).new, 0, 'idempotent across restarts');
});

test('submitter path: success and failure are both recorded', async () => {
  const d = dir();
  const fetchImpl = async () => ({ ok: true, json: async () => [bounty('s1'), bounty('s2')] });
  const texts = [];
  const submitter = async (n, text) => { texts.push(text); if (n.uid === 's2') throw new Error('neynar_500'); return { castHash: '0xreply' }; };
  const h = new BountyHunter({ fetchImpl, rpc: fakeRpc, scan: fakeScan, signer: null, submitter, ledgerFile: path.join(d, 'l.json'), reportDir: path.join(d, 'r') });
  const r = await h.tick();
  assert.equal(r.submitted, 1);
  const byUid = Object.fromEntries(h.ledger.claims.map(c => [c.uid, c]));
  assert.equal(byUid.s1.status, 'submitted'); assert.equal(byUid.s1.castHash, '0xreply');
  assert.equal(byUid.s2.status, 'submit_failed');
  assert.ok(texts[0].includes(PAYEE)); assert.ok(texts[0].length <= 1000);
});

test('feed errors propagate so the daemon backs off', async () => {
  const d = dir();
  const h = new BountyHunter({ fetchImpl: async () => ({ ok: false, status: 503 }), rpc: fakeRpc, scan: fakeScan, signer: null, submitter: null, ledgerFile: path.join(d, 'l.json'), reportDir: d });
  await assert.rejects(() => h.tick(), /feed_http_503/);
});

test('neynar submitter stays off unless explicitly enabled and configured', async () => {
  assert.equal(neynarSubmitter({}), null);
  assert.equal(neynarSubmitter({ NEYNAR_API_KEY: 'k', NEYNAR_SIGNER_UUID: 's' }), null);
  let sent;
  const sub = neynarSubmitter({ HUNTER_AUTO_SUBMIT: '1', NEYNAR_API_KEY: 'k', NEYNAR_SIGNER_UUID: 's' }, async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => ({ cast: { hash: '0xabc' } }) }; });
  const r = await sub({ castHash: '0xparent' }, 'hello');
  assert.equal(r.castHash, '0xabc');
  assert.equal(JSON.parse(sent.opts.body).parent, '0xparent');
});
