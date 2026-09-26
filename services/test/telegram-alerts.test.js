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
  assert.match(t, /Novo Token Detectado na Base/);
  assert.match(t, /Dex: Uniswap v4/);
  assert.match(t, new RegExp('<code>' + tok('a') + '</code>'));
  assert.match(t, /Risco: BAIXO/);
  assert.match(t, /Auditado em 140ms/);
  assert.match(t, /não é recomendação de compra|nem é recomendação de compra/);
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
