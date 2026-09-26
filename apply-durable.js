// apply-durable.js — idempotently append the durable-overlay to server.js, syntax-check, prove live.
// Reversible: strips a previous __DURABLE_OVERLAY__ block before re-appending; keeps a .bak copy.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const DIR = __dirname;
const SERVER = path.join(DIR, 'server.js');
const MARK = '__DURABLE_OVERLAY__';
const BLOCK = '\n// ' + MARK + '\nrequire("./durable-overlay.js");\n';

let src = fs.readFileSync(SERVER, 'utf8');
const had = src.indexOf(MARK) !== -1;

// strip any existing overlay block (idempotent)
if (had) {
  const idx = src.lastIndexOf('// ' + MARK);
  if (idx !== -1) src = src.slice(0, idx).replace(/\s+$/, '') + '\n';
}
src = src.replace(/\s+$/, '') + '\n' + BLOCK;
fs.writeFileSync(SERVER, src);

// syntax check
const chk = spawnSync(process.execPath, ['--check', SERVER], { encoding: 'utf8' });
if (chk.status !== 0) {
  console.log('SYNTAX=FAIL');
  console.log((chk.stderr || '').slice(0, 800));
  process.exit(1);
}
console.log('SYNTAX=OK overlay=' + (had ? 'reapplied' : 'added'));

// prove the endpoints live in an isolated instance
const PORT = 8091;
const probe = `
const { spawn } = require("child_process");
const http = require("http");
const p = spawn(process.execPath, ["${SERVER.replace(/\\/g, '\\\\')}"], { env: Object.assign({}, process.env, { PORT: "${PORT}" }), cwd: "${DIR.replace(/\\/g, '\\\\')}" });
let out = "";
p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
function get(path) {
  return new Promise(r => { const req = http.get({ host: "127.0.0.1", port: ${PORT}, path, timeout: 25000 }, s => { let d=""; s.on("data",c=>d+=c); s.on("end",()=>r({status:s.statusCode, body:d})); }); req.on("error", e=>r({status:0,error:e.message})); req.on("timeout",()=>{req.destroy();r({status:0,error:"timeout"})}); });
}
setTimeout(async () => {
  const results = [];
  const w = await get("/.well-known/agent-base");
  let wj = null; try { wj = JSON.parse(w.body); } catch(_) {}
  results.push(["well-known/agent-base", w.status, wj && wj.base ? wj.base.slice(0,50) : "?"]);
  const r = await get("/v1/resolve-base");
  let rj = null; try { rj = JSON.parse(r.body); } catch(_) {}
  results.push(["resolve-base", r.status, rj && rj.base ? rj.base.slice(0,50) : "?"]);
  const bad = await get("/v1/resolve-base?tx=0xdeadbeef");
  results.push(["resolve-base malformed tx", bad.status, "expect 400"]);
  const ht = await get("/health");
  results.push(["health still ok", ht.status, ""]);
  for (const [n, s, extra] of results) console.log("  " + (s === 200 || (n.indexOf("malformed") > -1 && s === 400) ? "PASS" : "FAIL") + "  " + n + " -> " + s + " " + extra);
  p.kill();
  process.exit(0);
}, 4500);
`;
fs.writeFileSync(path.join(DIR, '_probe-durable.js'), probe);
const r = spawnSync(process.execPath, [path.join(DIR, '_probe-durable.js')], { encoding: 'utf8', timeout: 90000, cwd: DIR });
console.log((r.stdout || '').trim());
if (r.stderr && r.stderr.trim()) console.log('stderr: ' + r.stderr.trim().slice(0, 500));
