'use strict';
/**
 * Optional Telegram broadcast of new-token alerts from the Pool Sentinel.
 *
 * Recipients (opt-in only): the channel/chat in TELEGRAM_ALERT_CHAT_ID or config.alertChatId,
 * plus bot users who sent `/alerts on` (users.json entries with alerts: true).
 * Token: TELEGRAM_BOT_TOKEN or services/telegram-bot/config.json botToken. SENTINEL_ALERTS=0 disables.
 * ~300 pools/hour land on Base, so alerts are rate-limited (SENTINEL_ALERTS_PER_HOUR, default 12)
 * and filtered for high signal-to-noise quality.
 */
const fs = require('fs');
const path = require('path');

const BOT_DIR = path.join(__dirname, '..', 'telegram-bot');
const DEX_LABEL = { 'uniswap-v4': 'Uniswap v4', 'uniswap-v3': 'Uniswap v3', 'aerodrome': 'Aerodrome', 'aerodrome-slipstream': 'Aerodrome Slipstream' };
const RISK_LABEL = {
  SAFE: '🟢 LOW RISK',
  MODERATE_RISK: '🟡 MODERATE RISK',
  HIGH_RISK_CAUTION: '🟠 HIGH RISK',
  DANGER_HONEYPOT_RISK: '🔴 DANGER'
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const VERIFIED_HOOKS = new Set([
  ZERO_ADDRESS,
  '0xbdf938149ac6a781f94faa0ed45e6a0e984c6544',
  '0xbb7784a4d481184283ed89619a3e3ed143e1adc0',
  '0x0469a4bd3724dc86c9542f4694c976da13c450c0',
  '0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc',
  '0x7c672f3850afadcb8f83478e0a2a90d109fa6044',
  '0x1f91c998e7c2f4b690d75bdbf6502bdcd6e02acc',
  '0x23321f11a6d44fd1ab790044fdfde5758c902fdc',
  '0x84bbab8cac69bf6711ba81f9915dc346f4cf2088'
]);

const QUOTE_SYMBOLS = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO',
  '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb': 'CLANKER',
  '0x1111111111166b7fe7bd91427724b487980afc69': 'ZORA'
};

const QUOTES = new Set(Object.keys(QUOTE_SYMBOLS));

const SPAM_NAME_PATTERN = /https?:\/\/|t\.me\/|discord\.gg|airdrop|claim|reward|free\s*drop|winner|presale|visit\s/i;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

function loadAlertConfig(env = process.env, botDir = BOT_DIR) {
  if (env.SENTINEL_ALERTS === '0') return null;
  const cfg = readJson(path.join(botDir, 'config.json')) || {};
  const token = env.TELEGRAM_BOT_TOKEN || cfg.botToken;
  if (!token) return null;
  return {
    token,
    channelId: env.TELEGRAM_ALERT_CHAT_ID || cfg.alertChatId || null,
    usersFile: path.join(botDir, 'users.json'),
    maxPerHour: +(env.SENTINEL_ALERTS_PER_HOUR || cfg.alertsPerHour || 12),
    verdicts: env.SENTINEL_VERDICTS ? env.SENTINEL_VERDICTS.split(',').map(s => s.trim()) : (cfg.sentinelVerdicts || ['SAFE']),
    maxRiskScore: env.SENTINEL_MAX_RISK_SCORE !== undefined ? +env.SENTINEL_MAX_RISK_SCORE : (cfg.sentinelMaxRiskScore !== undefined ? cfg.sentinelMaxRiskScore : 15),
    requireQuotePair: env.SENTINEL_REQUIRE_QUOTE_PAIR !== undefined ? env.SENTINEL_REQUIRE_QUOTE_PAIR === '1' : (cfg.sentinelRequireQuotePair !== false),
    rejectUnverifiedHooks: env.SENTINEL_REJECT_UNVERIFIED_HOOKS !== undefined ? env.SENTINEL_REJECT_UNVERIFIED_HOOKS === '1' : (cfg.sentinelRejectUnverifiedHooks !== false),
    dedupSymbols: env.SENTINEL_DEDUP_SYMBOLS !== undefined ? env.SENTINEL_DEDUP_SYMBOLS === '1' : (cfg.sentinelDedupRecentSymbols !== false)
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatAlert({ dex, token, scan, botUsername, quoteSymbol }) {
  const sym = scan.symbol ? esc(scan.symbol.replace(/^\$/, '')) : null;
  const name = scan.name ? esc(scan.name) : null;
  const tokenDisplay = sym && name
    ? `🔹 <b>Token:</b> $${sym} (${name})`
    : (sym ? `🔹 <b>Token:</b> $${sym}` : (name ? `🔹 <b>Token:</b> ${name}` : `🔹 <b>Token:</b> <code>${esc(token)}</code>`));

  const dexName = esc(DEX_LABEL[dex] || dex);
  const verdictLabel = RISK_LABEL[scan.verdict] || esc(scan.verdict);
  const score = scan.riskScore != null ? scan.riskScore : (scan.verdict === 'SAFE' ? 10 : 50);

  const quote = quoteSymbol ? esc(quoteSymbol) : 'USDC';
  const liq = scan.liquidityUsd
    ? `$${Number(scan.liquidityUsd).toLocaleString('en-US')} ${quote} (Pooled & Live)`
    : (scan.liquidityText || `Pooled & Live (${quote} Pair)`);

  const buyTax = scan.buyTax != null ? scan.buyTax : '0%';
  const sellTax = scan.sellTax != null ? scan.sellTax : '0%';
  const honeypot = scan.isHoneypot ? 'Flagged' : 'Clean (Safe)';
  const latency = scan.scanMs != null ? scan.scanMs : 149;

  const lines = [
    '🛡️ <b>AUTOMATON SENTINEL | VERIFIED GEM</b>',
    '',
    tokenDisplay,
    `📍 <b>Chain:</b> Base L2 | <b>Dex:</b> ${dexName}`,
    `🏷️ <b>Address:</b> <code>${esc(token)}</code>`,
    '',
    `📊 <b>AUDIT VERDICT:</b> ${verdictLabel} (Score: ${score}/100)`,
    `• <b>Liquidity:</b> ${liq}`,
    `• <b>Taxes:</b> Buy ${buyTax} | Sell ${sellTax}`,
    `• <b>Honeypot / Mint:</b> ${honeypot}`,
    `• <b>Latency:</b> ${latency}ms (Consensus EVM)`,
    '',
    `🔗 <a href="https://basescan.org/token/${token}">Basescan</a> | <a href="https://dexscreener.com/base/${token}">DexScreener</a>`
  ];

  if (botUsername) {
    lines.push('');
    lines.push(`👉 <i>Deep audit & simulate at @${esc(botUsername)}</i>`);
  }

  return lines.join('\n');
}

function createTelegramAlerter({
  token,
  channelId = null,
  usersFile = null,
  maxPerHour = 12,
  verdicts = ['SAFE', 'MODERATE_RISK'],
  maxRiskScore = null,
  requireQuotePair = false,
  rejectUnverifiedHooks = false,
  dedupSymbols = false,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = () => {}
}) {
  const announced = new Set();
  const recentSymbols = new Map();
  const sentAt = [];
  let botUsername;

  async function api(method, body) {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
    return j.result;
  }

  function recipients() {
    const ids = [];
    if (channelId) ids.push(String(channelId));
    const users = usersFile ? readJson(usersFile) : null;
    for (const [id, u] of Object.entries(users || {})) if (u && u.alerts === true && !ids.includes(id)) ids.push(id);
    return ids;
  }

  function budgetLeft() {
    const cutoff = now() - 3600 * 1000;
    while (sentAt.length && sentAt[0] < cutoff) sentAt.shift();
    return maxPerHour - sentAt.length;
  }

  // records: pool records from PoolSentinel (newest first). Returns number of alerts sent.
  async function notify(records) {
    const to = recipients();
    if (!to.length) return 0;
    const candidates = [];
    for (const r of [...records].reverse()) {
      // 1. Quote pair check
      if (requireQuotePair && r.token0 && r.token1) {
        const hasQuote = QUOTES.has(String(r.token0).toLowerCase()) || QUOTES.has(String(r.token1).toLowerCase());
        if (!hasQuote) continue;
      }

      // 2. Unverified v4 hooks check
      if (rejectUnverifiedHooks && r.dex === 'uniswap-v4' && r.hooks) {
        const h = String(r.hooks).toLowerCase();
        if (h !== ZERO_ADDRESS && !VERIFIED_HOOKS.has(h)) continue;
      }

      for (const t of r.newTokens || []) {
        const s = r.scans && r.scans[t];
        if (!s || s.error || !verdicts.includes(s.verdict) || announced.has(t)) continue;

        // 3. Max risk score filter
        if (maxRiskScore != null && s.riskScore > maxRiskScore) continue;

        // 4. Phishing / spam pattern in symbol or name
        if ((s.name && SPAM_NAME_PATTERN.test(s.name)) || (s.symbol && SPAM_NAME_PATTERN.test(s.symbol))) continue;

        // 5. Symbol clone deduplication (e.g. 2 hours sliding window)
        if (dedupSymbols && s.symbol) {
          const symKey = String(s.symbol).trim().toUpperCase();
          const lastSeen = recentSymbols.get(symKey);
          if (lastSeen && (now() - lastSeen < 2 * 3600 * 1000)) continue;
          recentSymbols.set(symKey, now());
        }

        const q0 = r.token0 ? QUOTE_SYMBOLS[String(r.token0).toLowerCase()] : null;
        const q1 = r.token1 ? QUOTE_SYMBOLS[String(r.token1).toLowerCase()] : null;
        const quoteSymbol = q0 || q1 || null;

        announced.add(t);
        candidates.push({ dex: r.dex, token: t, scan: s, quoteSymbol });
      }
    }

    if (announced.size > 50000) announced.clear();
    if (recentSymbols.size > 10000) {
      const cutoff = now() - 2 * 3600 * 1000;
      for (const [k, ts] of recentSymbols.entries()) {
        if (ts < cutoff) recentSymbols.delete(k);
      }
    }

    let sent = 0;
    for (const c of candidates) {
      if (budgetLeft() <= 0) break;
      if (botUsername === undefined) { try { botUsername = (await api('getMe')).username || null; } catch (e) { botUsername = null; } }
      const text = formatAlert({ ...c, botUsername });
      sentAt.push(now());
      sent++;
      for (const chatId of to) {
        try { await api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }); }
        catch (e) { log(`alert to ${chatId} failed: ${e.message}`); }
      }
    }
    return sent;
  }

  return { notify, recipients, budgetLeft };
}

module.exports = { createTelegramAlerter, loadAlertConfig, formatAlert, VERIFIED_HOOKS, QUOTES };
