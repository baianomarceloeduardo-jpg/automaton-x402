'use strict';
/**
 * patch_phase2_conformance.js - Mount Conformance Service, SVG Badges, & Leaderboard to server.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const serverFile = path.join(__dirname, 'server.js');
let code = fs.readFileSync(serverFile, 'utf8');

// Backup
fs.writeFileSync(serverFile + '.bak_phase2', code);

// 1. Require conformance-service at top
if (!code.includes("const CONFORMANCE_SERVICE = require('./conformance-service.js');")) {
  const reqAnchor = "const FACILITATOR = require('./x402-facilitator.js');";
  if (code.includes(reqAnchor)) {
    code = code.replace(reqAnchor, reqAnchor + "\nconst CONFORMANCE_SERVICE = require('./conformance-service.js');");
  } else {
    code = "const CONFORMANCE_SERVICE = require('./conformance-service.js');\n" + code;
  }
}

// 2. Add routes before `if (p === '/' || p === '/index.html')`
const routeAnchor = "if (p === '/' || p === '/index.html') {";
const routeCode = `  // --- Conformance & Trust Infrastructure Endpoints ---
  if (p === '/leaderboard') {
    return CONFORMANCE_SERVICE.handleLeaderboard(req, res, (u.searchParams.get('format') === 'json') || (req.headers['accept'] || '').includes('application/json'));
  }
  if (p.startsWith('/v2/badge/')) {
    const certId = p.replace('/v2/badge/', '').replace('.svg', '');
    return CONFORMANCE_SERVICE.handleBadge(req, res, certId);
  }
  if (p.startsWith('/v2/certificate/')) {
    const certId = p.replace('/v2/certificate/', '');
    return CONFORMANCE_SERVICE.handleCertificate(req, res, certId, send);
  }
  if (p === '/v2/conformance/check') {
    const targetUrl = u.searchParams.get('url') || '';
    return CONFORMANCE_SERVICE.handleCheck(req, res, targetUrl, send);
  }
  if (p === '/v2/conformance/certify') {
    if (!(await authorize(req, res, '/v2/conformance/certify'))) return;
    let targetUrl = u.searchParams.get('url') || '';
    if (!targetUrl && (M === 'POST' || M === 'PUT')) {
      const raw = await readBody(req, 1024 * 64);
      if (raw) { try { targetUrl = JSON.parse(raw).url || ''; } catch (e) {} }
    }
    return CONFORMANCE_SERVICE.handleCertify(req, res, targetUrl, {
      appendAttestation,
      baseUrl: base()
    }, send);
  }

  `;

if (!code.includes("p === '/leaderboard'")) {
  code = code.replace(routeAnchor, routeCode + routeAnchor);
}

fs.writeFileSync(serverFile, code);
console.log('Validating server.js syntax...');
execSync('node -c "' + serverFile + '"');
console.log('server.js patched and syntax validated successfully.');
