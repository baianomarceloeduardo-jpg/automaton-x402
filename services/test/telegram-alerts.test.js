'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTelegramAlerter, loadAlertConfig, formatAlert } = require('../pool-sentinel/telegram-alerts.js');
const { PoolSentinel } = require('../pool-sentinel/pool-watcher.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
const tok = c => '0x' + c.repeat(40);
const rec = (token, verdict, dex = 'uniswap-v4') => ({ dex, newTokens: [token], scans: { [token]: { verdict, riskScore: verdict === 'SAFE' ? 10 : 45, scanMs: 140, flags: [] } } });

function fakeTelegram() {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { username: 'AutomatonBaseBot' } }) };
    sent.push(body);
    return { json: async () => ({ ok: true, result: {} }) };
  };
  return { sent, fetchImpl };
}

test('loadAlertConfig: needs a token, honours SENTINEL_ALERTS=0, reads config.json', () => {
  const d = tmp();
  assert.equal(loadAlertConfig({}, d), null);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ botToken: 't', alertChatId: '-100123' }));
  const c = loadAlertConfig({}, d);
  assert.deepEqual([c.token, c.channelId, c.maxPerHour], ['t', '-100123', 12]);
  assert.equal(loadAlertConfig({ SENTINEL_ALERTS: '0' }, d), null);
  assert.equal(loadAlertConfig({ TELEGRAM_ALERT_CHAT_ID: '-9', SENTINEL_ALERTS_PER_HOUR: '3' }, d).maxPerHour, 3);
});

test('only opt-in recipients: channel + users with alerts:true; nobody -> nothing sent', async () => {
  const d = tmp();
  const usersFile = path.join(d, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify({ 111: { alerts: true }, 222: { alerts: false }, 333: {} }));
  const tg = fakeTelegram();
  const a = createTelegramAlerter({ token: 't', channelId: '-100', usersFile, fetchImpl: tg.fetchImpl });
  assert.deepEqual(a.recipients(), ['-100', '111']);
  assert.equal(await a.notify([rec(tok('a'), 'SAFE')]), 1);
  assert.deepEqual(tg.sent.map(m => m.chat_id), ['-100', '111']);

  const silent = fakeTelegram();
  const none = createTelegramAlerter({ token: 't', usersFile: path.join(d, 'missing.json'), fetchImpl: silent.fetchImpl });
  assert.equal(await none.notify([rec(tok('b'), 'SAFE')]), 0);
  assert.equal(silent.sent.length, 0);
});

test('verdict filter, per-token dedup and hourly budget', async () => {
  const tg = fakeTelegram();
  let now = 1_000_000;
  const a = createTelegramAlerter({ token: 't', channelId: '-1', maxPerHour: 2, fetchImpl: tg.fetchImpl, now: () => now });
  const sent1 = await a.notify([rec(tok('1'), 'SAFE'), rec(tok('2'), 'HIGH_RISK_CAUTION'), rec(tok('3'), 'DANGER_HONEYPOT_RISK'), rec(tok('4'), 'MODERATE_RISK')]);
  assert.equal(sent1, 2, 'SAFE + MODERATE only');
  assert.equal(await a.notify([rec(tok('1'), 'SAFE')]), 0, 'same token never twice');
  assert.equal(await a.notify([rec(tok('5'), 'SAFE')]), 0, 'hour budget exhausted');
  now += 3601 * 1000;
  assert.equal(await a.notify([rec(tok('6'), 'SAFE')]), 1, 'budget refills after an hour');
});

test('alert text: required fields, disclaimer, HTML-safe', () => {
  const t = formatAlert({ dex: 'uniswap-v4', token: tok('a'), scan: { verdict: 'SAFE', riskScore: 10, scanMs: 140 }, botUsername: 'AutomatonBaseBot' });
  assert.match(t, /New Token Detected on Base/);
  assert.match(t, /Dex: Uniswap v4/);
  assert.match(t, new RegExp('<code>' + tok('a') + '</code>'));
  assert.match(t, /Risk: LOW/);
  assert.match(t, /Audited in 140ms/);
  assert.match(t, /Not financial advice|DYOR/);
  assert.match(t, /@AutomatonBaseBot/);
  assert.doesNotMatch(formatAlert({ dex: '<x>', token: tok('b'), scan: { verdict: 'SAFE', riskScore: 1, scanMs: 1 } }), /<x>/);
});

test('a failing Telegram call does not break the batch', async () => {
  const fetchImpl = async url => ({ json: async () => (url.endsWith('getMe') ? { ok: true, result: {} } : { ok: false, description: 'Forbidden' }) });
  const logs = [];
  const a = createTelegramAlerter({ token: 't', channelId: '-1', fetchImpl, log: m => logs.push(m) });
  assert.equal(await a.notify([rec(tok('7'), 'SAFE'), rec(tok('8'), 'SAFE')]), 2);
  assert.equal(logs.length, 2);
});

test('PoolSentinel hands new records to onRecords without blocking the tick', async () => {
  const { SOURCES } = require('../pool-sentinel/pool-watcher.js');
  const src = SOURCES.find(s => s.dex === 'uniswap-v3');
  const enc = src.iface.encodeEventLog(src.iface.fragments[0], [tok('a'), '0x4200000000000000000000000000000000000006', 3000, 60, tok('d')]);
  const lg = { address: src.address, topics: enc.topics, data: enc.data, blockNumber: '0x5', logIndex: '0x0', transactionHash: '0x' + '0'.repeat(64) };
  let calls = 0;
  const rpc = { urls: [], call: async m => (m === 'eth_blockNumber' ? '0x5' : [lg]) };
  let got;
  const s = new PoolSentinel({ rpc, file: path.join(tmp(), 's.json'), scan: async () => ({ riskScore: 10, verdict: 'SAFE' }),
    onRecords: async recs => { calls++; got = recs; throw new Error('telegram down'); } });
  const r = await s.tick();
  await new Promise(res => setImmediate(res));
  assert.equal(r.newPools, 1);
  assert.equal(calls, 1);
  assert.equal(got[0].newTokens[0], tok('a'));
});

test('Quality Filter: maxRiskScore rejects tokens above threshold', async () => {
  const tg = fakeTelegram();
  const a = createTelegramAlerter({ token: 't', channelId: '-1', maxRiskScore: 15, fetchImpl: tg.fetchImpl });
  const records = [
    { dex: 'uniswap-v4', newTokens: [tok('1')], scans: { [tok('1')]: { verdict: 'SAFE', riskScore: 10, scanMs: 100 } } },
    { dex: 'uniswap-v4', newTokens: [tok('2')], scans: { [tok('2')]: { verdict: 'SAFE', riskScore: 18, scanMs: 100 } } },
    { dex: 'uniswap-v4', newTokens: [tok('3')], scans: { [tok('3')]: { verdict: 'SAFE', riskScore: 25, scanMs: 100 } } }
  ];
  const sent = await a.notify(records);
  assert.equal(sent, 1, 'Only riskScore <= 15 is sent');
  assert.match(tg.sent[0].text, new RegExp(tok('1')));
});

test('Quality Filter: requireQuotePair rejects phantom token-token pairs with no quote asset', async () => {
  const tg = fakeTelegram();
  const WETH = '0x4200000000000000000000000000000000000006';
  const a = createTelegramAlerter({ token: 't', channelId: '-1', requireQuotePair: true, fetchImpl: tg.fetchImpl });
  const records = [
    // Real liquidity: paired with WETH
    { dex: 'uniswap-v4', token0: WETH, token1: tok('1'), newTokens: [tok('1')], scans: { [tok('1')]: { verdict: 'SAFE', riskScore: 10, scanMs: 50 } } },
    // Phantom pair: two unknown tokens with zero backing
    { dex: 'uniswap-v4', token0: tok('x'), token1: tok('2'), newTokens: [tok('2')], scans: { [tok('2')]: { verdict: 'SAFE', riskScore: 10, scanMs: 50 } } }
  ];
  const sent = await a.notify(records);
  assert.equal(sent, 1, 'Only the token paired against WETH quote asset was alerted');
  assert.match(tg.sent[0].text, new RegExp(tok('1')));
});

test('Quality Filter: rejectUnverifiedHooks drops custom/unverified v4 hooks', async () => {
  const tg = fakeTelegram();
  const WETH = '0x4200000000000000000000000000000000000006';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const CLANKER_HOOK = '0xbdf938149ac6a781f94faa0ed45e6a0e984c6544';
  const MALICIOUS_HOOK = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  const a = createTelegramAlerter({ token: 't', channelId: '-1', rejectUnverifiedHooks: true, fetchImpl: tg.fetchImpl });
  const records = [
    { dex: 'uniswap-v4', hooks: ZERO, token0: WETH, token1: tok('1'), newTokens: [tok('1')], scans: { [tok('1')]: { verdict: 'SAFE', riskScore: 10, scanMs: 50 } } },
    { dex: 'uniswap-v4', hooks: CLANKER_HOOK, token0: WETH, token1: tok('2'), newTokens: [tok('2')], scans: { [tok('2')]: { verdict: 'SAFE', riskScore: 10, scanMs: 50 } } },
    { dex: 'uniswap-v4', hooks: MALICIOUS_HOOK, token0: WETH, token1: tok('3'), newTokens: [tok('3')], scans: { [tok('3')]: { verdict: 'SAFE', riskScore: 10, scanMs: 50 } } }
  ];
  const sent = await a.notify(records);
  assert.equal(sent, 2, 'Zero hook and verified Clanker hook passed; malicious hook dropped');
});

test('Quality Filter: anti-clone and anti-phishing filter drops spam names and duplicates', async () => {
  const tg = fakeTelegram();
  const a = createTelegramAlerter({ token: 't', channelId: '-1', dedupSymbols: true, fetchImpl: tg.fetchImpl });
  // PoolSentinel outputs newest first; notify reverses to process oldest to newest
  const records = [
    // Duplicate clone created later (newest):
    { dex: 'uniswap-v4', newTokens: [tok('3')], scans: { [tok('3')]: { verdict: 'SAFE', riskScore: 10, symbol: 'PEPE', name: 'Pepe Clone 2', scanMs: 50 } } },
    // First legit token (earlier):
    { dex: 'uniswap-v4', newTokens: [tok('2')], scans: { [tok('2')]: { verdict: 'SAFE', riskScore: 10, symbol: 'PEPE', name: 'Pepe Base', scanMs: 50 } } },
    // Phishing / spam token name:
    { dex: 'uniswap-v4', newTokens: [tok('1')], scans: { [tok('1')]: { verdict: 'SAFE', riskScore: 10, symbol: 'AIRDROP', name: 'Claim at http://free.io', scanMs: 50 } } }
  ];
  const sent = await a.notify(records);
  assert.equal(sent, 1, 'Only genuine first PEPE was announced; phishing and clone dropped');
  assert.match(tg.sent[0].text, /\$PEPE/);
  assert.match(tg.sent[0].text, /Pepe Base/);
});

