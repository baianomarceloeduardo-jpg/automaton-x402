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

const { createClaimVerifier, UsedTxStore, REASON_PT } = require('./claim-verifier.js');

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
      `<i>Pre-Flight Security, Honeypot Scanner & Tx Simulation na Base L2</i>\n\n` +
      `Operado pelo agente soberano <b>Automaton-Sovereign</b> (ERC-8004 #95791).\n\n` +
      `<b>Comandos Disponíveis:</b>\n` +
      `🔍 <code>/scan &lt;endereço_do_token&gt;</code> - Analisa se o token é honeypot, taxa de venda e armadilhas.\n` +
      `⚡ <code>/simulate &lt;to&gt; [data]</code> - Dry-run de transação via RPC Base para prever reverts.\n` +
      `💎 <code>/pass</code> - Obtenha acesso VIP ilimitado por 30 dias em USDC.\n` +
      `📊 <code>/pricing</code> - Tabela de preços e auditoria da tesouraria on-chain.\n` +
      `🔔 <code>/alertas on</code> - Receba novos tokens da Base auditados pelo Sentinel.\n` +
      `ℹ️ <code>/help</code> - Mais informações sobre o motor de segurança.\n\n` +
      `<i>Status do seu plano:</i> ${user.isVip ? '🌟 <b>VIP Ilimitado</b>' : `🆓 <b>Plano Gratuito</b> (${config.freeDailyLimit - user.freeUsedToday}/${config.freeDailyLimit} consultas restantes hoje)`}`;
    await bot.sendMessage(chatId, welcome);
    return;
  }

  // Command: /help
  if (text.startsWith('/help')) {
    const help = `📖 <b>Como Usar o Automaton Sentinel:</b>\n\n` +
      `1. <b>Auditoria Anti-Honeypot:</b>\n` +
      `Envie <code>/scan 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</code> ou simplesmente cole qualquer endereço de contrato da Base.\n\n` +
      `2. <b>Simulação de Transação:</b>\n` +
      `Envie <code>/simulate 0x... 0x18160ddd</code> para testar a chamada sem gastar gás nem assinar na carteira.\n\n` +
      `3. <b>Precisão On-Chain:</b>\n` +
      `Nossos relatórios desmontam o bytecode EVM diretamente na blockchain Base e emitem atestados assinados por ECDSA P-256.`;
    await bot.sendMessage(chatId, help);
    return;
  }

  // Command: /pricing
  if (text.startsWith('/pricing')) {
    const pricing = `💰 <b>Tabela de Preços & Infraestrutura:</b>\n\n` +
      `• <b>Consultas pelo Telegram:</b> 3 grátis/dia\n` +
      `• <b>Passe VIP (30 dias ilimitado):</b> ${config.vipPriceUsdc.toFixed(2)} USDC na Base\n` +
      `• <b>API Direta para Agentes (x402):</b> 0.002 USDC/scan (EIP-3009 sem gás)\n\n` +
      `<b>Carteira Oficial da Tesouraria (Base L2):</b>\n` +
      `<code>${config.treasuryAddress}</code>\n` +
      `<a href="https://basescan.org/address/${config.treasuryAddress}">Ver no Basescan ↗</a>`;
    await bot.sendMessage(chatId, pricing);
    return;
  }

  // Command: /pass
  if (text.startsWith('/pass')) {
    const passMsg = `🌟 <b>Upgrade para Automaton VIP:</b>\n\n` +
      `Garanta análises ilimitadas de contratos e simulações para negociar com máxima segurança na Base.\n\n` +
      `<b>Valor:</b> <code>${config.vipPriceUsdc.toFixed(2)} USDC</code> (Rede Base)\n` +
      `<b>Duração:</b> 30 dias de acesso instantâneo\n\n` +
      `<b>Instruções de Pagamento:</b>\n` +
      `1. Transfira <b>${config.vipPriceUsdc.toFixed(2)} USDC</b> na rede <b>Base</b> para o endereço:\n` +
      `<code>${config.treasuryAddress}</code>\n\n` +
      `2. Envie o hash da transação aqui com o comando:\n` +
      `<code>/claim &lt;tx_hash&gt;</code>\n\n` +
      `<i>O validador on-chain do Automaton confirmará os blocos e ativará seu passe automaticamente em segundos!</i>`;
    await bot.sendMessage(chatId, passMsg);
    return;
  }

  // Command: /claim <txHash>
  if (text.startsWith('/claim')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2 || !/^0x[a-fA-F0-9]{64}$/.test(parts[1])) {
      await bot.sendMessage(chatId, '❌ <b>Formato inválido.</b> Use: <code>/claim 0xSeuHashDeTransacao</code>');
      return;
    }
    const txHash = parts[1];
    await bot.sendMessage(chatId, `⏳ <i>Verificando transação ${txHash.slice(0, 10)}... na Base...</i>`);
    
    const v = await claimVerifier.verify(txHash);
    if (v.ok) {
      user.isVip = true;
      const exp = new Date();
      exp.setDate(exp.getDate() + config.vipPassDurationDays);
      user.vipUntil = exp.toISOString();
      user.vipTx = txHash.toLowerCase();
      saveUsers();
      console.log(`[CLAIM] VIP activated chat=${chatId} tx=${txHash} units=${v.amountUnits}`);
      await bot.sendMessage(chatId, `🎉 <b>Pagamento Confirmado na Base!</b>\n${(Number(v.amountUnits) / 1e6).toFixed(2)} USDC recebidos. Seu passe VIP está ativo até <b>${exp.toLocaleDateString()}</b>.`);
    } else {
      console.log(`[CLAIM] rejected chat=${chatId} tx=${txHash} reason=${v.reason}`);
      const received = (Number(v.amountUnits || 0) / 1e6).toFixed(6).replace(/\.?0+$/, '');
      const extra = v.reason === 'insufficient_amount' ? ` Recebido: ${received} USDC; mínimo ${config.vipPriceUsdc.toFixed(2)} USDC.` : '';
      await bot.sendMessage(chatId, `⚠️ <b>Pagamento não aceito:</b> ${REASON_PT[v.reason] || v.reason}${extra}`);
    }
    return;
  }

  // Command: /alertas on|off — opt-in to Pool Sentinel new-token alerts
  if (text.startsWith('/alertas') || text.startsWith('/alerts')) {
    const arg = (text.split(/\s+/)[1] || '').toLowerCase();
    if (arg === 'on' || arg === 'off') {
      user.alerts = arg === 'on';
      saveUsers();
    }
    await bot.sendMessage(chatId, user.alerts
      ? '🔔 <b>Alertas do Sentinel ativados.</b> Você receberá novos tokens da Base auditados pelo Automaton (limite por hora). Desative com <code>/alertas off</code>.'
      : '🔕 <b>Alertas do Sentinel desativados.</b> Ative com <code>/alertas on</code>.');
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
      await bot.sendMessage(chatId, '❌ <b>Endereço inválido.</b> Forneça um contrato válido da Base no formato <code>0x...</code> (42 caracteres).');
      return;
    }

    // Check usage limits
    if (!user.isVip && user.freeUsedToday >= config.freeDailyLimit) {
      await bot.sendMessage(chatId, `🚫 <b>Limite diário gratuito atingido (${config.freeDailyLimit}/${config.freeDailyLimit}).</b>\n\n` +
        `Para continuar analisando contratos ilimitadamente, ative seu passe VIP por apenas ${config.vipPriceUsdc} USDC com o comando <code>/pass</code>.`);
      return;
    }

    await bot.sendMessage(chatId, `🔍 <i>Desmontando bytecode e auditando ${targetAddress.slice(0, 8)}... na Base L2...</i>`);

    try {
      const result = await scanTokenAddress(targetAddress);
      user.freeUsedToday++;
      saveUsers();

      const riskScore = result.riskScore !== undefined ? result.riskScore : (result.score || 0);
      const isSafe = riskScore < 30;
      const statusIcon = isSafe ? '🟢 <b>BAIXO RISCO (APROVADO)</b>' : (riskScore < 70 ? '🟡 <b>MÉDIO RISCO (ATENÇÃO)</b>' : '🔴 <b>ALTO RISCO / PERIGO</b>');

      let response = `🛡️ <b>RELATÓRIO DE AUDITORIA EVM</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📍 <b>Contrato:</b> <code>${targetAddress}</code>\n` +
        (result.knownAsset ? `🏷️ <b>Ativo:</b> ${result.knownAsset.name} ($${result.knownAsset.symbol})\n` : '') +
        `📊 <b>Veredito:</b> ${statusIcon}\n` +
        `🎯 <b>Score de Risco:</b> <code>${riskScore}/100</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<b>Verificações de Segurança:</b>\n`;

      const checks = result.checks || result.details || {};
      response += `• Bytecode presente: ${checks.hasBytecode ? '✅ Sim' : '❌ Não'}\n`;
      response += `• Padrão ERC-20: ${(checks.isErc20Compliant || checks.isErc20) ? '✅ Detectado' : '⚠️ Não padrão'}\n`;
      response += `• Armadilha de Mint Oculto: ${checks.hasMintFunction ? '⚠️ Presente' : '✅ Ausente'}\n`;
      response += `• Risco de Honeypot / Taxa: ${result.isHoneypot ? '🚨 <b>ALERTA HONEYPOT 99%</b>' : (checks.hasTaxConfig ? '⚠️ Taxa configurável' : '✅ Normal')}\n`;
      response += `• Funções de Blacklist / Pausa: ${(checks.hasBlacklistFunction || checks.hasPauseFunction) ? '⚠️ Presente' : '✅ Não detectada'}\n`;
      response += `• Self-Destruct / Destrutivo: ${checks.hasSelfDestruct ? '🚨 <b>SIM</b>' : '✅ Não'}\n`;

      if (result.flags && result.flags.length > 0) {
        response += `\n⚠️ <b>Sinalizadores Detectados:</b> <code>${result.flags.join(', ')}</code>\n`;
      }

      response += `\n🔗 <a href="https://basescan.org/address/${targetAddress}">Basescan</a> | ` +
        `<a href="https://dexscreener.com/base/${targetAddress}">DexScreener</a>\n\n` +
        `<i>Consultas restantes hoje: ${user.isVip ? 'Ilimitado (VIP)' : `${config.freeDailyLimit - user.freeUsedToday}/${config.freeDailyLimit}`}</i>`;

      await bot.sendMessage(chatId, response);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ <b>Falha ao escanear contrato:</b> ${err.message}`);
    }
    return;
  }

  // Command: /simulate <to> [data]
  if (text.startsWith('/simulate')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2 || !/^0x[a-fA-F0-9]{40}$/.test(parts[1])) {
      await bot.sendMessage(chatId, '❌ <b>Uso:</b> <code>/simulate &lt;0xContrato&gt; [0xCalldata]</code>');
      return;
    }
    const to = parts[1];
    const data = parts[2] || '0x';

    await bot.sendMessage(chatId, `⚡ <i>Executando dry-run via RPC Base Mainnet...</i>`);
    try {
      const sim = await simulateTransaction(to, data);
      let simMsg = `⚡ <b>RESULTADO DO DRY-RUN (SIMULAÇÃO)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📍 <b>Destino:</b> <code>${to}</code>\n` +
        `🧪 <b>Calldata:</b> <code>${data.slice(0, 20)}${data.length > 20 ? '...' : ''}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (sim.willRevert) {
        simMsg += `🚨 <b>PREVISÃO: A TRANSAÇÃO VAI REVERTER!</b>\n` +
          `❌ <b>Motivo do Revert:</b> <code>${sim.revertReason || 'Reversão sem mensagem'}</code>\n\n` +
          `<i>Economia: Você evitou gastar gás e travar nonce em uma transação com falha certa.</i>`;
      } else {
        simMsg += `✅ <b>PREVISÃO: SUCESSO!</b>\n` +
          `⛽ <b>Gás Estimado:</b> <code>${sim.estimatedGas || 'Padrão'} wei</code>\n` +
          `📤 <b>Retorno:</b> <code>${(sim.returnData || '0x').slice(0, 30)}...</code>`;
      }
      await bot.sendMessage(chatId, simMsg);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ <b>Erro na simulação:</b> ${err.message}`);
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
