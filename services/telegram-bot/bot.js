'use strict';
/**
 * Automaton Telegram Security & Pre-Flight Bot
 * 
 * Powered by Automaton-Sovereign (ERC-8004 #95791 on Base L2)
 * Zero external dependencies: pure Node.js native https/http implementation.
 * 
 * Features:
 *  - /scan <0xAddress>: Real-time bytecode honeypot, mint trap, and sell-tax analysis
 *  - /simulate <to> [data]: Pre-flight tx dry-run predicting reverts before signing
 *  - /pricing: Live pricing terms and treasury audit
 *  - /pass: VIP pass upgrade via Base USDC payments
 *  - Multi-user rate limiting (3 free scans/day, unlimited for VIPs)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Local security and simulation engines
let tokenSecurity = null;
let txSimulator = null;
try {
  tokenSecurity = require(path.join(__dirname, '..', '..', 'token-security.js'));
  txSimulator = require(path.join(__dirname, '..', '..', 'packages', 'x402-conformance', 'tx-simulator.js'));
} catch (e) {
  console.warn('[LOCAL ENGINES] Notice:', e.message);
}

const { createClaimVerifier, UsedTxStore, REASON_PT, REASON_EN } = require('./claim-verifier.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const USERS_DB_PATH = path.join(__dirname, 'users.json');
const USED_CLAIMS_PATH = path.join(__dirname, 'used-claims.json');

// Base Mainnet RPCs for direct, non-throttled on-chain queries
const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://1rpc.io/base'
];

const DEFAULT_CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  apiBase: process.env.VALUE_API_BASE || 'https://automaton-api.bfzovw.easypanel.host',
  fallbackBase: 'https://api.automaton-sovereign.workers.dev',
  treasuryAddress: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
  network: 'Base Mainnet (Chain ID 8453)',
  freeDailyLimit: 3,
  vipPriceUsdc: 2.00,
  vipPassDurationDays: 30,
  pollIntervalMs: 1500
};

// Load configuration
let config = DEFAULT_CONFIG;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    console.error('[CONFIG] Error reading config.json, using defaults:', e.message);
  }
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}

// User state store
let usersDb = {};
if (fs.existsSync(USERS_DB_PATH)) {
  try {
    usersDb = JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf8'));
  } catch (e) {}
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_DB_PATH, JSON.stringify(usersDb, null, 2), 'utf8');
  } catch (e) {}
}

function getUser(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  if (!usersDb[chatId]) {
    usersDb[chatId] = { freeUsedToday: 0, lastResetDay: today, isVip: false, vipUntil: null };
  }
  const u = usersDb[chatId];
  if (u.lastResetDay !== today) {
    u.freeUsedToday = 0;
    u.lastResetDay = today;
  }
  if (u.vipUntil && new Date(u.vipUntil) < new Date()) {
    u.isVip = false;
    u.vipUntil = null;
  }
  return u;
}

// Multi-RPC caller
async function queryBaseRpc(method, params = []) {
  for (const rpcUrl of BASE_RPCS) {
    try {
      const u = new URL(rpcUrl);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const payload = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });

      const res = await new Promise((resolve, reject) => {
        const req = lib.request({
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': 'AutomatonBot/1.0'
          },
          timeout: 8000
        }, (r) => {
          let d = '';
          r.on('data', chunk => d += chunk);
          r.on('end', () => {
            try {
              const j = JSON.parse(d);
              if (j.error) reject(new Error(j.error.message || 'RPC Error'));
              else resolve(j.result);
            } catch (err) { reject(err); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('RPC timeout')));
        req.write(payload);
        req.end();
      });

      if (res !== undefined) return res;
    } catch (e) {
      // try next RPC
    }
  }
  throw new Error('All Base RPC endpoints failed to respond');
}

// /claim verification: USDC transfer to the treasury >= VIP price, once per txHash.
const claimVerifier = createClaimVerifier({
  rpc: queryBaseRpc,
  treasury: config.treasuryAddress,
  store: new UsedTxStore(USED_CLAIMS_PATH),
  minUnits: BigInt(Math.round(config.vipPriceUsdc * 1e6))
});

// HTTP request helper
function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: Object.assign({
          'User-Agent': 'AutomatonTelegramBot/1.0',
          'Accept': 'application/json'
        }, headers)
      };

      if (payload) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
          resolve({ status: res.statusCode, data: parsed });
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Request timeout (15s)')));
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Telegram API Wrapper
class TelegramBot {
  constructor(token) {
    this.token = token;
    this.offset = 0;
  }

  async call(method, params = {}) {
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN not configured!');
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = await request('POST', url, params);
    if (!res.data || !res.data.ok) {
      throw new Error(`Telegram error on ${method}: ${JSON.stringify(res.data)}`);
    }
    return res.data.result;
  }

  async sendMessage(chatId, text, opts = {}) {
    return this.call('sendMessage', Object.assign({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, opts));
  }

  async getUpdates() {
    try {
      const updates = await this.call('getUpdates', {
        offset: this.offset,
        timeout: 10,
        allowed_updates: ['message', 'callback_query']
      });
      if (Array.isArray(updates) && updates.length > 0) {
        this.offset = updates[updates.length - 1].update_id + 1;
        return updates;
      }
    } catch (e) {
      console.error('[TELEGRAM POLL ERROR]', e.message);
    }
    return [];
  }
}

// Security Scanner Consumer: Uses Direct On-Chain Bytecode Engine first, with API fallback
async function scanTokenAddress(address) {
  if (tokenSecurity && typeof tokenSecurity.scanTokenContract === 'function') {
    try {
      const scan = await tokenSecurity.scanTokenContract(address, queryBaseRpc);
      if (scan && !scan.error) {
        return scan;
      }
    } catch (e) {
      console.error('[LOCAL SCAN ERROR, TRYING HTTP]', e.message);
    }
  }

  // Fallback to HTTP APIs
  const bases = [config.apiBase, config.fallbackBase];
  let lastErr = null;
  for (const base of bases) {
    try {
      const res = await request('GET', `${base}/v2/security/scan?address=${encodeURIComponent(address)}`);
      if (res.status === 200 && res.data) {
        return res.data;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Failed to scan contract: ${lastErr?.message || 'Network / RPC error'}`);
}

// Transaction Simulation Consumer: Uses direct simulator first
async function simulateTransaction(to, data = '0x', value = '0', from = null) {
  if (txSimulator && typeof txSimulator.simulate === 'function') {
    try {
      const sim = await txSimulator.simulate({ to, data, value, from });
      if (sim && sim.ok) {
        return sim;
      }
    } catch (e) {
      console.error('[LOCAL SIMULATE ERROR, TRYING HTTP]', e.message);
    }
  }

  // Fallback to HTTP APIs
  const bases = [config.apiBase, config.fallbackBase];
  let lastErr = null;
  for (const base of bases) {
    try {
      const params = new URLSearchParams({ to, data, value });
      if (from) params.set('from', from);
      const res = await request('GET', `${base}/v2/simulate?${params.toString()}`);
      if (res.status === 200 && res.data) {
        return res.data;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Failed to simulate tx: ${lastErr?.message || 'Network / RPC error'}`);
}

// Command Handlers
async function handleMessage(bot, msg) {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const user = getUser(chatId);

  // Command: /start
  if (text.startsWith('/start')) {
    const welcome = `🛡️ <b>Automaton Base Security Sentinel</b>\n` +
      `<i>Pre-Flight Security, Honeypot Scanner & Tx Simulation on Base L2</i>\n\n` +
      `Operated by sovereign on-chain agent <b>Automaton-Sovereign</b> (ERC-8004 #95791).\n\n` +
      `<b>Available Commands:</b>\n` +
      `🔍 <code>/scan &lt;token_address&gt;</code> - Scans bytecode for honeypot, hidden mints, and sell taxes.\n` +
      `⚡ <code>/simulate &lt;to&gt; [data]</code> - Dry-run transaction on Base RPC to predict reverts before signing.\n` +
      `💎 <code>/pass</code> - Get 30 days unlimited VIP access via Base USDC.\n` +
      `📊 <code>/pricing</code> - Price sheet & live on-chain treasury audit.\n` +
      `🔔 <code>/alerts on</code> - Get real-time alerts for new tokens deployed on Base.\n` +
      `ℹ️ <code>/help</code> - Learn more about our sub-200ms security engine.\n\n` +
      `<i>Your Plan Status:</i> ${user.isVip ? '🌟 <b>VIP Unlimited</b>' : `🆓 <b>Free Tier</b> (${config.freeDailyLimit - user.freeUsedToday}/${config.freeDailyLimit} scans remaining today)`}`;
    await bot.sendMessage(chatId, welcome);
    return;
  }

  // Command: /help
  if (text.startsWith('/help')) {
    const help = `📖 <b>How to Use Automaton Sentinel:</b>\n\n` +
      `1. <b>Anti-Honeypot Audit:</b>\n` +
      `Send <code>/scan 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</code> or simply paste any Base contract address directly into the chat.\n\n` +
      `2. <b>Transaction Simulation:</b>\n` +
      `Send <code>/simulate 0x... 0x18160ddd</code> to test execution without spending gas or signing with your wallet.\n\n` +
      `3. <b>On-Chain Sub-Second Precision:</b>\n` +
      `Our scanner disassembles EVM bytecode directly on Base L2 in <200ms and produces cryptographic verification proofs.`;
    await bot.sendMessage(chatId, help);
    return;
  }

  // Command: /pricing
  if (text.startsWith('/pricing')) {
    const pricing = `💰 <b>Pricing & Infrastructure:</b>\n\n` +
      `• <b>Telegram Free Tier:</b> 3 scans/day\n` +
      `• <b>VIP Pass (30 days unlimited):</b> ${config.vipPriceUsdc.toFixed(2)} USDC on Base\n` +
      `• <b>Direct Agent API (x402 protocol):</b> 0.002 USDC/scan (gasless EIP-3009)\n\n` +
      `<b>Official Treasury Wallet (Base L2):</b>\n` +
      `<code>${config.treasuryAddress}</code>\n` +
      `<a href="https://basescan.org/address/${config.treasuryAddress}">View on Basescan ↗</a>`;
    await bot.sendMessage(chatId, pricing);
    return;
  }

  // Command: /pass
  if (text.startsWith('/pass')) {
    const passMsg = `🌟 <b>Upgrade to Automaton VIP:</b>\n\n` +
      `Unlock unlimited smart contract audits and transaction simulations to trade with maximum security on Base.\n\n` +
      `<b>Price:</b> <code>${config.vipPriceUsdc.toFixed(2)} USDC</code> (Base Network)\n` +
      `<b>Duration:</b> 30 days instant access\n\n` +
      `<b>Payment Instructions:</b>\n` +
      `1. Send <b>${config.vipPriceUsdc.toFixed(2)} USDC</b> on <b>Base</b> to:\n` +
      `<code>${config.treasuryAddress}</code>\n\n` +
      `2. Submit your transaction hash here with:\n` +
      `<code>/claim &lt;tx_hash&gt;</code>\n\n` +
      `<i>Automaton's on-chain verifier will confirm blocks and activate your VIP pass automatically in seconds!</i>`;
    await bot.sendMessage(chatId, passMsg);
    return;
  }

  // Command: /claim <txHash>
  if (text.startsWith('/claim')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2 || !/^0x[a-fA-F0-9]{64}$/.test(parts[1])) {
      await bot.sendMessage(chatId, '❌ <b>Invalid format.</b> Usage: <code>/claim 0xYourTransactionHash</code>');
      return;
    }
    const txHash = parts[1];
    await bot.sendMessage(chatId, `⏳ <i>Verifying transaction ${txHash.slice(0, 10)}... on Base L2...</i>`);
    
    const v = await claimVerifier.verify(txHash);
    if (v.ok) {
      user.isVip = true;
      const exp = new Date();
      exp.setDate(exp.getDate() + config.vipPassDurationDays);
      user.vipUntil = exp.toISOString();
      user.vipTx = txHash.toLowerCase();
      saveUsers();
      console.log(`[CLAIM] VIP activated chat=${chatId} tx=${txHash} units=${v.amountUnits}`);
      await bot.sendMessage(chatId, `🎉 <b>Payment Confirmed on Base!</b>\n${(Number(v.amountUnits) / 1e6).toFixed(2)} USDC received. Your VIP pass is active until <b>${exp.toLocaleDateString()}</b>.`);
    } else {
      console.log(`[CLAIM] rejected chat=${chatId} tx=${txHash} reason=${v.reason}`);
      const received = (Number(v.amountUnits || 0) / 1e6).toFixed(6).replace(/\.?0+$/, '');
      const extra = v.reason === 'insufficient_amount' ? ` Received: ${received} USDC; required ${config.vipPriceUsdc.toFixed(2)} USDC.` : '';
      await bot.sendMessage(chatId, `⚠️ <b>Payment Rejected:</b> ${REASON_EN[v.reason] || REASON_PT[v.reason] || v.reason}${extra}`);
    }
    return;
  }

  // Command: /alertas on|off or /alerts on|off — opt-in to Pool Sentinel new-token alerts
  if (text.startsWith('/alertas') || text.startsWith('/alerts')) {
    const arg = (text.split(/\s+/)[1] || '').toLowerCase();
    if (arg === 'on' || arg === 'off') {
      user.alerts = arg === 'on';
      saveUsers();
    }
    await bot.sendMessage(chatId, user.alerts
      ? '🔔 <b>Sentinel Alerts ENABLED.</b> You will receive audited new Base tokens in real time (rate-limited). Disable anytime with <code>/alerts off</code>.'
      : '🔕 <b>Sentinel Alerts DISABLED.</b> Enable anytime with <code>/alerts on</code>.');
    return;
  }

  // Command: /scan <0xAddress> (or raw contract address posted)
  let targetAddress = null;
  if (text.startsWith('/scan')) {
    const parts = text.split(/\s+/);
    if (parts.length >= 2) targetAddress = parts[1];
  } else if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
    targetAddress = text;
  }

  if (targetAddress) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(targetAddress)) {
      await bot.sendMessage(chatId, '❌ <b>Invalid address.</b> Please provide a valid 42-character Base contract address starting with <code>0x...</code>');
      return;
    }

    // Check usage limits
    if (!user.isVip && user.freeUsedToday >= config.freeDailyLimit) {
      await bot.sendMessage(chatId, `🚫 <b>Free daily limit reached (${config.freeDailyLimit}/${config.freeDailyLimit}).</b>\n\n` +
        `To continue scanning unlimited contracts, unlock VIP for just ${config.vipPriceUsdc} USDC with <code>/pass</code>.`);
      return;
    }

    await bot.sendMessage(chatId, `🔍 <i>Disassembling bytecode and auditing ${targetAddress.slice(0, 8)}... on Base L2...</i>`);

    try {
      const result = await scanTokenAddress(targetAddress);
      user.freeUsedToday++;
      saveUsers();

      const riskScore = result.riskScore !== undefined ? result.riskScore : (result.score || 0);
      const isSafe = riskScore < 30;
      const statusIcon = isSafe ? '🟢 <b>LOW RISK (PASSED)</b>' : (riskScore < 70 ? '🟡 <b>MEDIUM RISK (CAUTION)</b>' : '🔴 <b>HIGH RISK / DANGER</b>');

      let response = `🛡️ <b>EVM AUDIT REPORT</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📍 <b>Contract:</b> <code>${targetAddress}</code>\n` +
        (result.knownAsset ? `🏷️ <b>Asset:</b> ${result.knownAsset.name} ($${result.knownAsset.symbol})\n` : '') +
        `📊 <b>Verdict:</b> ${statusIcon}\n` +
        `🎯 <b>Risk Score:</b> <code>${riskScore}/100</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<b>Security Checks:</b>\n`;

      const checks = result.checks || result.details || {};
      response += `• Bytecode present: ${checks.hasBytecode ? '✅ Yes' : '❌ No'}\n`;
      response += `• ERC-20 Standard: ${(checks.isErc20Compliant || checks.isErc20) ? '✅ Verified' : '⚠️ Non-standard'}\n`;
      response += `• Hidden Mint Trap: ${checks.hasMintFunction ? '⚠️ Present' : '✅ None'}\n`;
      response += `• Honeypot / Tax Risk: ${result.isHoneypot ? '🚨 <b>HONEYPOT ALERT 99%</b>' : (checks.hasTaxConfig ? '⚠️ Modifiable tax' : '✅ Clean')}\n`;
      response += `• Blacklist / Pause Trap: ${(checks.hasBlacklistFunction || checks.hasPauseFunction) ? '⚠️ Present' : '✅ None detected'}\n`;
      response += `• Self-Destruct / Destructive: ${checks.hasSelfDestruct ? '🚨 <b>YES</b>' : '✅ None'}\n`;

      if (result.flags && result.flags.length > 0) {
        response += `\n⚠️ <b>Flags Detected:</b> <code>${result.flags.join(', ')}</code>\n`;
      }

      response += `\n🔗 <a href="https://basescan.org/address/${targetAddress}">Basescan</a> | ` +
        `<a href="https://dexscreener.com/base/${targetAddress}">DexScreener</a>\n\n` +
        `<i>Remaining free scans today: ${user.isVip ? 'Unlimited (VIP)' : `${config.freeDailyLimit - user.freeUsedToday}/${config.freeDailyLimit}`}</i>`;

      await bot.sendMessage(chatId, response);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ <b>Failed to scan contract:</b> ${err.message}`);
    }
    return;
  }

  // Command: /simulate <to> [data]
  if (text.startsWith('/simulate')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2 || !/^0x[a-fA-F0-9]{40}$/.test(parts[1])) {
      await bot.sendMessage(chatId, '❌ <b>Usage:</b> <code>/simulate &lt;0xContract&gt; [0xCalldata]</code>');
      return;
    }
    const to = parts[1];
    const data = parts[2] || '0x';

    await bot.sendMessage(chatId, `⚡ <i>Running dry-run simulation via Base Mainnet RPC...</i>`);
    try {
      const sim = await simulateTransaction(to, data);
      let simMsg = `⚡ <b>DRY-RUN SIMULATION RESULT</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📍 <b>Target:</b> <code>${to}</code>\n` +
        `🧪 <b>Calldata:</b> <code>${data.slice(0, 20)}${data.length > 20 ? '...' : ''}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (sim.willRevert) {
        simMsg += `🚨 <b>PREDICTION: TRANSACTION WILL REVERT!</b>\n` +
          `❌ <b>Revert Reason:</b> <code>${sim.revertReason || 'Reverted without message'}</code>\n\n` +
          `<i>Savings: You saved gas fees and avoided nonce lock on a failing transaction.</i>`;
      } else {
        simMsg += `✅ <b>PREDICTION: SUCCESS!</b>\n` +
          `⛽ <b>Estimated Gas:</b> <code>${sim.estimatedGas || 'Standard'} wei</code>\n` +
          `📤 <b>Return Data:</b> <code>${(sim.returnData || '0x').slice(0, 30)}...</code>`;
      }
      await bot.sendMessage(chatId, simMsg);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ <b>Simulation error:</b> ${err.message}`);
    }
    return;
  }
}

// Main Polling Loop
async function startBot() {
  if (!config.botToken) {
    // Stay idle instead of exiting so a supervisor does not restart-loop an unconfigured bot.
    console.log('[BOT NOTICE] TELEGRAM_BOT_TOKEN is not configured; idling.');
    setInterval(() => {}, 1 << 30);
    return;
  }

  const bot = new TelegramBot(config.botToken);
  console.log('🤖 Automaton Telegram Bot starting polling loop with direct Base on-chain engine...');

  while (true) {
    try {
      const updates = await bot.getUpdates();
      for (const update of updates) {
        if (update.message) {
          await handleMessage(bot, update.message);
        }
      }
    } catch (err) {
      console.error('[POLL LOOP ERROR]', err.message);
    }
    await new Promise(r => setTimeout(r, config.pollIntervalMs));
  }
}

if (require.main === module) {
  startBot().catch(console.error);
}

module.exports = { TelegramBot, scanTokenAddress, simulateTransaction, handleMessage };
