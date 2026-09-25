#!/usr/bin/env node
/**
 * mockrpc.js - deterministic Base JSON-RPC mock for x402 SETTLEMENT testing.
 * Scenarios keyed by tx hash prefix:
 *   0xa1.. -> valid: status 0x1, USDC Transfer(value=1000) to payTo
 *   0xb2.. -> underpaid: Transfer(value=1) to payTo
 *   0xc3.. -> failed tx: status 0x0
 *   0xd4.. -> no matching log: status 0x1, log to a DIFFERENT recipient
 *   otherwise -> null (tx_not_found)
 * Usage: node mockrpc.js [port]
 */
'use strict';
const http = require('http');
const PORT = parseInt(process.argv[2] || '8545', 10);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAY_TO = '0x71deac098914a009e3720524642a6be6f65ee528';
const OTHER = '0x000000000000000000000000000000000000beef';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = a => '0x' + '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase();
const BLOCK = 0x1234567;
const H = '0x' + 'cd'.repeat(32);
const FROM = pad('0x' + '11'.repeat(20));

function receipt(tx) {
  const p = tx.toLowerCase().slice(2, 4);
  if (!['a1', 'b2', 'c3', 'd4'].includes(p)) return null;           // tx_not_found
  const status = p === 'c3' ? '0x0' : '0x1';
  const to = p === 'd4' ? OTHER : PAY_TO;
  const value = p === 'b2' ? 1n : 1000n;
  const log = {
    address: USDC, blockNumber: '0x' + BLOCK.toString(16), blockHash: H,
    transactionHash: tx, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    topics: [TRANSFER, FROM, pad(to)], data: '0x' + value.toString(16).padStart(64, '0')
  };
  return {
    transactionHash: tx, transactionIndex: '0x0', blockNumber: '0x' + BLOCK.toString(16), blockHash: H,
    from: FROM.replace('0'.repeat(24), ''), to: USDC, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
    effectiveGasPrice: '0x5f5e100', status, type: '0x2', logsBloom: '0x' + '00'.repeat(256), logs: [log]
  };
}

http.createServer((req, res) => {
  let d = ''; req.on('data', c => d += c);
  req.on('end', () => {
    let m = '?', id = 1, params = [];
    try { const j = JSON.parse(d); m = j.method; id = j.id; params = j.params || []; } catch (e) {}
    let result = null;
    if (m === 'eth_getTransactionReceipt') result = receipt(String(params[0] || ''));
    else if (m === 'eth_blockNumber') result = '0x' + (BLOCK + 3).toString(16);
    else if (m === 'eth_gasPrice') result = '0x5f5e100';
    else if (m === 'eth_chainId') result = '0x2105';
    else if (m === 'eth_call') result = '0x' + '00'.repeat(32);
    console.log(new Date().toISOString(), m, params[0] ? String(params[0]).slice(0, 10) : '', '->', result ? 'ok' : 'null');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
}).listen(PORT, '127.0.0.1', () => console.log('mockrpc on 127.0.0.1:' + PORT));
