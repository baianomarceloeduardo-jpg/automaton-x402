'use strict';
/**
 * Idempotent keeper for the boot loop (valueapi-boot.cmd): starts autonomous-orchestrator.js
 * detached unless one is already alive. "Alive" = the status file was refreshed recently AND its
 * PID still exists (a fresh file guards against PID reuse after a reboot).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOG_DIR = path.join(__dirname, 'logs');
const STATUS = path.join(LOG_DIR, 'orchestrator-status.json');
const FRESH_MS = 60 * 1000;

function running(statusFile = STATUS, now = Date.now()) {
  try {
    const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (now - Date.parse(s.at) > FRESH_MS) return false;
    process.kill(s.orchestratorPid, 0);
    return s.orchestratorPid;
  } catch (e) {
    return false;
  }
}

function ensure() {
  const pid = running();
  const stamp = new Date().toISOString();
  if (pid) { console.log(`${stamp} [ensure-orchestrator] already running pid=${pid}`); return pid; }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outLog = path.join(LOG_DIR, 'orchestrator-boot.log');
  const out = fs.openSync(outLog, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'autonomous-orchestrator.js'), '--daemon'], {
    cwd: path.dirname(__dirname), detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env
  });
  child.unref();
  console.log(`${stamp} [ensure-orchestrator] started pid=${child.pid}`);
  return child.pid;
}

function restart() {
  const pid = running();
  if (pid) {
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch (_) {}
  }
  return ensure();
}

if (require.main === module) {
  if (process.argv.includes('--restart')) restart();
  else if (process.argv.includes('--status')) {
    const pid = running();
    console.log(pid ? `running pid=${pid}` : 'stopped');
  } else ensure();
}

module.exports = { running, ensure, restart };

