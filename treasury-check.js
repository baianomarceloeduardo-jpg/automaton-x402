// treasury-check.js — read my real on-chain position to decide the next capital allocation.
const https = require('https');
const ME = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RPCS = ['https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://1rpc.io/base', 'https://mainnet.base.org'];

function rpc(url, method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 12000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).result); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

(async () => {
  for (const u of RPCS) {
    const b = await rpc(u, 'eth_getBalance', [ME, 'latest']);
    const chain = await rpc(u, 'eth_chainId', []);
    if (b && chain) {
      console.log('RPC            : ' + u);
      console.log('chainId        : ' + parseInt(chain, 16));
      console.log('ETH balance    : ' + (Number(BigInt(b)) / 1e18).toFixed(8) + ' ETH');
      console.log('wallet         : ' + ME);
      break;
    }
  }
  // USDC balanceOf
  const data = '0x70a08231' + ME.slice(2).toLowerCase().padStart(64, '0');
  for (const u of RPCS) {
    const r = await rpc(u, 'eth_call', [{ to: USDC, data }, 'latest']);
    if (r && r !== '0x') {
      console.log('USDC balance   : ' + (Number(BigInt(r)) / 1e6).toFixed(6) + ' USDC');
      break;
    }
  }
})();
