'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { running } = require('../ensure-orchestrator.js');

const statusFile = obj => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ens-')), 's.json'); if (obj) fs.writeFileSync(f, JSON.stringify(obj)); return f; };

test('running(): fresh status + live pid => pid; stale, dead or missing => false', () => {
  const now = Date.now();
  assert.equal(running(statusFile({ orchestratorPid: process.pid, at: new Date(now).toISOString() }), now), process.pid);
  assert.equal(running(statusFile({ orchestratorPid: process.pid, at: new Date(now - 120000).toISOString() }), now), false, 'stale file (e.g. after reboot)');
  assert.equal(running(statusFile({ orchestratorPid: 2 ** 22 + 12345, at: new Date(now).toISOString() }), now), false, 'dead pid');
  assert.equal(running(statusFile(null), now), false, 'no status file');
});
