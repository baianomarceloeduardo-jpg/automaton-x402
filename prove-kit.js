// prove-kit.js — prove x402-v2-kit.js works on a FRESH, naive v1 server. 12 checks.
// This is the distribution artifact's own proof: a stranger can copy one file and become v2.
'use strict';
const http = require('http');
const crypto = require('crypto');
const kit = require(require('path').join(__dirname, 'x402-v2-kit.js'));

let ethers = null; try { ethers = require('ethers'); } catch (e) {}
const R = []; const ck = (n, ok, d) => { R.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? '  -- ' + d : '')); };

kit.install(http, { payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', authHeader: 'x-payment-auth' });

const PAYTO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PORT = 8141;

// A NAIVE legacy v1 server: emits v1 402, and "verifies" payment by trusting X-PAYMENT-AUTH.
// That is exactly what a stranger's server looks like before installing the kit.
const srv = http.createServer((req, res) => {
  if (req.headers['x-payment-auth']) {
    let p = {}; try { p = JSON.parse(Buffer.from(req.headers['x-payment-auth'], 'base64').toString()); } catch (e) {}
    return res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, payer: (p.payload && p.payload.authorization && p.payload.authorization.from) || null }));
  }
  res.writeHead(402, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ x402Version: 1, error: 'payment_required', accepts: [
    { scheme: 'exact', network: 'base', maxAmountRequired: '1000', asset: kit.USDC_BASE, payTo: PAYTO } ] }));
});

const get = hdrs => new Promise(r => {
  const q = http.request({ host: '127.0.0.1', port: PORT, path: '/paid', headers: hdrs || {}, timeout: 5000 }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => r({ status: res.statusCode, headers: res.headers, body: b }));
  });
  q.on('error', e => r({ status: 0, error: e.message })); q.end();
});

(async () => {
  if (!ethers) { console.log('SKIP: ethers missing'); process.exit(2); }
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  const c = await get({});
  ck('1 naive server still returns 402', c.status === 402, 'status=' + c.status);
  ck('2 header X-402-Version: 2 present after kit', c.headers['x-402-version'] === '2', c.headers['x-402-version']);
  ck('3 PAYMENT-REQUIRED header present', !!c.headers['payment-required']);
  let j = null; try { j = JSON.parse(c.body); } catch (e) {}
  ck('4 body upgraded to x402Version 2', !!j && j.x402Version === 2, j ? String(j.x402Version) : 'unparseable');
  const a = j && j.accepts && j.accepts[0];
  ck('5 accept network is CAIP-2 eip155:8453', !!a && a.network === 'eip155:8453', a && a.network);
  ck('6 amount preserved (1000)', !!a && a.amount === '1000' && a.maxAmountRequired === '1000', a && a.amount);
  ck('7 extra.credentialTypes = ["authorization"]', !!a && a.extra && Array.isArray(a.extra.credentialTypes) && a.extra.credentialTypes[0] === 'authorization');
  ck('8 legacy v1 mirror retained (v1 buyers unbroken)', !!j && !!j.legacy && j.legacy.x402Version === 1 && j.legacy.accepts[0].network === 'base');
  ck('9 Content-Length matches the upgraded body (no truncation)',
    Number(c.headers['content-length']) === Buffer.byteLength(c.body), c.headers['content-length'] + ' vs ' + Buffer.byteLength(c.body));

  // Now the accept path: sign a real v2 envelope and send it.
  const payer = ethers.Wallet.createRandom();
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: payer.address, to: PAYTO, value: '1000', validAfter: String(now - 60), validBefore: String(now + 900), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const sig = await payer.signTypedData(kit.EIP712_DOMAIN, kit.EIP712_TYPES, auth);
  const env = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: kit.CAIP2, payload: { authorization: auth, signature: sig } })).toString('base64');

  const paid = await get({ 'X-PAYMENT': env });
  ck('10 STANDARD v2 envelope -> 200', paid.status === 200, 'status=' + paid.status + ' ' + paid.body.slice(0, 80));
  let pb = null; try { pb = JSON.parse(paid.body); } catch (e) {}
  ck('11 payer correctly bound to authorization.from', !!pb && String(pb.payer).toLowerCase() === payer.address.toLowerCase());
  const legacy = await get({ 'X-PAYMENT': '0x' + 'ab'.repeat(32) });
  ck('12 legacy txHash untouched by the bridge (still 402)', legacy.status === 402, 'status=' + legacy.status);

  // Standalone verifier check (the caller-binding primitives).
  const vGood = await kit.verifyAuthorization({ authorization: auth, signature: sig }, { payTo: PAYTO, minUnits: 1000n });
  ck('13 verifyAuthorization accepts honest payer', vGood.ok && vGood.payer.toLowerCase() === payer.address.toLowerCase(), vGood.reason || 'ok');
  const bad = await kit.verifyAuthorization({ authorization: auth, signature: await ethers.Wallet.createRandom().signTypedData(kit.EIP712_DOMAIN, kit.EIP712_TYPES, auth) }, { payTo: PAYTO, minUnits: 1000n });
  ck('14 verifyAuthorization rejects a forged signer', bad.ok === false && bad.reason === 'signature_does_not_match_from', bad.reason);

  srv.close();
  const p = R.filter(x => x.ok).length;
  console.log('\n=== KIT ' + p + '/' + R.length + ' PASS ===');
  require('fs').writeFileSync(require('path').join(__dirname, 'prove-kit-results.json'), JSON.stringify({ at: new Date().toISOString(), passed: p, total: R.length, results: R }, null, 2));
  process.exit(p === R.length ? 0 : 1);
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
