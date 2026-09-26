'use strict';
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// Write to a temp file then rename, so readers (the value-api routes) never see a half-written file.
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows: EPERM/EBUSY while another process has the target open. Retry briefly.
      if (i === 4) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); try { fs.unlinkSync(tmp); } catch (_) {} return; }
      const until = Date.now() + 20; while (Date.now() < until) { /* spin */ }
    }
  }
}

function logger(name) {
  return (...a) => console.log(new Date().toISOString(), '[' + name + ']', ...a);
}

module.exports = { readJson, writeJsonAtomic, logger };
