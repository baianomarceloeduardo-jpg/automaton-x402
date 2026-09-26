// boot-kit.js — self-diagnosing boot shim for the Value API.
// WHY: server.js line 1 was `try { require('./kit-serve.js').install(); } catch(e){}`
// which failed SILENTLY in the live process (unit harness passed, live 404'd).
// A silent catch on a revenue-critical route is unacceptable. This shim:
//   1. installs kit-serve and records the exact outcome to kit-boot.log
//   2. self-tests the patch on a throwaway server BEFORE the real one binds
//   3. leaves a machine-readable verdict so failures are never invisible again
'use strict';
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'kit-boot.log');

function log(line) {
  const stamp = new Date().toISOString();
  try { fs.appendFileSync(LOG, stamp + ' ' + line + '\n'); } catch (_) {}
}

// Truncate per boot so the log describes THIS process only.
try { fs.writeFileSync(LOG, ''); } catch (_) {}

let installed = false, err = null;
try {
  const kit = require('./kit-serve.js');
  if (typeof kit.install !== 'function') throw new Error('kit-serve.js has no install()');
  kit.install();
  installed = true;
  log('install=OK');
} catch (e) {
  err = e;
  log('install=FAILED ' + e.message);
}

// Self-test: prove the patch intercepts on a fresh server, in THIS process.
try {
  const http = require('http');
  const probe = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: req.url }));
  });
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    http.get({ host: '127.0.0.1', port, path: '/x402-v2-kit.js', timeout: 4000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => {
        const pass = res.statusCode === 200 && n > 1000;
        log('selftest status=' + res.statusCode + ' bytes=' + n + ' => ' + (pass ? 'PASS' : 'FAIL'));
        probe.close();
      });
    }).on('error', (e2) => { log('selftest error=' + e2.message); probe.close(); });
    probe.unref && probe.unref();
  });
} catch (e) {
  log('selftest threw ' + e.message);
}

module.exports = { installed, err };
