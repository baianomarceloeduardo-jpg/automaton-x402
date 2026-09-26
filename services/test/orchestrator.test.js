'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Supervisor, DAEMONS } = require('../autonomous-orchestrator.js');

const fx = name => path.join(__dirname, 'fixtures', name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

test('the configured daemons exist on disk', () => {
  for (const d of DAEMONS) assert.ok(fs.existsSync(d.script), d.script);
});

test('crashing daemons are restarted with growing backoff; healthy ones keep running; stop kills all', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  const sup = new Supervisor({
    daemons: [{ name: 'crasher', script: fx('crash.js') }, { name: 'steady', script: fx('steady.js') }],
    logDir, baseDelayMs: 40, maxDelayMs: 400, statusEveryMs: 50, echo: false
  });
  sup.start();
  await sleep(1500);
  const [crasher, steady] = sup.units;
  assert.ok(crasher.restarts >= 3, 'restarts=' + crasher.restarts);
  assert.equal(steady.restarts, 0);
  const steadyPid = steady.child.pid;
  assert.ok(alive(steadyPid));

  const log = fs.readFileSync(path.join(logDir, 'orchestrator.log'), 'utf8');
  assert.match(log, /\[steady\] tick/);
  assert.match(log, /\[crasher\] about to crash/);
  const delays = [...log.matchAll(/crasher exited .* in (\d+)ms/g)].map(m => +m[1]);
  assert.deepEqual(delays.slice(0, 3), [40, 80, 160], 'exponential backoff');
  const status = JSON.parse(fs.readFileSync(path.join(logDir, 'orchestrator-status.json'), 'utf8'));
  assert.equal(status.daemons.length, 2);

  await sup.stop();
  await sleep(100);
  assert.equal(alive(steadyPid), false, 'child terminated on stop');
  const restartsAtStop = crasher.restarts;
  await sleep(500);
  assert.equal(crasher.restarts, restartsAtStop, 'no restarts after stop');
});

test('log rotates past the size cap', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  const sup = new Supervisor({ daemons: [], logDir, maxLogBytes: 200, echo: false });
  for (let i = 0; i < 20; i++) sup.log('x', 'line ' + i + ' ' + 'y'.repeat(20));
  assert.ok(fs.existsSync(path.join(logDir, 'orchestrator.log.1')));
  assert.ok(fs.statSync(path.join(logDir, 'orchestrator.log')).size < 400);
});
