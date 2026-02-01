#!/usr/bin/env node
/**
 * Treasury Manager - Buyback and Burn System
 *
 * Manages transparent treasury operations:
 * - Buybacks: Buy tokens from market using SOL
 * - Burns: Permanently destroy tokens
 * - All operations logged to database
 * - Burns announced on X with Solscan proof
 *
 * Usage:
 *   node treasury-manager.js buyback <sol_amount>
 *   node treasury-manager.js burn <token_amount>
 *   node treasury-manager.js buyback-and-burn <sol_amount>
 *   node treasury-manager.js stats
 *   node treasury-manager.js history
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tokenActions = require('./token-actions');

// Try to load browser poster for announcements (X API only used for mention replies)
let browserPoster = null;
try {
  browserPoster = require('./x-browser-poster');
} catch (err) {
  console.log('[treasury] Browser poster not available, announcements disabled');
}

// Configuration
const CONTRACT_ADDRESS = process.env.TOKEN_MINT_ADDRESS || 'HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw';
const TREASURY_DB_FILE = path.join(__dirname, '..', 'data', 'treasury-operations.json');

// Ensure data directory exists
const dataDir = path.dirname(TREASURY_DB_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Load treasury database
 */
function loadDB() {
  try {
    if (fs.existsSync(TREASURY_DB_FILE)) {
      return JSON.parse(fs.readFileSync(TREASURY_DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[treasury] Failed to load DB:', err.message);
  }
  return {
    operations: [],
    stats: {
      totalBuybacks: 0,
      totalBuybackSOL: 0,
      totalBurns: 0,
      totalTokensBurned: 0,
      lastOperation: null
    }
  };
}

/**
 * Save treasury database
 */
function saveDB(db) {
  try {
    fs.writeFileSync(TREASURY_DB_FILE, JSON.stringify(db, null, 2));
    console.log('[treasury] Database saved');
  } catch (err) {
    console.error('[treasury] Failed to save DB:', err.message);
  }
}

/**
 * Log operation to database
 */
function logOperation(type, data) {
  const db = loadDB();

  const operation = {
    id: `${type}_${Date.now()}`,
    type,
    timestamp: new Date().toISOString(),
    ...data
  };

  db.operations.push(operation);

  // Update stats
  if (type === 'buyback') {
    db.stats.totalBuybacks++;
    db.stats.totalBuybackSOL += data.solAmount || 0;
  } else if (type === 'burn') {
    db.stats.totalBurns++;
    db.stats.totalTokensBurned += data.tokenAmount || 0;
  }
  db.stats.lastOperation = operation.timestamp;

  // Keep last 1000 operations
  if (db.operations.length > 1000) {
    db.operations = db.operations.slice(-1000);
  }

  saveDB(db);
  return operation;
}

/**
 * Announce burn on X (using browser automation)
 */
async function announceBurn(tokenAmount, signature) {
  if (!browserPoster) {
    console.log('[treasury] Browser poster not available, skipping announcement');
    return null;
  }

  const solscanUrl = `https://solscan.io/tx/${signature}`;

  // Generate announcement tweet
  const messages = [
    `burned ${formatNumber(tokenAmount)} $clawdrooms. proof: ${solscanUrl}`,
    `${formatNumber(tokenAmount)} tokens burned. supply reduced permanently. ${solscanUrl}`,
    `just burned ${formatNumber(tokenAmount)} tokens. less supply, same demand. ${solscanUrl}`,
    `burn complete: ${formatNumber(tokenAmount)} tokens gone forever. ${solscanUrl}`
  ];

  const tweet = messages[Math.floor(Math.random() * messages.length)];

  try {
    // Post via browser automation (X API only for mention replies)
    const result = await browserPoster.postTweet(tweet);
    if (result.success) {
      console.log(`[treasury] Burn announced on X via browser`);
      return 'browser_post';
    } else {
      console.error('[treasury] Browser post failed:', result.error);
      return null;
    }
  } catch (err) {
    console.error('[treasury] Failed to announce burn:', err.message);
    return null;
  }
}

/**
 * Announce buyback on X (using browser automation)
 */
async function announceBuyback(solAmount, signature) {
  if (!browserPoster) {
    console.log('[treasury] Browser poster not available, skipping announcement');
    return null;
  }

  const solscanUrl = `https://solscan.io/tx/${signature}`;

  const messages = [
    `treasury buyback: ${solAmount} SOL added to liquidity. ${solscanUrl}`,
    `just bought ${solAmount} SOL worth of $clawdrooms. building. ${solscanUrl}`,
    `buyback executed: ${solAmount} SOL. proof on chain. ${solscanUrl}`
  ];

  const tweet = messages[Math.floor(Math.random() * messages.length)];

  try {
    // Post via browser automation (X API only for mention replies)
    const result = await browserPoster.postTweet(tweet);
    if (result.success) {
      console.log(`[treasury] Buyback announced on X via browser`);
      return 'browser_post';
    } else {
      console.error('[treasury] Browser post failed:', result.error);
      return null;
    }
  } catch (err) {
    console.error('[treasury] Failed to announce buyback:', err.message);
    return null;
  }
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Execute buyback (buy tokens with SOL)
 */
async function executeBuyback(solAmount, announce = true) {
  console.log(`[treasury] Executing buyback: ${solAmount} SOL`);

  // Get balance before
  const balanceBefore = await tokenActions.getTokenBalance();
  console.log(`[treasury] Balance before: ${balanceBefore.tokenBalanceFormatted} tokens, ${balanceBefore.solBalance} SOL`);

  // Execute buy
  const result = await tokenActions.buyTokens(solAmount);

  if (!result.success) {
    console.error('[treasury] Buyback failed:', result.error);
    logOperation('buyback_failed', {
      solAmount,
      error: result.error
    });
    return result;
  }

  // Get balance after
  const balanceAfter = await tokenActions.getTokenBalance();
  const tokensReceived = balanceAfter.tokenBalanceFormatted - balanceBefore.tokenBalanceFormatted;

  console.log(`[treasury] Buyback successful!`);
  console.log(`[treasury] Tokens received: ${formatNumber(tokensReceived)}`);
  console.log(`[treasury] Solscan: https://solscan.io/tx/${result.signature}`);

  // Log to database
  const operation = logOperation('buyback', {
    solAmount,
    tokensReceived,
    signature: result.signature,
    solscan: `https://solscan.io/tx/${result.signature}`,
    balanceAfter: balanceAfter.tokenBalanceFormatted
  });

  // Announce on X
  if (announce) {
    const tweetId = await announceBuyback(solAmount, result.signature);
    if (tweetId) {
      operation.tweetId = tweetId;
      saveDB(loadDB()); // Update with tweet ID
    }
  }

  return { ...result, tokensReceived, operation };
}

/**
 * Execute burn (permanently destroy tokens)
 */
async function executeBurn(tokenAmount, announce = true) {
  console.log(`[treasury] Executing burn: ${formatNumber(tokenAmount)} tokens`);

  // Get balance before
  const balanceBefore = await tokenActions.getTokenBalance();
  console.log(`[treasury] Balance before: ${balanceBefore.tokenBalanceFormatted} tokens`);

  if (balanceBefore.tokenBalanceFormatted < tokenAmount) {
    console.error(`[treasury] Insufficient tokens. Have: ${balanceBefore.tokenBalanceFormatted}, Need: ${tokenAmount}`);
    return { success: false, error: 'Insufficient token balance' };
  }

  // Execute burn
  const result = await tokenActions.burnTokens(tokenAmount);

  if (!result.success) {
    console.error('[treasury] Burn failed:', result.error);
    logOperation('burn_failed', {
      tokenAmount,
      error: result.error
    });
    return result;
  }

  // Get balance after
  const balanceAfter = await tokenActions.getTokenBalance();

  console.log(`[treasury] Burn successful!`);
  console.log(`[treasury] Tokens burned: ${formatNumber(tokenAmount)}`);
  console.log(`[treasury] Solscan: https://solscan.io/tx/${result.signature}`);

  // Log to database
  const operation = logOperation('burn', {
    tokenAmount,
    signature: result.signature,
    solscan: `https://solscan.io/tx/${result.signature}`,
    balanceAfter: balanceAfter.tokenBalanceFormatted
  });

  // Announce on X
  if (announce) {
    const tweetId = await announceBurn(tokenAmount, result.signature);
    if (tweetId) {
      operation.tweetId = tweetId;
      saveDB(loadDB()); // Update with tweet ID
    }
  }

  return { ...result, operation };
}

/**
 * Execute buyback and burn in one operation
 */
async function executeBuybackAndBurn(solAmount, announce = true) {
  console.log(`[treasury] Executing buyback-and-burn: ${solAmount} SOL`);

  // Step 1: Buy tokens
  const buyResult = await executeBuyback(solAmount, false); // Don't announce buyback separately

  if (!buyResult.success) {
    return buyResult;
  }

  // Wait a moment for state to settle
  await new Promise(r => setTimeout(r, 2000));

  // Step 2: Burn the tokens we just bought
  const burnResult = await executeBurn(buyResult.tokensReceived, announce);

  if (!burnResult.success) {
    console.error('[treasury] Burn failed after buyback');
    return burnResult;
  }

  console.log(`[treasury] Buyback-and-burn complete!`);
  console.log(`[treasury] SOL spent: ${solAmount}`);
  console.log(`[treasury] Tokens burned: ${formatNumber(buyResult.tokensReceived)}`);

  return {
    success: true,
    solSpent: solAmount,
    tokensBurned: buyResult.tokensReceived,
    buySignature: buyResult.signature,
    burnSignature: burnResult.signature
  };
}

/**
 * Get treasury stats
 */
function getStats() {
  const db = loadDB();
  return {
    ...db.stats,
    operationCount: db.operations.length,
    contractAddress: CONTRACT_ADDRESS
  };
}

/**
 * Get operation history
 */
function getHistory(limit = 20) {
  const db = loadDB();
  return db.operations.slice(-limit).reverse();
}

// Export functions for use by other modules
module.exports = {
  executeBuyback,
  executeBurn,
  executeBuybackAndBurn,
  getStats,
  getHistory,
  logOperation,
  loadDB
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const amount = parseFloat(args[1]);

  async function main() {
    console.log('');
    console.log('========================================');
    console.log('  CLAWDROOMS TREASURY MANAGER');
    console.log('========================================');
    console.log('');

    try {
      switch (command) {
        case 'buyback':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node treasury-manager.js buyback <sol_amount>');
            console.log('Example: node treasury-manager.js buyback 0.5');
            process.exit(1);
          }
          await executeBuyback(amount);
          break;

        case 'burn':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node treasury-manager.js burn <token_amount>');
            console.log('Example: node treasury-manager.js burn 10000');
            process.exit(1);
          }
          await executeBurn(amount);
          break;

        case 'buyback-and-burn':
        case 'bab':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node treasury-manager.js buyback-and-burn <sol_amount>');
            console.log('Example: node treasury-manager.js buyback-and-burn 0.5');
            process.exit(1);
          }
          await executeBuybackAndBurn(amount);
          break;

        case 'stats':
          const stats = getStats();
          console.log('Treasury Stats:');
          console.log('  Total Buybacks:', stats.totalBuybacks);
          console.log('  Total SOL Spent:', stats.totalBuybackSOL.toFixed(4), 'SOL');
          console.log('  Total Burns:', stats.totalBurns);
          console.log('  Total Tokens Burned:', formatNumber(stats.totalTokensBurned));
          console.log('  Last Operation:', stats.lastOperation || 'None');
          break;

        case 'history':
          const history = getHistory(10);
          console.log('Recent Operations:');
          for (const op of history) {
            const time = new Date(op.timestamp).toLocaleString();
            if (op.type === 'buyback') {
              console.log(`  [${time}] BUYBACK: ${op.solAmount} SOL -> ${formatNumber(op.tokensReceived || 0)} tokens`);
            } else if (op.type === 'burn') {
              console.log(`  [${time}] BURN: ${formatNumber(op.tokenAmount)} tokens`);
            } else if (op.type.includes('failed')) {
              console.log(`  [${time}] FAILED: ${op.type} - ${op.error}`);
            }
            if (op.solscan) {
              console.log(`    Proof: ${op.solscan}`);
            }
          }
          break;

        case 'balance':
          const balance = await tokenActions.getTokenBalance();
          console.log('Treasury Balance:');
          console.log('  Wallet:', balance.wallet);
          console.log('  SOL:', balance.solBalance.toFixed(4), 'SOL');
          console.log('  Tokens:', formatNumber(balance.tokenBalanceFormatted));
          break;

        default:
          console.log('Treasury Manager - Buyback & Burn System');
          console.log('');
          console.log('Commands:');
          console.log('  buyback <sol>         - Buy tokens with SOL (announced on X)');
          console.log('  burn <tokens>         - Burn tokens permanently (announced on X)');
          console.log('  buyback-and-burn <sol> - Buy and burn in one operation');
          console.log('  stats                 - Show treasury statistics');
          console.log('  history               - Show recent operations');
          console.log('  balance               - Show current wallet balance');
          console.log('');
          console.log('All operations are logged and announced on X with Solscan proof.');
          console.log('');
          console.log('Examples:');
          console.log('  node treasury-manager.js buyback 0.5');
          console.log('  node treasury-manager.js burn 10000');
          console.log('  node treasury-manager.js buyback-and-burn 1');
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
