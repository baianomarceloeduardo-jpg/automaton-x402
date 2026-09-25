/**
 * Automaton-Sovereign: On-Chain Treasury & Revenue Telemetry
 * Audits creator wallet balances (ETH & USDC) on Base Mainnet via JSON-RPC.
 */

const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function getTreasuryBalances(rpcFn, stats = {}, spentTxCount = 0) {
  try {
    // 1. Query ETH balance
    const ethHex = await rpcFn('eth_getBalance', [PAY_TO, 'latest']);
    const ethWei = BigInt(ethHex || '0x0');
    const ethFormatted = (Number(ethWei) / 1e18).toFixed(6);

    // 2. Query USDC balance via ERC-20 balanceOf
    const data = '0x70a08231' + PAY_TO.toLowerCase().replace('0x', '').padStart(64, '0');
    const usdcHex = await rpcFn('eth_call', [{ to: USDC_BASE, data }, 'latest']);
    const usdcUnits = BigInt(usdcHex || '0x0');
    const usdcFormatted = (Number(usdcUnits) / 1e6).toFixed(4);

    // 3. Cumulative stats
    const paidCalls = stats.paidCalls || 0;
    const earnedUsdcEstimate = (paidCalls * 0.001).toFixed(4);

    return {
      network: 'base',
      chainId: 8453,
      payTo: PAY_TO,
      token: {
        symbol: 'USDC',
        address: USDC_BASE,
        balance: usdcFormatted,
        baseUnits: usdcUnits.toString(),
        decimals: 6
      },
      gasAsset: {
        symbol: 'ETH',
        balance: ethFormatted,
        wei: ethWei.toString(),
        decimals: 18
      },
      telemetry: {
        totalPaidCalls: paidCalls,
        verifiedTransactions: spentTxCount,
        estimatedRevenueUsdc: earnedUsdcEstimate,
        freeTrialCallsServed: stats.trialCalls || 0,
        unpaidChallengesIssued: stats.unpaidChallenges || 0
      },
      explorer: {
        addressUrl: `https://basescan.org/address/${PAY_TO}`,
        usdcTokenUrl: `https://basescan.org/token/${USDC_BASE}?a=${PAY_TO}`
      },
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return {
      error: 'rpc_failure',
      message: 'Failed to query on-chain balances: ' + err.message,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  getTreasuryBalances,
  PAY_TO,
  USDC_BASE
};
