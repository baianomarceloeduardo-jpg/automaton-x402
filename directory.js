/**
 * directory.js v1.0.0 - live x402 service directory, built from the PUBLIC MCP registry.
 * Zero deps. Zero auth. Real data only.
 *
 * Why this exists: agents need a place to find x402-monetized services. The MCP registry
 * exposes a free read API (verified 2026-09-25). This module queries it, extracts the
 * x402/payment-related servers, and returns a normalized directory. Optionally it can
 * deep-probe each candidate's endpoint for a real x402 challenge.
 */
'use strict';
const tk = require('./x402-toolkit.js');
const { fetchUrl } = tk;

const REG = 'https://registry.modelcontextprotocol.io/v0/servers';
const TERMS = ['x402', 'payment', 'usdc', 'base'];

function normalize(server) {
  const s = server || {};
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  const url = (remotes.find(r => r && r.url) || {}).url || (s.repository && s.repository.url) || null;
  return {
    name: s.name || null,
    title: s.title || null,
    description: (s.description || '').slice(0, 300),
    version: s.version || null,
    endpoint: url,
    repository: (s.repository && s.repository.url) || null,
    homepage: s.homepage || null
  };
}

async function fetchTerm(term) {
  const r = await fetchUrl(REG + '?search=' + encodeURIComponent(term) + '&limit=20', { timeout: 15000 });
  if (r.status !== 200) throw new Error('registry status ' + r.status);
  const j = JSON.parse(r.body);
  const out = [];
  for (const row of (j.servers || [])) out.push(normalize(row.server));
  return out;
}

/**
 * @param {object} opts { deep:boolean, headLimit:int }
 */
async function build(opts = {}) {
  const deep = !!opts.deep;
  const headLimit = opts.headLimit || 12;
  const byName = new Map();
  const errors = [];
  for (const t of TERMS) {
    try {
      const list = await fetchTerm(t);
      for (const e of list) if (e.name && !byName.has(e.name)) byName.set(e.name, Object.assign({ matchedOn: [t] }, e));
    } catch (e) { errors.push({ term: t, error: e.message }); }
  }
  let entries = [...byName.values()];

  if (deep) {
    const head = entries.slice(0, headLimit);
    await Promise.all(head.map(async (e) => {
      if (!e.endpoint || !/^https?:\/\//.test(e.endpoint)) { e.x402 = { checked: false, reason: 'no_http_endpoint' }; return; }
      try {
        const r = await fetchUrl(e.endpoint, { timeout: 10000 });
        const body = r.body || '';
        e.x402 = { checked: true, status: r.status, advertises402: r.status === 402 || /x402|accepts\s*:\s*\[|maxAmountRequired/i.test(body) };
      } catch (err) { e.x402 = { checked: true, error: err.message }; }
    }));
  }

  entries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return {
    tool: 'x402-directory',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: REG,
    note: 'Live directory built from the public MCP registry read API. deep=true adds a real reachability/x402 advertisement probe (slower).',
    terms: TERMS,
    count: entries.length,
    errors,
    services: entries
  };
}

if (require.main === module) {
  const deep = process.argv.includes('--deep');
  build({ deep }).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error('fatal', e.message); process.exit(1); });
}
module.exports = { build };
