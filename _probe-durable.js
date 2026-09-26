
const { spawn } = require("child_process");
const http = require("http");
const p = spawn(process.execPath, ["C:\\root\\value-api\\server.js"], { env: Object.assign({}, process.env, { PORT: "8091" }), cwd: "C:\\root\\value-api" });
let out = "";
p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
function get(path) {
  return new Promise(r => { const req = http.get({ host: "127.0.0.1", port: 8091, path, timeout: 25000 }, s => { let d=""; s.on("data",c=>d+=c); s.on("end",()=>r({status:s.statusCode, body:d})); }); req.on("error", e=>r({status:0,error:e.message})); req.on("timeout",()=>{req.destroy();r({status:0,error:"timeout"})}); });
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
