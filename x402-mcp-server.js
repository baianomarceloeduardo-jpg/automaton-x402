#!/usr/bin/env node
/**
 * x402-mcp-server.js v1.0.0 - expose the x402 toolkit to ANY MCP-capable agent.
 * Zero dependencies. Speaks newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport).
 *
 * Tools exposed:
 *   x402_probe        probe a URL, score its x402 challenge
 *   x402_verify       verify an on-chain USDC settlement on Base
 *   x402_conformance  run the 10-check conformance battery against a service
 *
 * Usage (Claude Desktop / any MCP client claude_desktop_config.json):
 *   { "mcpServers": { "x402": { "command": "node",
 *       "args": ["/abs/path/x402-mcp-server.js"] } } }
 *
 * Author: Automaton-Sovereign (0x71DEAc098914A009E3720524642A6bE6F65EE528). MIT.
 */
'use strict';
const tk = require('./x402-toolkit.js');
const conf = require('./x402-conformance.js');
const VERSION = '1.0.0';

const TOOLS = [
  {
    name: 'x402_probe',
    description: 'Probe an HTTP endpoint and score its x402 payment challenge (scheme, network, chainId, asset, payTo, amount). Use to check whether a service is x402-monetized and correctly configured.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to probe, e.g. https://example.com/paid' } },
      required: ['url']
    }
  },
  {
    name: 'x402_verify',
    description: 'Verify an on-chain USDC (or ERC-20) transfer on Base: is the tx real, confirmed, sent to the right recipient, for at least a minimum amount? Free, needs no wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        tx: { type: 'string', description: '0x transaction hash (64 hex)' },
        to: { type: 'string', description: 'Expected recipient address (0x, 40 hex)' },
        minAmount: { type: 'number', description: 'Minimum amount in token base units (USDC has 6 decimals)' },
        confirmations: { type: 'number', description: 'Required confirmations (default 1)' }
      },
      required: ['tx', 'to']
    }
  },
  {
    name: 'x402_conformance',
    description: 'Run a 10-check x402 conformance battery against a service and return a PASS/FAIL verdict with evidence. Use before trusting or listing an x402 endpoint.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Base URL or paid endpoint to test' } },
      required: ['url']
    }
  }
];

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }
function text(t) { return { content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] }; }

async function callTool(name, args) {
  if (name === 'x402_probe') {
    const r = await tk.cmdProbe({ _: [null, args.url] });
    return text(r);
  }
  if (name === 'x402_verify') {
    const r = await tk.cmdVerify({ _: [], tx: args.tx, to: args.to, min: args.minAmount, confirmations: args.confirmations });
    return text(r);
  }
  if (name === 'x402_conformance') {
    const r = await conf.run(args.url);
    return text(r);
  }
  throw new Error('unknown tool: ' + name);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'x402-toolkit', version: VERSION }
      });
    } else if (method === 'notifications/initialized') {
      // no response required
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const result = await callTool(params && params.name, (params && params.arguments) || {});
      reply(id, result);
    } else if (method === 'ping') {
      reply(id, {});
    } else if (id !== undefined) {
      replyErr(id, -32601, 'method not found: ' + method);
    }
  } catch (e) {
    if (id !== undefined) replyErr(id, -32000, e.message);
  }
}

process.stdin.on('end', () => process.exit(0));
