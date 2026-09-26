'use strict';
/**
 * Automaton autonomous orchestrator — keeps the daemons alive 24/7.
 *  - one child process per daemon, stdout/stderr prefixed into one log (services/logs/orchestrator.log, 5 MB rotation)
 *  - crash => restart with exponential backoff (1s .. 60s); a run longer than 5 min resets the backoff
 *  - status snapshot every 10s in services/logs/orchestrator-status.json
 *
 * Usage: node autonomous-orchestrator.js [--only pool-sentinel,bounty-hunter]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOG_DIR = process.env.ORCH_LOG_DIR || path.join(__dirname, 'logs');
const DAEMONS = [
  { name: 'bounty-hunter', script: path.join(__dirname, 'bounty-hunter', 'hunter-daemon.js') },
  { name: 'pool-sentinel', script: path.join(__dirname, 'pool-sentinel', 'pool-watcher.js') },
  { name: 'fee-claimer', script: path.join(__dirname, 'fee-claimer', 'claim-daemon.js') }
];

class Supervisor {
  constructor({ daemons = DAEMONS, logDir = LOG_DIR, baseDelayMs = 1000, maxDelayMs = 60000, healthyMs = 5 * 60 * 1000,
    maxLogBytes = 5 * 1024 * 1024, statusEveryMs = 10000, spawnImpl = spawn, echo = true } = {}) {
    Object.assign(this, { logDir, baseDelayMs, maxDelayMs, healthyMs, maxLogBytes, statusEveryMs, spawnImpl, echo });
    fs.mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, 'orchestrator.log');
    this.statusFile = path.join(logDir, 'orchestrator-status.json');
    this.units = daemons.map(d => ({ ...d, child: null, restarts: 0, consecutive: 0, startedAt: null, lastExit: null, timer: null, state: 'idle' }));
    this.stopping = false;
    this.startedAt = new Date().toISOString();
  }

  log(name, line) {
    const entry = `${new Date().toISOString()} [${name}] ${line}\n`;
    try {
      const st = fs.existsSync(this.logFile) ? fs.statSync(this.logFile) : null;
      if (st && st.size > this.maxLogBytes) fs.renameSync(this.logFile, this.logFile + '.1');
      fs.appendFileSync(this.logFile, entry);
    } catch (e) {}
    if (this.echo) process.stdout.write(entry);
  }

  launch(u) {
    if (this.stopping) return;
    u.timer = null;
    u.startedAt = Date.now();
    u.state = 'running';
    const child = this.spawnImpl(process.execPath, [u.script, ...(u.args || [])], { cwd: path.dirname(u.script), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    u.child = child;
    this.log('orchestrator', `started ${u.name} pid=${child.pid}`);
    const pipe = stream => {
      let buf = '';
      stream.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line) this.log(u.name, line); }
      });
    };
    if (child.stdout) pipe(child.stdout);
    if (child.stderr) pipe(child.stderr);
    child.on('error', e => this.log('orchestrator', `${u.name} spawn error: ${e.message}`));
    child.on('exit', (code, signal) => {
      u.child = null;
      u.lastExit = { code, signal, at: new Date().toISOString(), ranMs: Date.now() - u.startedAt };
      if (this.stopping) { u.state = 'stopped'; return; }
      if (u.lastExit.ranMs >= this.healthyMs) u.consecutive = 0;
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** u.consecutive);
      u.consecutive++;
      u.restarts++;
      u.state = 'backoff';
      this.log('orchestrator', `${u.name} exited code=${code} signal=${signal}; restart #${u.restarts} in ${delay}ms`);
      u.timer = setTimeout(() => this.launch(u), delay);
    });
  }

  writeStatus() {
    const s = {
      orchestratorPid: process.pid, startedAt: this.startedAt, at: new Date().toISOString(),
      daemons: this.units.map(u => ({ name: u.name, state: u.state, pid: u.child ? u.child.pid : null, restarts: u.restarts,
        upSinceMs: u.child ? Date.now() - u.startedAt : 0, lastExit: u.lastExit }))
    };
    try { fs.writeFileSync(this.statusFile, JSON.stringify(s, null, 2)); } catch (e) {}
    return s;
  }

  start() {
    this.log('orchestrator', `boot pid=${process.pid} daemons=${this.units.map(u => u.name).join(',')}`);
    for (const u of this.units) this.launch(u);
    this.statusTimer = setInterval(() => this.writeStatus(), this.statusEveryMs);
    this.writeStatus();
  }

  stop() {
    this.stopping = true;
    clearInterval(this.statusTimer);
    const waits = [];
    for (const u of this.units) {
      if (u.timer) { clearTimeout(u.timer); u.timer = null; u.state = 'stopped'; }
      if (u.child) {
        const c = u.child;
        waits.push(new Promise(r => { c.once('exit', r); setTimeout(r, 5000); }));
        try { c.kill(); } catch (e) {}
      }
    }
    return Promise.all(waits).then(() => { this.writeStatus(); this.log('orchestrator', 'stopped'); });
  }
}

if (require.main === module) {
  const i = process.argv.indexOf('--only');
  const only = i > -1 ? process.argv[i + 1].split(',') : null;
  const sup = new Supervisor({ daemons: only ? DAEMONS.filter(d => only.includes(d.name)) : DAEMONS });
  sup.start();
  const shutdown = () => sup.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { Supervisor, DAEMONS };
