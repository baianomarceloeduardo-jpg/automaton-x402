#!/usr/bin/env node
/**
 * agent-finder.js v1.0.0 - zero-dep reachability probe for distribution channels.
 * Automaton-Sovereign. Reuses x402-toolkit's fetchUrl.
 *
 * Does two things:
 *  1) VERIFY: for each candidate distribution channel, actually resolve + fetch it and
 *     record HTTP status, so we NEVER claim a listing on a channel that doesn't exist.
 *  2) SEARCH: given our artifact URLs, check whether they are already indexed anywhere
 *     (simple substring search of channel search endpoints where free & unauthenticated).
 *
 *   node agent-finder.js verify
 *   node agent-finder.js search
 */
'use strict';
const tk = require('./x402-toolkit.js');
const { fetchUrl } = tk;

// Candidate zero-cost, no-auth channels for reaching agents / x402 devs.
const CHANNELS = [
  { name: 'x402.org',                 url: 'https://x402.org' },
  { name: 'x402 Bazaar (cdn)',        url: 'https://x402.org/bazaar' },
  { name: 'x402 GitHub org',          url: 'https://github.com/x402' },
  { name: 'awesome-x402 (search)',    url: 'https://github.com/search?q=awesome-x402&type=repositories' },
  { name: 'MCP registry',             url: 'https://registry.modelcontextprotocol.io' },
  { name: 'Model Context Protocol',   url: 'https://modelcontextprotocol.io' },
  { name: 'smithery.ai (MCP)',        url: 'https://smithery.ai' },
  { name: 'glama.ai (MCP)',           url: 'https://glama.ai/mcp/servers' },
  { name: 'mcp.so (MCP dir)',         url: 'https://mcp.so' },
  { name: 'Hacker News submit',       url: 'https://news.ycombinator.com/submit' },
  { name: 'Reddit r/LLMDevs',         url: 'https://www.reddit.com/r/LLMDevs/' },
  { name: 'Reddit r/LocalLLaMA',      url: 'https://www.reddit.com/r/LocalLLaMA/' },
  { name: 'GitHub API (search)',      url: 'https://api.github.com/search/code?q=x402-toolkit' },
  { name: 'paste.rs',                 url: 'https://paste.rs' },
  { name: 'tmpfiles.org',             url: 'https://tmpfiles.org' },
];

async function verify() {
  const out = { tool: 'agent-finder', action: 'verify', at: new Date().toISOString(), channels: [] };
  for (const c of CHANNELS) {
    try {
      const r = await fetchUrl(c.url, { timeout: 12000 });
      out.channels.push({ channel: c.name, url: c.url, reachable: true, status: r.status, bytes: r.body.length });
    } catch (e) {
      out.channels.push({ channel: c.name, url: c.url, reachable: false, error: e.message });
    }
  }
  const ok = out.channels.filter(x => x.reachable).length;
  out.summary = `${ok}/${out.channels.length} channels reachable`;
  return out;
}

// Our own artifact URLs to look for in the wild.
const ARTIFACTS = ['x402-toolkit', 'x402-conformance', 'paste.rs/wI1by', 'paste.rs/ETt3U'];

async function search() {
  const out = { tool: 'agent-finder', action: 'search', at: new Date().toISOString(), probes: [] };
  // GitHub code/repo search is free & unauthenticated (rate-limited).
  for (const q of ['x402-conformance', 'x402-toolkit', 'x402 inspect cli']) {
    const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q);
    try {
      const r = await fetchUrl(url, { timeout: 15000 });
      let j = null; try { j = JSON.parse(r.body); } catch (e) {}
      out.probes.push({ query: q, status: r.status, totalCount: j && j.total_count, top: j && j.items ? j.items.slice(0, 3).map(i => i.full_name) : null });
    } catch (e) { out.probes.push({ query: q, error: e.message }); }
  }
  return out;
}

if (require.main === module) {
  const cmd = process.argv[2] || 'verify';
  const fn = cmd === 'search' ? search : verify;
  fn().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error('fatal:', e.message); process.exit(1); });
}
module.exports = { verify, search, CHANNELS, ARTIFACTS };
