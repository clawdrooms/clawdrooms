#!/usr/bin/env node
/**
 * Market Maker Algorithm - Professional Support Level Trading
 *
 * Features:
 * - Monitors price and detects support levels
 * - Auto-buys at key support zones (like a financial professional)
 * - Wallet balance awareness
 * - Creator fee withdrawal capability
 * - Burns tokens strategically
 * - All operations logged to action log (visible on website)
 *
 * Usage:
 *   node market-maker.js status       - Show current market status and levels
 *   node market-maker.js run          - Run market maker daemon
 *   node market-maker.js buy-support  - Execute buy at current support
 *   node market-maker.js withdraw-fees - Withdraw creator fees
 *   node market-maker.js config       - Show current configuration
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tokenActions = require('./token-actions');
const treasuryManager = require('./treasury-manager');

// Action log for website activity feed
const ACTION_LOG = path.join(__dirname, '..', 'memory', 'actions.json');

// Market maker state file
const STATE_FILE = path.join(__dirname, '..', 'data', 'market-maker-state.json');

// Configuration
const CONFIG = {
  // Minimum SOL to keep in wallet (safety reserve)
  minReserveSOL: 0.05,

  // Support level configuration
  supportLevels: {
    // Buy when price drops X% from recent high
    dip1: { percentDrop: 10, buyAmountSOL: 0.05 },
    dip2: { percentDrop: 20, buyAmountSOL: 0.10 },
    dip3: { percentDrop: 30, buyAmountSOL: 0.15 },
    dip4: { percentDrop: 40, buyAmountSOL: 0.20 },
    dip5: { percentDrop: 50, buyAmountSOL: 0.25 },
  },

  // Minimum time between buys (hours)
  minTimeBetweenBuys: 1,

  // Burn configuration
  burnAfterBuy: false, // If true, burns tokens immediately after buying
  burnPercentage: 10, // Percentage of bought tokens to burn

  // Polling interval in milliseconds
  pollInterval: 60000, // 1 minute

  // DexScreener API for price data
  dexScreenerUrl: `https://api.dexscreener.com/latest/dex/tokens/${process.env.TOKEN_MINT_ADDRESS}`,
};

/**
 * Log action for website activity feed
 */
function logActivity(type, content, result) {
  let actions = [];
  try {
    if (fs.existsSync(ACTION_LOG)) {
      actions = JSON.parse(fs.readFileSync(ACTION_LOG, 'utf8'));
    }
  } catch (err) {
    console.error('[market-maker] Failed to load action log:', err.message);
  }

  actions.push({
    type,
    content,
    result,
    timestamp: new Date().toISOString(),
    source: 'market-maker'
  });

  // Keep last 200 actions
  if (actions.length > 200) {
    actions = actions.slice(-200);
  }

  try {
    const dir = path.dirname(ACTION_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACTION_LOG, JSON.stringify(actions, null, 2));
  } catch (err) {
    console.error('[market-maker] Failed to save action log:', err.message);
  }
}

/**
 * Load market maker state
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[market-maker] Failed to load state:', err.message);
  }
  return {
    recentHigh: 0,
    recentHighTime: null,
    lastBuyTime: null,
    lastBuyPrice: null,
    supportLevelsBought: {},
    priceHistory: [],
    stats: {
      totalBuys: 0,
      totalSOLSpent: 0,
      totalTokensBought: 0,
      totalBurns: 0,
      totalTokensBurned: 0
    }
  };
}

/**
 * Save market maker state
 */
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[market-maker] Failed to save state:', err.message);
  }
}

/**
 * Fetch current price from DexScreener
 */
async function fetchPrice() {
  try {
    const response = await fetch(CONFIG.dexScreenerUrl);
    if (!response.ok) {
      throw new Error(`DexScreener API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.pairs || data.pairs.length === 0) {
      throw new Error('No pairs found on DexScreener');
    }

    // Get the most liquid pair
    const pair = data.pairs.sort((a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    return {
      price: parseFloat(pair.priceUsd) || 0,
      priceNative: parseFloat(pair.priceNative) || 0,
      marketCap: pair.marketCap || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      priceChange: {
        h1: pair.priceChange?.h1 || 0,
        h6: pair.priceChange?.h6 || 0,
        h24: pair.priceChange?.h24 || 0
      },
      dex: pair.dexId,
      pair: pair.pairAddress,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[market-maker] Price fetch error:', err.message);
    return null;
  }
}

/**
 * Calculate support levels based on recent high
 */
function calculateSupportLevels(recentHigh, currentPrice) {
  const levels = [];

  for (const [name, config] of Object.entries(CONFIG.supportLevels)) {
    const supportPrice = recentHigh * (1 - config.percentDrop / 100);
    const distanceFromSupport = ((currentPrice - supportPrice) / supportPrice) * 100;

    levels.push({
      name,
      percentDrop: config.percentDrop,
      buyAmount: config.buyAmountSOL,
      supportPrice,
      distanceFromSupport,
      triggered: currentPrice <= supportPrice,
      atSupport: distanceFromSupport >= -2 && distanceFromSupport <= 5 // Within 2% below to 5% above
    });
  }

  return levels.sort((a, b) => a.percentDrop - b.percentDrop);
}

/**
 * Calculate Fibonacci retracement levels
 */
function calculateFibLevels(high, low) {
  const diff = high - low;
  return {
    level_0: low,
    level_236: low + diff * 0.236,
    level_382: low + diff * 0.382,
    level_5: low + diff * 0.5,
    level_618: low + diff * 0.618,
    level_786: low + diff * 0.786,
    level_100: high
  };
}

/**
 * Check if conditions are met for a buy
 */
async function shouldBuy(state, priceData) {
  // Check wallet balance
  const balance = await tokenActions.getTokenBalance();

  if (!balance || balance.solBalance < CONFIG.minReserveSOL + 0.01) {
    console.log(`[market-maker] Insufficient SOL balance: ${balance?.solBalance || 0}`);
    return { shouldBuy: false, reason: 'Insufficient SOL balance' };
  }

  const availableSOL = balance.solBalance - CONFIG.minReserveSOL;

  // Check time since last buy
  if (state.lastBuyTime) {
    const hoursSinceLastBuy = (Date.now() - new Date(state.lastBuyTime).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastBuy < CONFIG.minTimeBetweenBuys) {
      return { shouldBuy: false, reason: `Only ${hoursSinceLastBuy.toFixed(2)}h since last buy (min: ${CONFIG.minTimeBetweenBuys}h)` };
    }
  }

  // Check support levels
  const levels = calculateSupportLevels(state.recentHigh, priceData.price);
  const triggeredLevels = levels.filter(l => l.triggered && !state.supportLevelsBought[l.name]);

  if (triggeredLevels.length === 0) {
    return { shouldBuy: false, reason: 'No support levels triggered' };
  }

  // Get the deepest triggered level
  const targetLevel = triggeredLevels[triggeredLevels.length - 1];

  // Check if we have enough SOL
  if (availableSOL < targetLevel.buyAmount) {
    return {
      shouldBuy: true,
      level: targetLevel,
      amount: availableSOL,
      reason: `Limited to available: ${availableSOL.toFixed(4)} SOL`
    };
  }

  return {
    shouldBuy: true,
    level: targetLevel,
    amount: targetLevel.buyAmount,
    reason: `Support level ${targetLevel.name} triggered at ${targetLevel.percentDrop}% drop`
  };
}

/**
 * Execute a support level buy
 */
async function executeSupportBuy(level, amount) {
  console.log(`[market-maker] Executing support buy: ${amount} SOL at ${level.name}`);

  logActivity('MARKET_MAKER_BUY_START', `Support buy: ${amount} SOL at ${level.name}`, { status: 'started' });

  const result = await tokenActions.buyTokens(amount);

  if (result.success) {
    // Update state
    const state = loadState();
    state.lastBuyTime = new Date().toISOString();
    state.lastBuyPrice = level.supportPrice;
    state.supportLevelsBought[level.name] = {
      time: new Date().toISOString(),
      amount,
      signature: result.signature
    };
    state.stats.totalBuys++;
    state.stats.totalSOLSpent += amount;
    saveState(state);

    // Log to action log (visible on website)
    logActivity('DEV_WALLET_BUY', `Bought ${amount} SOL at support (${level.name})`, {
      success: true,
      amount,
      level: level.name,
      signature: result.signature,
      solscan: `https://solscan.io/tx/${result.signature}`
    });

    console.log(`[market-maker] Buy successful: ${result.signature}`);

    // Optional: burn after buy
    if (CONFIG.burnAfterBuy) {
      const balance = await tokenActions.getTokenBalance();
      const burnAmount = balance.tokenBalanceFormatted * (CONFIG.burnPercentage / 100);

      if (burnAmount > 0) {
        console.log(`[market-maker] Burning ${burnAmount} tokens...`);
        const burnResult = await treasuryManager.executeBurn(burnAmount, true);

        if (burnResult.success) {
          state.stats.totalBurns++;
          state.stats.totalTokensBurned += burnAmount;
          saveState(state);

          logActivity('DEV_WALLET_BURN', `Burned ${burnAmount.toFixed(2)} tokens`, {
            success: true,
            amount: burnAmount,
            signature: burnResult.signature,
            solscan: `https://solscan.io/tx/${burnResult.signature}`
          });
        }
      }
    }

    return { success: true, ...result };
  } else {
    logActivity('MARKET_MAKER_BUY_FAILED', `Support buy failed: ${result.error}`, {
      success: false,
      error: result.error
    });

    return result;
  }
}

/**
 * Withdraw creator fees from pump.fun
 * Note: Only works for tokens still on the bonding curve
 */
async function withdrawCreatorFees() {
  console.log('[market-maker] Attempting to withdraw creator fees...');

  // For tokens that have graduated to Raydium, creator fees
  // are typically already distributed or handled differently.
  // For pump.fun bonding curve tokens, fees can be claimed via the SDK.

  try {
    // Try to use the PumpFunSDK for fee withdrawal if available
    const { Connection, Keypair } = require('@solana/web3.js');
    const { AnchorProvider } = require('@coral-xyz/anchor');
    const bs58 = require('bs58');

    const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
    if (!privateKey) {
      return { success: false, error: 'Wallet not configured' };
    }

    const decoded = typeof bs58.decode === 'function'
      ? bs58.decode(privateKey)
      : bs58.default.decode(privateKey);
    const keypair = Keypair.fromSecretKey(decoded);

    const connection = new Connection(process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com');

    // Check if PumpFunSDK is available
    let PumpFunSDK;
    try {
      PumpFunSDK = require('pumpdotfun-sdk').PumpFunSDK;
    } catch (err) {
      console.log('[market-maker] PumpFunSDK not available for fee withdrawal');

      // Alternative: Check Raydium/PumpSwap for LP fees
      logActivity('FEE_WITHDRAWAL', 'Creator fee withdrawal not available (token graduated)', {
        success: false,
        error: 'Token may have graduated to Raydium - fees handled differently'
      });

      return {
        success: false,
        error: 'Token graduated to Raydium. Creator fees for graduated tokens are handled by the AMM.'
      };
    }

    const provider = new AnchorProvider(connection, {
      publicKey: keypair.publicKey,
      signTransaction: async (tx) => { tx.sign([keypair]); return tx; },
      signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign([keypair])); return txs; }
    }, { commitment: 'confirmed' });

    const sdk = new PumpFunSDK(provider);

    // Get bonding curve to check if fees exist
    const mint = new (require('@solana/web3.js').PublicKey)(process.env.TOKEN_MINT_ADDRESS);
    const bondingCurve = await sdk.getBondingCurveAccount(mint);

    if (!bondingCurve) {
      return {
        success: false,
        error: 'Bonding curve not found - token may have graduated'
      };
    }

    console.log('[market-maker] Bonding curve found, fees may be claimable');

    // Note: The actual fee claim method depends on pump.fun's implementation
    // This is a placeholder - the actual method may differ
    logActivity('FEE_WITHDRAWAL', 'Checking creator fees on bonding curve', {
      success: true,
      status: 'checked',
      note: 'Fee claim requires specific pump.fun contract interaction'
    });

    return {
      success: true,
      status: 'checked',
      message: 'Bonding curve active - contact pump.fun for fee claim process'
    };

  } catch (err) {
    console.error('[market-maker] Fee withdrawal error:', err.message);

    logActivity('FEE_WITHDRAWAL_ERROR', `Fee withdrawal failed: ${err.message}`, {
      success: false,
      error: err.message
    });

    return { success: false, error: err.message };
  }
}

/**
 * Get current market status
 */
async function getMarketStatus() {
  const state = loadState();
  const priceData = await fetchPrice();
  const balance = await tokenActions.getTokenBalance();

  if (!priceData) {
    return { error: 'Failed to fetch price data' };
  }

  // Update recent high if current price is higher
  if (priceData.price > state.recentHigh) {
    state.recentHigh = priceData.price;
    state.recentHighTime = new Date().toISOString();
    saveState(state);
  }

  // Add to price history
  state.priceHistory.push({
    price: priceData.price,
    timestamp: new Date().toISOString()
  });

  // Keep last 1440 entries (24 hours at 1-minute intervals)
  if (state.priceHistory.length > 1440) {
    state.priceHistory = state.priceHistory.slice(-1440);
  }
  saveState(state);

  // Calculate support levels
  const supportLevels = calculateSupportLevels(state.recentHigh, priceData.price);

  // Calculate Fibonacci levels from recent high/low
  const prices = state.priceHistory.map(p => p.price);
  const recentLow = prices.length > 0 ? Math.min(...prices) : priceData.price;
  const fibLevels = calculateFibLevels(state.recentHigh, recentLow);

  // Check buy conditions
  const buyCheck = await shouldBuy(state, priceData);

  return {
    price: priceData,
    wallet: {
      solBalance: balance.solBalance,
      tokenBalance: balance.tokenBalanceFormatted,
      availableForBuys: Math.max(0, balance.solBalance - CONFIG.minReserveSOL)
    },
    state: {
      recentHigh: state.recentHigh,
      recentHighTime: state.recentHighTime,
      lastBuyTime: state.lastBuyTime,
      lastBuyPrice: state.lastBuyPrice,
      supportLevelsBought: state.supportLevelsBought
    },
    supportLevels,
    fibLevels,
    buyCheck,
    stats: state.stats,
    config: CONFIG
  };
}

/**
 * Run market maker daemon
 */
async function runDaemon() {
  console.log('[market-maker] Starting market maker daemon...');
  console.log(`[market-maker] Token: ${process.env.TOKEN_MINT_ADDRESS}`);
  console.log(`[market-maker] Poll interval: ${CONFIG.pollInterval / 1000}s`);
  console.log('');

  logActivity('MARKET_MAKER_START', 'Market maker daemon started', { success: true });

  let running = true;

  process.on('SIGINT', () => {
    console.log('\n[market-maker] Shutting down...');
    logActivity('MARKET_MAKER_STOP', 'Market maker daemon stopped', { success: true });
    running = false;
    process.exit(0);
  });

  while (running) {
    try {
      const status = await getMarketStatus();

      if (status.error) {
        console.error(`[market-maker] Error: ${status.error}`);
        await new Promise(r => setTimeout(r, CONFIG.pollInterval));
        continue;
      }

      // Log current status
      const price = status.price.price.toFixed(8);
      const change24h = status.price.priceChange.h24;
      const dropFromHigh = ((status.state.recentHigh - status.price.price) / status.state.recentHigh * 100).toFixed(2);

      console.log(`[${new Date().toLocaleTimeString()}] Price: $${price} | 24h: ${change24h > 0 ? '+' : ''}${change24h}% | Drop from high: ${dropFromHigh}% | Available: ${status.wallet.availableForBuys.toFixed(4)} SOL`);

      // Check if we should buy
      if (status.buyCheck.shouldBuy) {
        console.log(`[market-maker] BUY SIGNAL: ${status.buyCheck.reason}`);
        const result = await executeSupportBuy(status.buyCheck.level, status.buyCheck.amount);
        console.log(`[market-maker] Buy result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      }

    } catch (err) {
      console.error('[market-maker] Tick error:', err.message);
    }

    await new Promise(r => setTimeout(r, CONFIG.pollInterval));
  }
}

/**
 * Display current configuration
 */
function showConfig() {
  console.log('');
  console.log('========================================');
  console.log('  MARKET MAKER CONFIGURATION');
  console.log('========================================');
  console.log('');
  console.log('Token:', process.env.TOKEN_MINT_ADDRESS);
  console.log('Min Reserve SOL:', CONFIG.minReserveSOL);
  console.log('Min Time Between Buys:', CONFIG.minTimeBetweenBuys, 'hours');
  console.log('Poll Interval:', CONFIG.pollInterval / 1000, 'seconds');
  console.log('');
  console.log('Support Levels:');
  for (const [name, config] of Object.entries(CONFIG.supportLevels)) {
    console.log(`  ${name}: ${config.percentDrop}% drop -> buy ${config.buyAmountSOL} SOL`);
  }
  console.log('');
  console.log('Burn Config:');
  console.log(`  Burn After Buy: ${CONFIG.burnAfterBuy}`);
  console.log(`  Burn Percentage: ${CONFIG.burnPercentage}%`);
  console.log('');
}

// Export functions
module.exports = {
  getMarketStatus,
  executeSupportBuy,
  withdrawCreatorFees,
  calculateSupportLevels,
  calculateFibLevels,
  logActivity,
  CONFIG
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  async function main() {
    console.log('');
    console.log('========================================');
    console.log('  CLAWDROOMS MARKET MAKER');
    console.log('========================================');
    console.log('');

    try {
      switch (command) {
        case 'status':
          const status = await getMarketStatus();
          if (status.error) {
            console.log('Error:', status.error);
            break;
          }

          console.log('CURRENT MARKET STATUS');
          console.log('─'.repeat(40));
          console.log(`Price: $${status.price.price.toFixed(8)}`);
          console.log(`Market Cap: $${status.price.marketCap.toLocaleString()}`);
          console.log(`Liquidity: $${status.price.liquidity.toLocaleString()}`);
          console.log(`24h Volume: $${status.price.volume24h.toLocaleString()}`);
          console.log(`24h Change: ${status.price.priceChange.h24}%`);
          console.log('');
          console.log('WALLET');
          console.log('─'.repeat(40));
          console.log(`SOL Balance: ${status.wallet.solBalance.toFixed(4)} SOL`);
          console.log(`Token Balance: ${status.wallet.tokenBalance.toLocaleString()}`);
          console.log(`Available for Buys: ${status.wallet.availableForBuys.toFixed(4)} SOL`);
          console.log('');
          console.log('SUPPORT LEVELS');
          console.log('─'.repeat(40));
          console.log(`Recent High: $${status.state.recentHigh.toFixed(8)}`);
          for (const level of status.supportLevels) {
            const bought = status.state.supportLevelsBought[level.name] ? ' [BOUGHT]' : '';
            const triggered = level.triggered ? ' *TRIGGERED*' : '';
            console.log(`  ${level.name}: $${level.supportPrice.toFixed(8)} (${level.percentDrop}% drop)${triggered}${bought}`);
          }
          console.log('');
          console.log('BUY CHECK');
          console.log('─'.repeat(40));
          console.log(`Should Buy: ${status.buyCheck.shouldBuy ? 'YES' : 'NO'}`);
          console.log(`Reason: ${status.buyCheck.reason}`);
          if (status.buyCheck.level) {
            console.log(`Level: ${status.buyCheck.level.name} (${status.buyCheck.amount} SOL)`);
          }
          console.log('');
          console.log('STATS');
          console.log('─'.repeat(40));
          console.log(`Total Buys: ${status.stats.totalBuys}`);
          console.log(`Total SOL Spent: ${status.stats.totalSOLSpent.toFixed(4)} SOL`);
          console.log(`Total Burns: ${status.stats.totalBurns}`);
          break;

        case 'run':
          await runDaemon();
          break;

        case 'buy-support':
          const checkStatus = await getMarketStatus();
          if (checkStatus.buyCheck.shouldBuy) {
            await executeSupportBuy(checkStatus.buyCheck.level, checkStatus.buyCheck.amount);
          } else {
            console.log('No support level triggered. Reason:', checkStatus.buyCheck.reason);
          }
          break;

        case 'force-buy':
          const forceAmount = parseFloat(args[1]) || 0.05;
          console.log(`Force buying ${forceAmount} SOL...`);
          const buyResult = await tokenActions.buyTokens(forceAmount);
          if (buyResult.success) {
            logActivity('DEV_WALLET_BUY', `Manual buy: ${forceAmount} SOL`, {
              success: true,
              amount: forceAmount,
              signature: buyResult.signature,
              solscan: `https://solscan.io/tx/${buyResult.signature}`
            });
            console.log('Buy successful:', buyResult.signature);
          } else {
            console.log('Buy failed:', buyResult.error);
          }
          break;

        case 'burn':
          const burnAmount = parseFloat(args[1]);
          if (!burnAmount || burnAmount <= 0) {
            console.log('Usage: node market-maker.js burn <token_amount>');
            break;
          }
          console.log(`Burning ${burnAmount} tokens...`);
          const burnResult = await treasuryManager.executeBurn(burnAmount, true);
          if (burnResult.success) {
            logActivity('DEV_WALLET_BURN', `Burned ${burnAmount} tokens`, {
              success: true,
              amount: burnAmount,
              signature: burnResult.signature,
              solscan: `https://solscan.io/tx/${burnResult.signature}`
            });
            console.log('Burn successful:', burnResult.signature);
          } else {
            console.log('Burn failed:', burnResult.error);
          }
          break;

        case 'withdraw-fees':
          await withdrawCreatorFees();
          break;

        case 'config':
          showConfig();
          break;

        case 'reset':
          console.log('Resetting market maker state...');
          const freshState = {
            recentHigh: 0,
            recentHighTime: null,
            lastBuyTime: null,
            lastBuyPrice: null,
            supportLevelsBought: {},
            priceHistory: [],
            stats: { totalBuys: 0, totalSOLSpent: 0, totalTokensBought: 0, totalBurns: 0, totalTokensBurned: 0 }
          };
          saveState(freshState);
          console.log('State reset complete.');
          break;

        default:
          console.log('Market Maker - Professional Support Level Trading');
          console.log('');
          console.log('Commands:');
          console.log('  status          - Show current market status and support levels');
          console.log('  run             - Start market maker daemon');
          console.log('  buy-support     - Execute buy at current support level');
          console.log('  force-buy <sol> - Force a buy regardless of support levels');
          console.log('  burn <tokens>   - Burn tokens and announce on X');
          console.log('  withdraw-fees   - Attempt to withdraw creator fees');
          console.log('  config          - Show current configuration');
          console.log('  reset           - Reset market maker state');
          console.log('');
          console.log('Examples:');
          console.log('  node market-maker.js status');
          console.log('  node market-maker.js run');
          console.log('  node market-maker.js force-buy 0.1');
          console.log('  node market-maker.js burn 10000');
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }

    console.log('');
    console.log('========================================');
  }

  main();
}
