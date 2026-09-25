/**
 * Automaton-Sovereign: Automated Social Broadcast Dispatcher
 * Periodically generates signed bulletins of Base L2 metrics,
 * archives them to broadcast_history.jsonl, and maintains an active syndication feed.
 */

const fs = require('fs');
const path = require('path');
const { generateBasePulse } = require('./base-pulse.js');

const DIR = __dirname;
const HISTORY_FILE = path.join(DIR, 'broadcast_history.jsonl');
const DIARIO_FILE = 'C:\\Users\\marce\\Desktop\\Diario_Automaton.txt';
const INTERVAL_MS = 15 * 60 * 1000; // Every 15 minutes

async function dispatchOnce() {
  const now = new Date();
  console.log(`[Dispatcher] Generating pulse at ${now.toISOString()}...`);
  try {
    const pulse = await generateBasePulse();
    
    // 1. Append to broadcast history
    const entry = JSON.stringify({
      timestamp: pulse.timestamp,
      blockNumber: pulse.blockNumber,
      gasGwei: pulse.gasGwei,
      spotlight: pulse.spotlightToken,
      farcaster: pulse.broadcasts.farcaster,
      twitter: pulse.broadcasts.twitter,
      signatureHash: pulse.signatureHash,
      signature: pulse.signature
    });
    fs.appendFileSync(HISTORY_FILE, entry + '\n');
    console.log(`[Dispatcher] Saved pulse to history. Block: ${pulse.blockNumber}, Gas: ${pulse.gasGwei} Gwei`);

    // 2. Append note to Diario_Automaton if exists
    try {
      if (fs.existsSync(DIARIO_FILE)) {
        const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const diarioEntry = `\n[${timeStr}] [TELEMETRIA BASE] Bloco Base #${pulse.blockNumber} | Gas: ${pulse.gasGwei} Gwei | Spotlight: $${pulse.spotlightToken.symbol} (${pulse.spotlightToken.verdict}) | Assinatura ECDSA P-256 ativa.\n`;
        fs.appendFileSync(DIARIO_FILE, diarioEntry, 'utf8');
      }
    } catch (e) {
      console.warn('[Dispatcher] Could not write to Diario:', e.message);
    }

    return pulse;
  } catch (err) {
    console.error('[Dispatcher] Error generating pulse:', err);
    throw err;
  }
}

function startDispatcher(intervalMs = INTERVAL_MS) {
  console.log(`[Dispatcher] Base L2 Broadcast Dispatcher started (interval: ${intervalMs / 1000}s)`);
  // Run immediately on boot
  dispatchOnce().catch(console.error);

  // Set recurring interval
  const timer = setInterval(() => {
    dispatchOnce().catch(console.error);
  }, intervalMs);

  return timer;
}

if (require.main === module) {
  // If run standalone via CLI, start background interval
  startDispatcher();
}

module.exports = {
  dispatchOnce,
  startDispatcher,
  HISTORY_FILE
};
