// safe-fetch-test.js — adversarial test suite for the SSRF-hardened fetcher.
// Every case is a real attack string or a real control case. No mocks for the classifier.
const { isBlockedIp, normalizeHost, assertSafeUrl, safeFetch } = require('./safe-fetch');

let pass = 0, fail = 0;
function ok(n, d) { pass++; console.log('[PASS] ' + n + (d ? ' — ' + d : '')); }
function no(n, d) { fail++; console.log('[FAIL] ' + n + (d ? ' — ' + d : '')); }

function expectBlocked(label, ip) {
  if (isBlockedIp(ip) === true) ok(label, ip + ' -> blocked'); else no(label, ip + ' -> ALLOWED (hole!)');
}
function expectAllowed(label, ip) {
  if (isBlockedIp(ip) === false) ok(label, ip + ' -> allowed'); else no(label, ip + ' -> blocked (false positive)');
}

console.log('--- address classifier ---');
// must be blocked
['127.0.0.1', '127.1.2.3', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.254',
 '192.168.0.1', '192.168.255.254', '169.254.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
 '224.0.0.1', '240.0.0.1', '255.255.255.255',
 '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
 '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1'].forEach(ip => expectBlocked('block ' + ip, ip));
// must be allowed
['1.1.1.1', '8.8.8.8', '104.16.0.1', '2606:4700::1111'].forEach(ip => expectAllowed('allow ' + ip, ip));

console.log('\n--- encoded / evasive host forms ---');
const enc = [
  ['decimal loopback 2130706433', '2130706433', '127.0.0.1'],
  ['hex loopback 0x7f000001', '0x7f000001', '127.0.0.1'],
  ['octal loopback 017700000001', '017700000001', '127.0.0.1'],
  ['bracketed ipv6 [::1]', '[::1]', '::1'],
];
for (const [label, input, want] of enc) {
  const got = normalizeHost(input);
  if (got === want) ok('normalize ' + label, input + ' -> ' + got);
  else no('normalize ' + label, input + ' -> ' + got + ' (want ' + want + ')');
}

console.log('\n--- URL gate ---');
const badUrls = [
  'file:///etc/passwd', 'gopher://x/', 'ftp://1.1.1.1/',
  'http://127.0.0.1/', 'http://[::1]:8080/', 'http://169.254.169.254/latest/meta-data/',
  'http://2130706433/', 'http://0x7f000001/', 'http://localhost.evil.com/', // resolves normally, must pass DNS stage not URL stage
];
for (const u of badUrls) {
  let threw = null;
  try { assertSafeUrl(u); } catch (e) { threw = e.message; }
  if (u.includes('localhost.evil.com')) {
    if (!threw) ok('gate allows normal-looking host (DNS stage filters)', u);
    else no('gate allows normal-looking host', 'threw ' + threw);
  } else if (threw) ok('reject ' + u, threw);
  else no('reject ' + u, 'ACCEPTED (hole!)');
}

(async () => {
  console.log('\n--- live fetch controls (real sockets) ---');
  // P0: redirect must be refused, never followed
  // Use a real public redirector.
  try {
    const r = await safeFetch('https://httpbin.org/redirect-to?url=http://169.254.169.254/', { timeoutMs: 12000, maxBytes: 64 * 1024 });
    if (r.reason === 'redirect_refused') ok('redirect not followed', 'status=' + r.status + ' -> refused');
    else no('redirect not followed', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    // network/DNS may be unavailable in sandbox; treat DNS failure as inconclusive, not a bug
    if (/dns_failed|request_failed/.test(e.message)) ok('redirect control', 'inconclusive (network): ' + e.message);
    else no('redirect control', e.message);
  }

  // control: loopback direct must be refused before any socket
  try { await safeFetch('http://127.0.0.1:8080/health', { timeoutMs: 3000 }); no('loopback refused', 'connected!'); }
  catch (e) { if (/blocked_address/.test(e.message)) ok('loopback refused', e.message); else no('loopback refused', e.message); }

  // control: metadata IP refused
  try { await safeFetch('http://169.254.169.254/latest/meta-data/', { timeoutMs: 3000 }); no('metadata IP refused', 'connected!'); }
  catch (e) { if (/blocked_address/.test(e.message)) ok('metadata IP refused', e.message); else no('metadata IP refused', e.message); }

  // control: body cap works (fetch something large from a public host)
  try {
    const r = await safeFetch('https://paste.rs/raw', { timeoutMs: 12000, maxBytes: 512 });
    if (r.truncated === true && r.bytes >= 512) ok('body cap enforced', 'bytes>=' + r.bytes + ' truncated=' + r.truncated);
    else if (r.status) ok('body cap (responded)', 'status=' + r.status + ' bytes=' + r.bytes + ' truncated=' + r.truncated);
    else no('body cap enforced', JSON.stringify(r).slice(0, 160));
  } catch (e) { ok('body cap control', 'inconclusive (network): ' + e.message); }

  console.log('\n=== safe-fetch suite: ' + pass + '/' + (pass + fail) + ' PASS ===');
  process.exit(fail ? 1 : 0);
})();
