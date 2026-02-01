#!/usr/bin/env node
/**
 * Sustainability Daemon - Professional Buyback/Burn Algorithm
 *
 * Orchestrates intelligent buyback and burn operations with:
 * - Multi-indicator timing (support levels + volume + RSI)
 * - Treasury runway protection (NORMAL/CONSERVATIVE/PAUSED modes)
 * - Strategic burn scheduling (visibility windows + accumulation)
 * - Comprehensive metrics tracking
 *
 * Usage:
 *   node sustainability-daemon.js status    - Show current state & mode
 *   node sustainability-daemon.js metrics   - Show sustainability metrics
 *   node sustainability-daemon.js simulate  - Dry run one tick
 *   node sustainability-daemon.js run       - Start daemon
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tokenActions = require('./token-actions');
const treasuryManager = require('./treasury-manager');

// Files
const STATE_FILE = path.join(__dirname, '..', 'data', 'sustainability-state.json');
const METRICS_FILE = path.join(__dirname, '..', 'data', 'sustainability-metrics.json');
const ACTION_LOG = path.join(__dirname, '..', 'memory', 'actions.json');

// Configuration
const CONFIG = {
  // Polling
  tickIntervalMs: parseInt(process.env.SUSTAINABILITY_TICK_INTERVAL) || 60 * 1000,
  priceHistoryLength: 60,

  // Support levels - increased amounts for stronger support
  supportLevels: [
    { dropPercent: 10, buyAmountSOL: 0.10 },
    { dropPercent: 20, buyAmountSOL: 0.20 },
    { dropPercent: 30, buyAmountSOL: 0.30 },
    { dropPercent: 40, buyAmountSOL: 0.40 },
    { dropPercent: 50, buyAmountSOL: 0.50 }
  ],

  // Volume confirmation
  volumeThreshold: parseFloat(process.env.SUSTAINABILITY_VOLUME_THRESHOLD) || 0.5,
  minVolume24h: parseFloat(process.env.SUSTAINABILITY_MIN_VOLUME) || 100,

  // Momentum/RSI
  rsiPeriods: 14,
  rsiOversoldThreshold: parseInt(process.env.SUSTAINABILITY_RSI_OVERSOLD) || 35,
  rsiOverboughtThreshold: parseInt(process.env.SUSTAINABILITY_RSI_OVERBOUGHT) || 70,

  // Liquidity
  maxPriceImpactPercent: 5,

  // Treasury runway
  normalRunwayDays: parseInt(process.env.SUSTAINABILITY_NORMAL_RUNWAY_DAYS) || 30,
  criticalRunwayDays: parseInt(process.env.SUSTAINABILITY_CRITICAL_RUNWAY_DAYS) || 14,
  emergencyRunwayDays: parseInt(process.env.SUSTAINABILITY_EMERGENCY_RUNWAY_DAYS) || 7,
  estimatedDailyBurnSOL: parseFloat(process.env.SUSTAINABILITY_DAILY_BURN) || 0.1,

  // Burn scheduling - burns always occur when threshold met
  minTokensToAccumulate: parseInt(process.env.SUSTAINABILITY_MIN_TOKENS_TO_BURN) || 1000000,
  minHoursBetweenBurns: parseInt(process.env.SUSTAINABILITY_MIN_HOURS_BETWEEN_BURNS) || 12,
  burnVisibilityHoursUTC: null, // null = burns can happen anytime

  // Safety
  minReserveSOL: parseFloat(process.env.SUSTAINABILITY_MIN_RESERVE) || 0.1,
  minMinutesBetweenBuys: parseInt(process.env.SUSTAINABILITY_MIN_MINUTES_BETWEEN_BUYS) || 60,
  supportLevelCooldownHours: 24,

  // Mode
  enabled: process.env.SUSTAINABILITY_ENABLED !== 'false',
  dryRun: process.env.SUSTAINABILITY_DRY_RUN === 'true',

  // DexScreener
  dexScreenerUrl: `https://api.dexscreener.com/latest/dex/tokens/${process.env.TOKEN_MINT_ADDRESS}`,
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[sustainability] Failed to load state:', err.message);
  }
  return {
    recentHigh: 0,
    recentHighTime: null,
    priceHistory: [],
    volumeHistory: [],
    lastBuyTime: null,
    lastBurnTime: null,
    tokensAccumulated: 0,
    supportLevelsBought: {},
    currentMode: 'NORMAL',
    lastModeChange: null,
    tickCount: 0,
    stats: {
      totalBuybacks: 0,
      totalSOLSpent: 0,
      totalTokensBought: 0,
      totalBurns: 0,
      totalTokensBurned: 0,
      buybacksSkippedLowVolume: 0,
      buybacksSkippedRSI: 0,
      buybacksSkippedLiquidity: 0,
      buybacksSkippedCooldown: 0
    }
  };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[sustainability] Failed to save state:', err.message);
  }
}

function loadMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[sustainability] Failed to load metrics:', err.message);
  }
  return {
    dailyBurns: [],
    dailyBuybacks: [],
    runwayHistory: [],
    lastUpdated: null
  };
}

function saveMetrics(metrics) {
  try {
    metrics.lastUpdated = new Date().toISOString();
    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
  } catch (err) {
    console.error('[sustainability] Failed to save metrics:', err.message);
  }
}

// ============================================================================
// ACTIVITY LOGGING
// ============================================================================

function logActivity(type, content, result) {
  let actions = [];
  try {
    if (fs.existsSync(ACTION_LOG)) {
      actions = JSON.parse(fs.readFileSync(ACTION_LOG, 'utf8'));
    }
  } catch (err) {
    console.error('[sustainability] Failed to load action log:', err.message);
  }

  actions.push({
    type,
    content,
    result,
    timestamp: new Date().toISOString(),
    source: 'sustainability-daemon'
  });

  if (actions.length > 200) {
    actions = actions.slice(-200);
  }

  try {
    const dir = path.dirname(ACTION_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACTION_LOG, JSON.stringify(actions, null, 2));
  } catch (err) {
    console.error('[sustainability] Failed to save action log:', err.message);
  }
}

// ============================================================================
// MARKET ANALYSIS
// ============================================================================

async function fetchMarketData() {
  try {
    const response = await fetch(CONFIG.dexScreenerUrl);
    if (!response.ok) {
      throw new Error(`DexScreener API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.pairs || data.pairs.length === 0) {
      throw new Error('No pairs found on DexScreener');
    }

    const pair = data.pairs.sort((a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    return {
      price: parseFloat(pair.priceUsd) || 0,
      priceNative: parseFloat(pair.priceNative) || 0,
      marketCap: pair.marketCap || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      volume1h: pair.volume?.h1 || 0,
      priceChange: {
        h1: pair.priceChange?.h1 || 0,
        h6: pair.priceChange?.h6 || 0,
        h24: pair.priceChange?.h24 || 0
      },
      txns24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
      dex: pair.dexId,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[sustainability] Market data fetch error:', err.message);
    return null;
  }
}

/**
 * Calculate RSI (Relative Strength Index)
 * RSI < 30 = oversold (buy opportunity)
 * RSI > 70 = overbought (avoid buying)
 */
function calculateRSI(priceHistory, periods = 14) {
  if (priceHistory.length < periods + 1) {
    return 50; // Neutral if not enough data
  }

  const prices = priceHistory.slice(-(periods + 1));
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / periods;
  const avgLoss = losses / periods;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return Math.round(rsi * 100) / 100;
}

/**
 * Calculate simple momentum
 * Positive = uptrend, Negative = downtrend
 */
function calculateMomentum(priceHistory, periods = 15) {
  if (priceHistory.length < periods) {
    return 0;
  }

  const current = priceHistory[priceHistory.length - 1];
  const past = priceHistory[priceHistory.length - periods];

  return ((current - past) / past) * 100;
}

/**
 * Check if volume is above threshold
 */
function isVolumeConfirmed(currentVolume, avgVolume) {
  if (avgVolume === 0) return true; // No history, assume OK
  return currentVolume >= avgVolume * CONFIG.volumeThreshold;
}

/**
 * Check if liquidity is sufficient for trade
 */
function isLiquiditySufficient(liquidity, tradeSizeSOL, solPrice = 100) {
  const tradeValueUSD = tradeSizeSOL * solPrice;
  const maxAcceptableImpact = liquidity * (CONFIG.maxPriceImpactPercent / 100);
  return tradeValueUSD < maxAcceptableImpact;
}

// ============================================================================
// TREASURY MANAGEMENT
// ============================================================================

/**
 * Calculate treasury runway in days
 */
function calculateTreasuryRunway(solBalance) {
  if (CONFIG.estimatedDailyBurnSOL === 0) return 999;
  return solBalance / CONFIG.estimatedDailyBurnSOL;
}

/**
 * Get treasury operating mode
 */
function getTreasuryMode(runwayDays) {
  if (runwayDays <= CONFIG.emergencyRunwayDays) {
    return 'PAUSED';
  } else if (runwayDays <= CONFIG.criticalRunwayDays) {
    return 'CONSERVATIVE';
  }
  return 'NORMAL';
}

/**
 * Get buy amount multiplier for mode
 */
function getBuyMultiplier(mode) {
  switch (mode) {
    case 'CONSERVATIVE': return 0.5;
    case 'PAUSED': return 0;
    default: return 1.0;
  }
}

// ============================================================================
// BUYBACK DECISION
// ============================================================================

/**
 * Determine if we should execute a buyback
 */
async function shouldBuyback(marketData, state, mode) {
  const result = {
    should: false,
    amount: 0,
    reason: '',
    level: null,
    indicators: {}
  };

  // Mode check
  if (mode === 'PAUSED') {
    result.reason = 'Treasury mode is PAUSED';
    return result;
  }

  // Get balance
  let balance;
  try {
    balance = await tokenActions.getTokenBalance();
  } catch (err) {
    result.reason = `Balance check failed: ${err.message}`;
    return result;
  }

  const availableSOL = balance.solBalance - CONFIG.minReserveSOL;
  if (availableSOL <= 0.01) {
    result.reason = `Insufficient SOL: ${balance.solBalance.toFixed(4)} (reserve: ${CONFIG.minReserveSOL})`;
    return result;
  }

  // Cooldown check
  if (state.lastBuyTime) {
    const minutesSinceLastBuy = (Date.now() - new Date(state.lastBuyTime).getTime()) / (1000 * 60);
    if (minutesSinceLastBuy < CONFIG.minMinutesBetweenBuys) {
      state.stats.buybacksSkippedCooldown++;
      result.reason = `Cooldown: ${Math.round(minutesSinceLastBuy)}m since last buy (min: ${CONFIG.minMinutesBetweenBuys}m)`;
      return result;
    }
  }

  // Calculate indicators
  const rsi = calculateRSI(state.priceHistory, CONFIG.rsiPeriods);
  const momentum = calculateMomentum(state.priceHistory, 15);
  const avgVolume = state.volumeHistory.length > 0
    ? state.volumeHistory.reduce((a, b) => a + b, 0) / state.volumeHistory.length
    : marketData.volume24h;

  result.indicators = { rsi, momentum, avgVolume, currentVolume: marketData.volume24h };

  // RSI check (avoid buying overbought)
  if (rsi >= CONFIG.rsiOverboughtThreshold) {
    state.stats.buybacksSkippedRSI++;
    result.reason = `RSI overbought: ${rsi} >= ${CONFIG.rsiOverboughtThreshold}`;
    return result;
  }

  // Volume check
  if (marketData.volume24h < CONFIG.minVolume24h) {
    state.stats.buybacksSkippedLowVolume++;
    result.reason = `Volume too low: $${marketData.volume24h.toFixed(2)} < $${CONFIG.minVolume24h}`;
    return result;
  }

  if (!isVolumeConfirmed(marketData.volume24h, avgVolume)) {
    state.stats.buybacksSkippedLowVolume++;
    result.reason = `Volume below threshold: $${marketData.volume24h.toFixed(2)} < ${(avgVolume * CONFIG.volumeThreshold).toFixed(2)} (${CONFIG.volumeThreshold * 100}% of avg)`;
    return result;
  }

  // Calculate support levels
  if (state.recentHigh === 0) {
    state.recentHigh = marketData.price;
    state.recentHighTime = new Date().toISOString();
  }

  // Update recent high if price exceeds it
  if (marketData.price > state.recentHigh) {
    state.recentHigh = marketData.price;
    state.recentHighTime = new Date().toISOString();
    // Reset support levels bought when new high is set
    state.supportLevelsBought = {};
  }

  const dropPercent = ((state.recentHigh - marketData.price) / state.recentHigh) * 100;

  // Find triggered support level
  let triggeredLevel = null;
  for (const level of CONFIG.supportLevels) {
    if (dropPercent >= level.dropPercent && !state.supportLevelsBought[`dip${level.dropPercent}`]) {
      triggeredLevel = level;
    }
  }

  if (!triggeredLevel) {
    result.reason = `No support level triggered (drop: ${dropPercent.toFixed(2)}%)`;
    return result;
  }

  // RSI bonus check (prefer oversold)
  const isOversold = rsi <= CONFIG.rsiOversoldThreshold;

  // Liquidity check
  const buyAmount = triggeredLevel.buyAmountSOL * getBuyMultiplier(mode);
  if (!isLiquiditySufficient(marketData.liquidity, buyAmount)) {
    state.stats.buybacksSkippedLiquidity++;
    result.reason = `Insufficient liquidity: $${marketData.liquidity.toFixed(2)} for ${buyAmount} SOL trade`;
    return result;
  }

  // Cap to available SOL
  const finalAmount = Math.min(buyAmount, availableSOL);

  result.should = true;
  result.amount = finalAmount;
  result.level = triggeredLevel;
  result.reason = `Support ${triggeredLevel.dropPercent}% triggered (RSI: ${rsi}, ${isOversold ? 'OVERSOLD' : 'neutral'})`;

  return result;
}

/**
 * Execute buyback with logging
 */
async function executeBuyback(amount, reason, state) {
  console.log(`[sustainability] Executing buyback: ${amount} SOL - ${reason}`);

  if (CONFIG.dryRun) {
    console.log('[sustainability] DRY RUN - would buyback', amount, 'SOL');
    logActivity('SUSTAINABILITY_BUYBACK_DRY_RUN', reason, { amount, dryRun: true });
    return { success: true, dryRun: true, tokensReceived: 0 };
  }

  logActivity('SUSTAINABILITY_BUYBACK_START', reason, { amount, status: 'started' });

  try {
    const result = await treasuryManager.executeBuyback(amount, true);

    if (result.success) {
      state.stats.totalBuybacks++;
      state.stats.totalSOLSpent += amount;
      state.stats.totalTokensBought += result.tokensReceived || 0;

      logActivity('SUSTAINABILITY_BUYBACK_SUCCESS', reason, {
        amount,
        tokensReceived: result.tokensReceived,
        signature: result.signature
      });

      console.log(`[sustainability] Buyback successful: ${result.tokensReceived} tokens`);
    } else {
      logActivity('SUSTAINABILITY_BUYBACK_FAILED', reason, {
        amount,
        error: result.error
      });
    }

    return result;
  } catch (err) {
    logActivity('SUSTAINABILITY_BUYBACK_ERROR', reason, {
      amount,
      error: err.message
    });
    return { success: false, error: err.message };
  }
}

// ============================================================================
// BURN SCHEDULING
// ============================================================================

/**
 * Determine if we should burn tokens
 * Burns automatically when threshold is met - no time restrictions
 */
function shouldBurn(state, marketData) {
  // Check accumulation threshold (1 million tokens)
  if (state.tokensAccumulated < CONFIG.minTokensToAccumulate) {
    return { should: false, reason: `Insufficient tokens: ${state.tokensAccumulated.toLocaleString()} < ${CONFIG.minTokensToAccumulate.toLocaleString()}` };
  }

  // No time restrictions - burn immediately when threshold is met
  return { should: true, reason: `Accumulated ${state.tokensAccumulated.toLocaleString()} tokens - auto burning` };
}

/**
 * Execute burn with announcement
 */
async function executeBurn(tokenAmount, state) {
  console.log(`[sustainability] Executing burn: ${tokenAmount} tokens`);

  if (CONFIG.dryRun) {
    console.log('[sustainability] DRY RUN - would burn', tokenAmount, 'tokens');
    logActivity('SUSTAINABILITY_BURN_DRY_RUN', `Would burn ${tokenAmount} tokens`, { tokenAmount, dryRun: true });
    return { success: true, dryRun: true };
  }

  logActivity('SUSTAINABILITY_BURN_START', `Burning ${tokenAmount} tokens`, { tokenAmount, status: 'started' });

  try {
    const result = await treasuryManager.executeBurn(tokenAmount, true);

    if (result.success) {
      state.stats.totalBurns++;
      state.stats.totalTokensBurned += tokenAmount;

      logActivity('SUSTAINABILITY_BURN_SUCCESS', `Burned ${tokenAmount} tokens`, {
        tokenAmount,
        signature: result.signature
      });

      console.log(`[sustainability] Burn successful: ${tokenAmount} tokens`);
    } else {
      logActivity('SUSTAINABILITY_BURN_FAILED', `Burn failed: ${result.error}`, {
        tokenAmount,
        error: result.error
      });
    }

    return result;
  } catch (err) {
    logActivity('SUSTAINABILITY_BURN_ERROR', `Burn error: ${err.message}`, {
      tokenAmount,
      error: err.message
    });
    return { success: false, error: err.message };
  }
}

// ============================================================================
// MAIN TICK
// ============================================================================

async function tick(state) {
  state.tickCount++;
  console.log(`[sustainability] Tick #${state.tickCount} at ${new Date().toISOString()}`);

  // Fetch market data
  const marketData = await fetchMarketData();
  if (!marketData) {
    console.log('[sustainability] Failed to fetch market data, skipping tick');
    return;
  }

  // Update price history
  state.priceHistory.push(marketData.price);
  if (state.priceHistory.length > CONFIG.priceHistoryLength) {
    state.priceHistory = state.priceHistory.slice(-CONFIG.priceHistoryLength);
  }

  // Update volume history
  state.volumeHistory.push(marketData.volume24h);
  if (state.volumeHistory.length > 24) {
    state.volumeHistory = state.volumeHistory.slice(-24);
  }

  // Get balance and calculate runway
  let balance;
  try {
    balance = await tokenActions.getTokenBalance();
  } catch (err) {
    console.error('[sustainability] Failed to get balance:', err.message);
    return;
  }

  const runwayDays = calculateTreasuryRunway(balance.solBalance);
  const mode = getTreasuryMode(runwayDays);

  // Mode change detection
  if (mode !== state.currentMode) {
    console.log(`[sustainability] Mode change: ${state.currentMode} -> ${mode}`);
    logActivity('SUSTAINABILITY_MODE_CHANGE', `Treasury mode: ${state.currentMode} -> ${mode}`, {
      oldMode: state.currentMode,
      newMode: mode,
      runwayDays: runwayDays.toFixed(1),
      solBalance: balance.solBalance.toFixed(4)
    });
    state.currentMode = mode;
    state.lastModeChange = new Date().toISOString();
  }

  // Calculate indicators for logging
  const rsi = calculateRSI(state.priceHistory, CONFIG.rsiPeriods);
  const dropPercent = state.recentHigh > 0
    ? ((state.recentHigh - marketData.price) / state.recentHigh) * 100
    : 0;

  console.log(`[sustainability] Price: $${marketData.price.toFixed(8)} | RSI: ${rsi} | Drop: ${dropPercent.toFixed(1)}% | Mode: ${mode} | Runway: ${runwayDays.toFixed(1)}d`);

  // Buyback decision
  const buyDecision = await shouldBuyback(marketData, state, mode);
  console.log(`[sustainability] Buy decision: ${buyDecision.should ? 'YES' : 'NO'} - ${buyDecision.reason}`);

  if (buyDecision.should) {
    const result = await executeBuyback(buyDecision.amount, buyDecision.reason, state);
    if (result.success && !result.dryRun) {
      state.tokensAccumulated += result.tokensReceived || 0;
      state.lastBuyTime = new Date().toISOString();
      if (buyDecision.level) {
        state.supportLevelsBought[`dip${buyDecision.level.dropPercent}`] = {
          time: new Date().toISOString(),
          amount: buyDecision.amount
        };
      }
    }
  }

  // Burn decision
  const burnDecision = shouldBurn(state, marketData);
  console.log(`[sustainability] Burn decision: ${burnDecision.should ? 'YES' : 'NO'} - ${burnDecision.reason}`);

  if (burnDecision.should) {
    const result = await executeBurn(state.tokensAccumulated, state);
    if (result.success && !result.dryRun) {
      state.tokensAccumulated = 0;
      state.lastBurnTime = new Date().toISOString();
    }
  }

  saveState(state);
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

async function showStatus() {
  const state = loadState();
  let balance;
  try {
    balance = await tokenActions.getTokenBalance();
  } catch (err) {
    balance = { solBalance: 0, tokenBalanceFormatted: 0 };
  }

  const runwayDays = calculateTreasuryRunway(balance.solBalance);
  const mode = getTreasuryMode(runwayDays);

  console.log('');
  console.log('========================================');
  console.log('  SUSTAINABILITY DAEMON STATUS');
  console.log('========================================');
  console.log('');
  console.log('Treasury:');
  console.log(`  SOL Balance:     ${balance.solBalance.toFixed(4)} SOL`);
  console.log(`  Token Balance:   ${balance.tokenBalanceFormatted?.toLocaleString() || 0}`);
  console.log(`  Runway:          ${runwayDays.toFixed(1)} days`);
  console.log(`  Mode:            ${mode}`);
  console.log('');
  console.log('Accumulation:');
  console.log(`  Tokens Pending:  ${state.tokensAccumulated.toLocaleString()}`);
  console.log(`  Burn Threshold:  ${CONFIG.minTokensToAccumulate.toLocaleString()}`);
  console.log(`  Last Burn:       ${state.lastBurnTime || 'Never'}`);
  console.log('');
  console.log('Buyback State:');
  console.log(`  Recent High:     $${state.recentHigh.toFixed(8)}`);
  console.log(`  Last Buy:        ${state.lastBuyTime || 'Never'}`);
  console.log(`  Levels Bought:   ${Object.keys(state.supportLevelsBought).join(', ') || 'None'}`);
  console.log('');
  console.log('Config:');
  console.log(`  Enabled:         ${CONFIG.enabled}`);
  console.log(`  Dry Run:         ${CONFIG.dryRun}`);
  console.log(`  Tick Interval:   ${CONFIG.tickIntervalMs / 1000}s`);
  console.log('');
}

async function showMetrics() {
  const state = loadState();

  console.log('');
  console.log('========================================');
  console.log('  SUSTAINABILITY METRICS');
  console.log('========================================');
  console.log('');
  console.log('Operations:');
  console.log(`  Total Buybacks:        ${state.stats.totalBuybacks}`);
  console.log(`  Total SOL Spent:       ${state.stats.totalSOLSpent.toFixed(4)} SOL`);
  console.log(`  Total Tokens Bought:   ${state.stats.totalTokensBought.toLocaleString()}`);
  console.log(`  Total Burns:           ${state.stats.totalBurns}`);
  console.log(`  Total Tokens Burned:   ${state.stats.totalTokensBurned.toLocaleString()}`);
  console.log('');
  console.log('Efficiency:');
  if (state.stats.totalSOLSpent > 0) {
    console.log(`  Tokens per SOL:        ${(state.stats.totalTokensBought / state.stats.totalSOLSpent).toLocaleString()}`);
  }
  console.log('');
  console.log('Skipped Buybacks:');
  console.log(`  Low Volume:            ${state.stats.buybacksSkippedLowVolume}`);
  console.log(`  RSI Overbought:        ${state.stats.buybacksSkippedRSI}`);
  console.log(`  Low Liquidity:         ${state.stats.buybacksSkippedLiquidity}`);
  console.log(`  Cooldown:              ${state.stats.buybacksSkippedCooldown}`);
  console.log('');
  console.log(`Tick Count: ${state.tickCount}`);
  console.log('');
}

async function simulate() {
  console.log('[sustainability] Running simulation (dry run)...');
  CONFIG.dryRun = true;

  const state = loadState();
  await tick(state);

  console.log('');
  console.log('[sustainability] Simulation complete');
}

async function runDaemon() {
  console.log('');
  console.log('========================================');
  console.log('  SUSTAINABILITY DAEMON');
  console.log('========================================');
  console.log('');
  console.log(`Enabled:     ${CONFIG.enabled}`);
  console.log(`Dry Run:     ${CONFIG.dryRun}`);
  console.log(`Interval:    ${CONFIG.tickIntervalMs / 1000}s`);
  console.log('');

  if (!CONFIG.enabled) {
    console.log('[sustainability] Daemon is disabled. Set SUSTAINABILITY_ENABLED=true to enable.');
    process.exit(0);
  }

  const state = loadState();

  // Initial tick
  await tick(state);

  // Schedule regular ticks
  setInterval(async () => {
    try {
      const currentState = loadState();
      await tick(currentState);
    } catch (err) {
      console.error('[sustainability] Tick error:', err.message);
    }
  }, CONFIG.tickIntervalMs);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[sustainability] Shutting down...');
    saveState(state);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[sustainability] Shutting down...');
    saveState(state);
    process.exit(0);
  });
}

// ============================================================================
// MAIN
// ============================================================================

const command = process.argv[2];

switch (command) {
  case 'status':
    showStatus();
    break;
  case 'metrics':
    showMetrics();
    break;
  case 'simulate':
    simulate();
    break;
  case 'run':
    runDaemon();
    break;
  default:
    console.log('');
    console.log('Sustainability Daemon - Professional Buyback/Burn Algorithm');
    console.log('');
    console.log('Commands:');
    console.log('  status    - Show current state, mode, and balances');
    console.log('  metrics   - Show sustainability metrics');
    console.log('  simulate  - Run one tick in dry-run mode');
    console.log('  run       - Start the daemon');
    console.log('');
    console.log('Environment Variables:');
    console.log('  SUSTAINABILITY_ENABLED=true           Enable/disable daemon');
    console.log('  SUSTAINABILITY_DRY_RUN=false          Dry run mode');
    console.log('  SUSTAINABILITY_NORMAL_RUNWAY_DAYS=30  Days for NORMAL mode');
    console.log('  SUSTAINABILITY_CRITICAL_RUNWAY_DAYS=14  Days for CONSERVATIVE mode');
    console.log('  SUSTAINABILITY_MIN_TOKENS_TO_BURN=10000  Min tokens before burn');
    console.log('');
}
