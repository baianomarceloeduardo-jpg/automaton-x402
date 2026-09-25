/**
 * Automaton-Sovereign: Base Token Safety & Honeypot Analyzer
 * Accurate EVM bytecode disassembly scanning for dangerous opcodes, honeypot traps,
 * mint inflation, transfer restrictions, and algorithmic risk scoring.
 */

const crypto = require('crypto');

const SELECTORS = {
  totalSupply: '18160ddd',
  balanceOf: '70a08231',
  transfer: 'a9059cbb',
  approve: '095ea7b3',
  transferFrom: '23b872dd',
  allowance: 'dd62ed3e',
  // Admin & Risk selectors
  mint: '40c10f19',
  burn: '42966c68',
  pause: '02319623',
  unpause: '3f4ba83a',
  blacklist: 'f9f80b88',
  setTax: '1694501d',
  setMaxTx: '868e10c4',
  setTrading: '8a8c523c',
  owner: '8da5cb5b',
  renounceOwnership: '715018a6'
};

const KNOWN_SAFE = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USDC', symbol: 'USDC', verified: true, baselineRisk: 2 },
  '0x4200000000000000000000000000000000000006': { name: 'WETH', symbol: 'WETH', verified: true, baselineRisk: 0 },
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { name: 'Aerodrome', symbol: 'AERO', verified: true, baselineRisk: 5 },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { name: 'Coinbase Wrapped BTC', symbol: 'cbBTC', verified: true, baselineRisk: 3 },
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': { name: 'Virtual Protocol', symbol: 'VIRTUAL', verified: true, baselineRisk: 6 }
};

/**
 * Accurately parses EVM instructions by skipping PUSH immediate data.
 */
function scanOpcode(codeBytes, targetOpcode) {
  let i = 0;
  while (i < codeBytes.length) {
    const op = codeBytes[i];
    if (op === targetOpcode) return true;
    if (op >= 0x60 && op <= 0x7f) {
      // PUSH1..PUSH32: skip immediate data bytes
      i += (op - 0x5f);
    }
    i++;
  }
  return false;
}

async function scanTokenContract(rawAddress, rpcFn) {
  const addr = String(rawAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return { error: 'invalid_address', message: 'Address must be a 40-hex character Ethereum address with 0x prefix' };
  }

  // 1. Fetch live bytecode from Base RPC
  let bytecode = '0x';
  try {
    bytecode = await rpcFn('eth_getCode', [addr, 'latest']);
  } catch (err) {
    return { error: 'rpc_error', message: 'Failed to retrieve contract bytecode from Base: ' + err.message };
  }

  const isContract = Boolean(bytecode && bytecode !== '0x' && bytecode !== '0x0' && bytecode.length > 2);
  if (!isContract) {
    return {
      address: addr,
      network: 'base',
      chainId: 8453,
      isContract: false,
      riskScore: 100,
      verdict: 'NOT_A_CONTRACT',
      summary: 'The specified address has no deployed bytecode on Base (EOA wallet or undeployed address).',
      flags: ['NO_BYTECODE_PRESENT'],
      checks: { hasBytecode: false },
      timestamp: new Date().toISOString()
    };
  }

  const codeHex = bytecode.slice(2).toLowerCase();
  const codeBytes = Buffer.from(codeHex, 'hex');
  const byteLength = codeBytes.length;

  const isKnown = Boolean(KNOWN_SAFE[addr]);
  const knownProfile = KNOWN_SAFE[addr] || null;

  // 2. Interface detection via selectors
  const detectedSelectors = [];
  const flags = [];
  let riskScore = isKnown ? knownProfile.baselineRisk : 10;

  const isErc20 = ['totalSupply', 'balanceOf', 'transfer', 'approve'].every(s => {
    const present = codeHex.includes(SELECTORS[s]);
    if (present) detectedSelectors.push(s);
    return present;
  });

  if (!isErc20 && !isKnown) {
    flags.push('NON_STANDARD_ERC20');
    riskScore += 15;
  }

  // 3. Accurate EVM Opcode Checks (skipping PUSH data)
  const hasSelfDestruct = scanOpcode(codeBytes, 0xff); // 0xff = SELFDESTRUCT
  if (hasSelfDestruct) {
    flags.push('HAS_SELFDESTRUCT_OPCODE');
    if (!isKnown) riskScore += 40;
  }

  const hasDelegateCall = scanOpcode(codeBytes, 0xf4); // 0xf4 = DELEGATECALL
  if (hasDelegateCall) {
    flags.push('HAS_DELEGATECALL_PROXY');
    if (!isKnown) riskScore += 10;
  }

  // 4. Selector-based capability checks
  const hasMint = codeHex.includes(SELECTORS.mint);
  if (hasMint) {
    flags.push('CAN_MINT_NEW_TOKENS');
    if (!isKnown) riskScore += 15;
  }

  const hasBlacklist = codeHex.includes(SELECTORS.blacklist);
  if (hasBlacklist) {
    flags.push('CONTAINS_BLACKLIST_RESTRICTION');
    if (!isKnown) riskScore += 20;
  }

  const hasTaxConfig = codeHex.includes(SELECTORS.setTax) || codeHex.includes(SELECTORS.setMaxTx);
  if (hasTaxConfig) {
    flags.push('CONFIGURABLE_TRANSFER_TAX');
    if (!isKnown) riskScore += 25;
  }

  const hasPause = codeHex.includes(SELECTORS.pause) || codeHex.includes(SELECTORS.unpause);
  if (hasPause) {
    flags.push('CAN_PAUSE_TRANSFERS');
    if (!isKnown) riskScore += 10;
  }

  // Proxy storage slots (EIP-1967)
  const isEip1967Proxy = codeHex.includes('360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  if (isEip1967Proxy) {
    flags.push('EIP1967_UPGRADEABLE_PROXY');
  }

  if (isKnown) {
    flags.push('VERIFIED_INSTITUTIONAL_ASSET');
    riskScore = knownProfile.baselineRisk;
  } else {
    riskScore = Math.max(0, Math.min(100, riskScore));
  }

  // Verdict calculation
  let verdict = 'SAFE';
  let isHoneypot = false;

  if (!isKnown && (riskScore >= 70 || (hasSelfDestruct && hasTaxConfig))) {
    verdict = 'DANGER_HONEYPOT_RISK';
    isHoneypot = true;
  } else if (!isKnown && riskScore >= 45) {
    verdict = 'HIGH_RISK_CAUTION';
  } else if (riskScore >= 20) {
    verdict = 'MODERATE_RISK';
  } else {
    verdict = 'SAFE';
  }

  return {
    address: addr,
    network: 'base',
    chainId: 8453,
    isContract: true,
    isHoneypot,
    riskScore,
    verdict,
    summary: isHoneypot 
      ? 'High probability of honeypot traps or severe transfer restrictions detected.' 
      : (riskScore < 20 ? 'Standard token structure verified with low risk surface.' : 'Contract has elevated admin controls or non-standard token methods.'),
    flags,
    bytecode: {
      byteLength,
      codeHash: crypto.createHash('sha256').update(codeHex).digest('hex'),
      isEip1967Proxy
    },
    checks: {
      hasBytecode: true,
      isErc20Compliant: isErc20,
      hasSelfDestruct,
      hasDelegateCall,
      hasMintFunction: hasMint,
      hasBlacklistFunction: hasBlacklist,
      hasTaxConfig,
      hasPauseFunction: hasPause
    },
    knownAsset: knownProfile ? { name: knownProfile.name, symbol: knownProfile.symbol } : null,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  scanTokenContract,
  scanOpcode,
  KNOWN_SAFE,
  SELECTORS
};
