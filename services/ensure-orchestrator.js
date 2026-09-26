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
  const child = spawn(process.execPath, [path.join(__dirname, 'autonomous-orchestrator.js')], {
    cwd: path.dirname(__dirname), detached: true, stdio: 'ignore', windowsHide: true, env: process.env
  });
  child.unref();
  console.log(`${stamp} [ensure-orchestrator] started pid=${child.pid}`);
  return child.pid;
}

if (require.main === module) ensure();

module.exports = { running, ensure };
