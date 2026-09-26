'use strict';
/**
 * Optional EIP-191 signer. The key is supplied by the operator, never discovered:
 *   AUTOMATON_SIGNER_KEY      0x-prefixed hex private key, or
 *   AUTOMATON_SIGNER_KEYFILE  path to a JSON file with {privateKey} or a raw hex key.
 * Without either, loadSigner() returns null and callers must mark their output as unsigned.
 */
const fs = require('fs');
const { ethers } = require('ethers');

function parseKey(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    s = j.privateKey || j.private_key || j.key || (j.wallet && (j.wallet.privateKey || j.wallet.private_key)) || '';
  }
  s = String(s).trim();
  if (!s.startsWith('0x')) s = '0x' + s;
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('signer: malformed private key');
  return s;
}

const { createGuardedWallet, assertSpendAllowed, isSpendLocked } = require('./wallet-guard');

function loadSigner(env = process.env) {
  let raw = env.AUTOMATON_SIGNER_KEY;
  if (!raw && env.AUTOMATON_SIGNER_KEYFILE) raw = fs.readFileSync(env.AUTOMATON_SIGNER_KEYFILE, 'utf8');
  if (!raw) return null;
  const rawWallet = new ethers.Wallet(parseKey(raw));
  const wallet = createGuardedWallet(rawWallet, { env });
  return { address: rawWallet.address, wallet, signMessage: m => rawWallet.signMessage(m) };
}

const recoverSigner = (message, signature) => ethers.verifyMessage(message, signature);

module.exports = { loadSigner, recoverSigner, parseKey, createGuardedWallet, assertSpendAllowed, isSpendLocked };

