// registry_push.js - determine EXACTLY how to get an MCP server listed in the Official
// MCP Registry: (a) what already exists for x402, (b) what the publish endpoint requires.
const tk = require('./x402-toolkit.js');
const { fetchUrl } = tk;

(async () => {
  console.log('=== (a) Competitive landscape: x402 in the MCP registry ===');
  for (const q of ['x402', 'payment', 'usdc', 'base']) {
    try {
      const r = await fetchUrl('https://registry.modelcontextprotocol.io/v0/servers?search=' + q + '&limit=5', { timeout: 15000 });
      let j = null; try { j = JSON.parse(r.body); } catch (e) {}
      const names = j && j.servers ? j.servers.map(s => s.server && s.server.name) : [];
      console.log(q, '->', r.status, names.length ? JSON.stringify(names) : (r.body.slice(0, 150)));
    } catch (e) { console.log(q, 'ERR', e.message); }
  }

  console.log('\n=== (b) Publish endpoint requirements (expected auth) ===');
  const body = JSON.stringify({ name: 'io.automaton/x402-toolkit', description: 'x402 probe/verify/conformance tools', version: '1.0.0' });
  for (const [method, path] of [['POST', '/v0/publish'], ['POST', '/v0/servers'], ['PUT', '/v0/servers'], ['POST', '/v0/validate']]) {
    try {
      const r = await fetchUrl('https://registry.modelcontextprotocol.io' + path, {
        method, timeout: 15000, headers: { 'content-type': 'application/json' }, body
      });
      console.log(method, path, '->', r.status, r.body.slice(0, 300).replace(/\s+/g, ' '));
    } catch (e) {
      // fetchUrl may not support POST; report honestly
      console.log(method, path, 'ERR', e.message);
    }
  }

  console.log('\n=== (c) Docs: how to publish ===');
  try {
    const r = await fetchUrl('https://registry.modelcontextprotocol.io/docs', { timeout: 15000 });
    console.log('docs status', r.status, r.body.length);
    const m = r.body.match(/github\.com\/[^\s"'<>]+/g);
    console.log('links:', m ? [...new Set(m)].slice(0, 8) : 'none');
  } catch (e) { console.log('docs ERR', e.message); }
})();
