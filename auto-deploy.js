// auto-deploy.js v1.0.0 - SELF-HEALING public reachability. Idempotent, cheap, safe to run often.
// This exists because manual redeploys have consumed whole sessions. Logic:
//   1. Is local /health 200?           no -> full atomic deploy
//   2. Is the URL in tunnel.url 200?   no -> full atomic deploy
//   3. Did the base URL CHANGE?        yes -> republish the durable beacon (keeps listings current)
//   4. Write health-state.json either way.
// Exit 0 always unless the deploy itself failed.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const PORT = 8080;
const URL_FILE = path.join(DIR, 'tunnel.url');
const STATE = path.join(DIR, 'health-state.json');
const LAST = path.join(DIR, 'last-published-url.txt');

function probe(url) {
  return new Promise(resolve => {
    if (!url) return resolve(0);
    const mod = url.indexOf('https') === 0 ? https : http;
    const req = mod.get(url, { timeout: 8000 }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}
function readUrl() { try { return fs.readFileSync(URL_FILE, 'utf8').trim().replace(/\/$/, ''); } catch (e) { return ''; } }
function run(script) {
  try {
    const out = execFileSync(process.execPath, [path.join(DIR, script)], { cwd: DIR, encoding: 'utf8', timeout: 420000 });
    return { ok: true, out: out.slice(-4000) };
  } catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).slice(-4000) }; }
}

(async () => {
  const at = new Date().toISOString();
  const result = { at, actions: [], ok: false, base: '' };

  const localStatus = await probe('http://127.0.0.1:' + PORT + '/health');
  result.actions.push('local_health=' + localStatus);

  let base = readUrl();
  let publicStatus = await probe(base + '/health');
  result.actions.push('public_health=' + publicStatus + ' url=' + base);

  if (localStatus !== 200 || publicStatus !== 200) {
    result.actions.push('trigger=deploy');
    const d = run('deploy.js');
    result.actions.push('deploy_ok=' + d.ok);
    if (!d.ok) result.actions.push('deploy_tail=' + d.out.replace(/\s+/g, ' ').slice(-300));
    base = readUrl();
    publicStatus = await probe(base + '/health');
    result.actions.push('post_deploy_public_health=' + publicStatus);
  }

  result.base = base;
  result.ok = publicStatus === 200;

  // Republish the beacon only when the base URL actually changed (avoids paste.rs spam).
  let last = '';
  try { last = fs.readFileSync(LAST, 'utf8').trim(); } catch (e) {}
  if (result.ok && base && base !== last) {
    const p = run('publish.js');
    result.actions.push('beacon_republish_ok=' + p.ok);
    if (p.ok) { try { fs.writeFileSync(LAST, base + '\n'); } catch (e) {} }
  } else if (result.ok) {
    result.actions.push('beacon_skip=url_unchanged');
  }

  fs.writeFileSync(STATE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(DIR, 'auto-deploy.log'), JSON.stringify(result) + '\n', { flag: 'a' });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})();
