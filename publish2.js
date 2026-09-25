#!/usr/bin/env node
/**
 * publish2.js - SECOND durable-publish path for TEXT artifacts (incl. HTML).
 * tmpfiles.org rejects .html; these paste hosts accept arbitrary text and return
 * durable, directly-fetchable URLs with no account. Zero npm deps; uses curl.
 *
 * Usage: node publish2.js <file> [file2 ...]
 * -> prints verified URLs and appends to mirrors2.json
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOSTS = [
  { name: 'paste.rs',  push: (f) => execFileSync('curl', ['-s', '--max-time', '45', '--data-binary', '@' + f, 'https://paste.rs'], { encoding: 'utf8' }).trim() },
  { name: 'dpaste',    push: (f) => { const t = execFileSync('curl', ['-s', '--max-time', '45', '-F', 'content=<-', '-F', 'format=url', '-F', 'expiry=31536000', 'https://dpaste.com/api/v2/'], { encoding: 'utf8', input: fs.readFileSync(f, 'utf8') }); return t.trim(); } },
  { name: 'sprunge',   push: (f) => execFileSync('curl', ['-s', '--max-time', '45', '-F', 'sprunge=<-', 'http://sprunge.us'], { encoding: 'utf8', input: fs.readFileSync(f, 'utf8') }).trim() }
];

function refetch(url) {
  try { return execFileSync('curl', ['-s', '-L', '-o', 'nul', '-w', '%{http_code}', '--max-time', '30', url], { encoding: 'utf8' }).trim(); }
  catch { return 'ERR'; }
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node publish2.js <file> [...]'); process.exit(1); }

const out = [];
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`SKIP ${f} (missing)`); continue; }
  for (const h of HOSTS) {
    let url = '';
    try { url = h.push(f); } catch (e) { console.log(`MISS ${h.name} <- ${f}: ${e.message.slice(0, 90)}`); continue; }
    if (!/^https?:\/\//.test(url)) { console.log(`MISS ${h.name} <- ${f}: bad response ${JSON.stringify((url || '').slice(0, 80))}`); continue; }
    const code = refetch(url);
    console.log(`${code === '200' ? 'OK  ' : 'WARN'} ${h.name} <- ${path.basename(f)} -> ${url} (${code})`);
    if (code === '200') { out.push({ artifact: f, host: h.name, url, ts: new Date().toISOString() }); break; }
  }
}

const prev = (() => { try { return JSON.parse(fs.readFileSync('mirrors2.json', 'utf8')); } catch { return { mirrors: [] }; } })();
prev.mirrors = (prev.mirrors || []).concat(out);
prev.generatedAt = new Date().toISOString();
fs.writeFileSync('mirrors2.json', JSON.stringify(prev, null, 2));

// Merge all mirrors into bazaar.json so crawlers see every stable URL.
try {
  const b = JSON.parse(fs.readFileSync('bazaar.json', 'utf8'));
  b.mirrors = (b.mirrors || []).concat(out.map(m => ({ artifact: path.basename(m.artifact), url: m.url })));
  fs.writeFileSync('bazaar.json', JSON.stringify(b, null, 2));
} catch (e) { console.log('bazaar merge: ' + e.message); }

console.log(`\nVERIFIED: ${out.length}/${files.length}`);
