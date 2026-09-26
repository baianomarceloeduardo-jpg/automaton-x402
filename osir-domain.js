// osir-domain.js - free domain availability + pricing lookup via OSIR's public MCP
// Upstream: https://be.osir.com/mcp/http (MCP streamable-http). checkDomainAvailability
// and getDomainExtensions require NO authentication. Zero-dep. Cached.
const { McpHttp } = require('./mcp-http.js');

const OSIR_URL = 'https://be.osir.com/mcp/http';
let _client = null;
let _initAt = 0;

async function client() {
  const now = Date.now();
  if (_client && now - _initAt < 10 * 60 * 1000) return _client;
  const m = new McpHttp(OSIR_URL);
  const i = await m.init();
  if (i.status !== 200) throw new Error('osir_init_failed_' + i.status);
  _client = m; _initAt = now;
  return m;
}

function unwrap(res) {
  const j = res && res.json;
  if (!j) return null;
  if (j.error) return { ok: false, error: j.error.message || JSON.stringify(j.error) };
  const r = j.result;
  if (!r) return null;
  // MCP tool results: content[] with text blocks
  if (Array.isArray(r.content)) {
    const texts = r.content.filter(c => c.type === 'text').map(c => c.text);
    for (const t of texts) {
      try { return { ok: true, data: JSON.parse(t) }; } catch { /* keep scanning */ }
    }
    return { ok: true, data: texts.join('\n') };
  }
  if (r.isError) return { ok: false, error: r.isError };
  return { ok: true, data: r };
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

// Normalize a user-supplied domain string; reject junk.
function normDomain(d) {
  if (!d || typeof d !== 'string') return null;
  d = d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) return null;
  if (d.length > 253) return null;
  return d;
}

async function check(domain) {
  const d = normDomain(domain);
  if (!d) return { ok: false, reason: 'malformed_domain', input: domain };
  return cached('chk:' + d, 5 * 60 * 1000, async () => {
    const m = await client();
    const res = await m.callTool('checkDomainAvailability', { domain: d });
    const u = unwrap(res);
    if (!u) return { ok: false, reason: 'empty_upstream_response', domain: d };
    if (!u.ok) return { ok: false, reason: 'upstream_error', domain: d, detail: u.error };
    return { ok: true, domain: d, upstream: 'osir', result: u.data, fetchedAt: new Date().toISOString() };
  });
}

async function tlds() {
  return cached('tlds', 6 * 60 * 60 * 1000, async () => {
    const m = await client();
    const res = await m.callTool('getDomainExtensions', {});
    const u = unwrap(res);
    if (!u || !u.ok) return { ok: false, reason: 'upstream_error', detail: u && u.error };
    return { ok: true, upstream: 'osir', result: u.data, fetchedAt: new Date().toISOString() };
  });
}

module.exports = { check, tlds, normDomain, OSIR_URL };

if (require.main === module) {
  (async () => {
    const t0 = Date.now();
    console.log('--- tlds() ---');
    const t = await tlds();
    console.log('ok=' + t.ok, 'bytes=' + JSON.stringify(t).length);
    if (t.ok) {
      const d = t.result && (t.result.extensions || t.result.tlds || t.result.data || t.result);
      const arr = Array.isArray(d) ? d : (d && typeof d === 'object' ? Object.keys(d) : []);
      console.log('extensions n=' + (Array.isArray(d) ? d.length : arr.length));
      console.log(JSON.stringify(t.result).slice(0, 400));
    }
    console.log('--- check(automatonsovereign.xyz) ---');
    const c = await check('automatonsovereign.xyz');
    console.log(JSON.stringify(c).slice(0, 800));
    console.log('--- check(bad input) ---');
    console.log(JSON.stringify(await check('not a domain!!')));
    console.log('elapsed_ms=' + (Date.now() - t0));
  })().catch(e => { console.log('FATAL ' + e.message); process.exit(1); });
}
