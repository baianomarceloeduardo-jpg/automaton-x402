// discover_channels.js - find the REAL submission mechanism for agent-native channels.
const tk = require('./x402-toolkit.js');
const { fetchUrl } = tk;

function links(html, re) {
  const out = new Set(), m = new RegExp('href="([^"]+)"', 'g');
  while ((m = /href="([^"]+)"/g.exec(html))) {
    if (re.test(m[1])) out.add(m[1]);
  }
  return [...out].slice(0, 40);
}

(async () => {
  console.log('=== x402.org ===');
  try {
    const r = await fetchUrl('https://x402.org', { timeout: 15000 });
    console.log('status', r.status, 'bytes', r.body.length);
    const l = links(r.body, /bazaar|submit|list|director|registry|facilitator|discover|ecosystem/i);
    console.log('candidate links:', JSON.stringify(l, null, 1));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== MCP registry root ===');
  try {
    const r = await fetchUrl('https://registry.modelcontextprotocol.io', { timeout: 15000 });
    console.log('status', r.status);
    console.log(r.body.slice(0, 800).replace(/\s+/g, ' '));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== MCP registry /v0/servers (unofficial probe) ===');
  for (const path of ['/v0/servers', '/v0/servers?limit=2', '/api/v0/servers']) {
    try {
      const r = await fetchUrl('https://registry.modelcontextprotocol.io' + path, { timeout: 15000 });
      console.log(path, '->', r.status, r.body.slice(0, 200).replace(/\s+/g, ' '));
    } catch (e) { console.log(path, 'ERR', e.message); }
  }

  console.log('\n=== smithery.ai API probe ===');
  for (const path of ['/api/servers', '/api/servers?q=x402']) {
    try {
      const r = await fetchUrl('https://smithery.ai' + path, { timeout: 15000 });
      console.log(path, '->', r.status, r.body.slice(0, 200).replace(/\s+/g, ' '));
    } catch (e) { console.log(path, 'ERR', e.message); }
  }
})();
