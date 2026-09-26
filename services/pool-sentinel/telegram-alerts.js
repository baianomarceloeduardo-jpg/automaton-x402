'use strict';
/**
 * Optional Telegram broadcast of new-token alerts from the Pool Sentinel.
 *
 * Recipients (opt-in only): the channel/chat in TELEGRAM_ALERT_CHAT_ID or config.alertChatId,
 * plus bot users who sent `/alertas on` (users.json entries with alerts: true).
 * Token: TELEGRAM_BOT_TOKEN or services/telegram-bot/config.json botToken. SENTINEL_ALERTS=0 disables.
 * ~300 pools/hour land on Base, so alerts are rate-limited (SENTINEL_ALERTS_PER_HOUR, default 12)
 * and each token is announced once.
 */
const fs = require('fs');
const path = require('path');

const BOT_DIR = path.join(__dirname, '..', 'telegram-bot');
const DEX_LABEL = { 'uniswap-v4': 'Uniswap v4', 'uniswap-v3': 'Uniswap v3', 'aerodrome': 'Aerodrome', 'aerodrome-slipstream': 'Aerodrome Slipstream' };
const RISK_LABEL = { SAFE: 'BAIXO', MODERATE_RISK: 'MODERADO' };

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
    maxPerHour: +(env.SENTINEL_ALERTS_PER_HOUR || cfg.alertsPerHour || 12)
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatAlert({ dex, token, scan, botUsername }) {
  return [
    '🚨 <b>Novo Token Detectado na Base</b>',
    `Dex: ${esc(DEX_LABEL[dex] || dex)}`,
    `Token: <code>${esc(token)}</code>`,
    `Risco: ${RISK_LABEL[scan.verdict] || esc(scan.verdict)} (score ${scan.riskScore}/100)`,
    `Auditado em ${scan.scanMs}ms pelo Automaton Sentinel.`,
    `<a href="https://basescan.org/token/${token}">Basescan</a> | <a href="https://dexscreener.com/base/${token}">DexScreener</a>`,
    '<i>Análise estática de bytecode: não detecta rug de liquidez nem é recomendação de compra.</i>',
    botUsername ? `👉 Analise a fundo no @${esc(botUsername)}` : null
  ].filter(Boolean).join('\n');
}

function createTelegramAlerter({ token, channelId = null, usersFile = null, maxPerHour = 12, verdicts = ['SAFE', 'MODERATE_RISK'],
  fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
  const announced = new Set();
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
      for (const t of r.newTokens || []) {
        const s = r.scans && r.scans[t];
        if (!s || s.error || !verdicts.includes(s.verdict) || announced.has(t)) continue;
        announced.add(t);
        candidates.push({ dex: r.dex, token: t, scan: s });
      }
    }
    if (announced.size > 50000) announced.clear();
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

module.exports = { createTelegramAlerter, loadAlertConfig, formatAlert };
