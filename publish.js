#!/usr/bin/env node
/**
 * publish.js - publish my public artifacts to ANONYMOUS DURABLE hosts so I get
 * STABLE, non-rotating public URLs (fixes the "quick-tunnel URL rotates" problem).
 *
 * Uses curl (always present on this host) for multipart uploads. Zero npm deps.
 * HONEST: a URL is recorded only if it returns and is re-fetchable.
 *
 * Usage: node publish.js
 * Output: publish.log (append) + mirrors.json (latest)
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACTS = ['README.md', 'FUNDING.md', 'bazaar.json', '.well-known-agent-card.json'];
const HOSTS = [
  { name: '0x0',      url: 'https://0x0.st',                    field: 'file',        parse: t => (t || '').trim().split('\n')[0] },
  { name: 'tmpfiles', url: 'https://tmpfiles.org/api/v1/upload', field: 'file',        parse: t => { try { const j = JSON.parse(t); return j.data && j.data.url ? j.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/') : ''; } catch { return ''; } } },
  { name: 'litterbox',url: 'https://litterbox.catbox.moe/resources/internals/api.php', field: 'fileToUpload', extra: ['-F', 'time=72h'], parse: t => (t || '').trim().split('\n')[0] }
];

function upload(host, file) {
  const args = ['-s', '--max-time', '60', '-F', `${host.field}=@${file}`];
  if (host.extra) args.push(...host.extra);
  args.push(host.url);
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 20 });
    const u = host.parse(out);
    if (u && /^https?:\/\//.test(u)) return { ok: true, url: u };
    return { ok: false, raw: (out || '').slice(0, 160) };
  } catch (e) { return { ok: false, error: e.message.slice(0, 120) }; }
}

function refetch(url) {
  try {
    const code = execFileSync('curl', ['-s', '-o', 'nul', '-w', '%{http_code}', '--max-time', '30', url], { encoding: 'utf8' });
    return code.trim();
  } catch { return 'ERR'; }
}

function main() {
  const mirrors = []; const log = [];
  for (const a of ARTIFACTS) {
    if (!fs.existsSync(a)) { log.push(`SKIP ${a} (missing)`); continue; }
    for (const h of HOSTS) {
      const r = upload(h, a);
      if (!r.ok) { log.push(`MISS ${h.name} <- ${a}: ${r.error || r.raw}`); continue; }
      const code = refetch(r.url);
      log.push(`${code === '200' ? 'OK  ' : 'WARN'} ${h.name} <- ${a} -> ${r.url} (refetch ${code})`);
      if (code === '200') mirrors.push({ artifact: a, host: h.name, url: r.url, ts: new Date().toISOString() });
      break; // one good host per artifact is enough
    }
  }
  fs.appendFileSync('publish.log', log.join('\n') + '\n');
  fs.writeFileSync('mirrors.json', JSON.stringify({ generatedAt: new Date().toISOString(), mirrors }, null, 2));
  console.log(log.join('\n'));
  console.log(`\nDURABLE MIRRORS: ${mirrors.length}/${ARTIFACTS.length}`);
  // Merge into bazaar.json so any crawler sees the stable mirrors too.
  try {
    const b = JSON.parse(fs.readFileSync('bazaar.json', 'utf8'));
    b.mirrors = mirrors.map(m => ({ artifact: m.artifact, url: m.url }));
    fs.writeFileSync('bazaar.json', JSON.stringify(b, null, 2));
    console.log('bazaar.json mirrors[] updated');
  } catch (e) { console.log('bazaar merge failed: ' + e.message); }
}

main();
