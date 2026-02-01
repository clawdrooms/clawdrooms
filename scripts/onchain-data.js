#!/usr/bin/env node
/**
 * On-Chain Data Module
 *
 * Fetches real-time data from:
 * - Helius API: Wallet balances, token holdings
 * - DexScreener API: Price, volume, liquidity, market cap
 * - GMGN API: Holder distribution, trading activity
 *
 * This data is used to give agents REAL information instead of fabricated numbers.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Configuration
const HELIUS_API_KEY = process.env.HELIUS_RPC_URL?.match(/api-key=([^&]+)/)?.[1] || '';
const HELIUS_RPC = process.env.HELIUS_RPC_URL;
const TOKEN_MINT = process.env.TOKEN_MINT_ADDRESS;
const WALLET_ADDRESS = getWalletAddress();

// Cache settings
const CACHE_FILE = path.join(__dirname, '..', 'memory', 'onchain-cache.json');
const CACHE_TTL = 60 * 1000; // 1 minute cache

/**
 * Get wallet public address from private key
 */
function getWalletAddress() {
  try {
    const { Keypair } = require('@solana/web3.js');
    const bs58 = require('bs58');
    const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
    if (!privateKey) return null;

    const decoded = typeof bs58.decode === 'function'
      ? bs58.decode(privateKey)
      : bs58.default.decode(privateKey);
    const keypair = Keypair.fromSecretKey(decoded);
    return keypair.publicKey.toString();
  } catch (err) {
    console.error('[onchain-data] Failed to get wallet address:', err.message);
    return null;
  }
}

/**
 * Load cache
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) {}
  return {};
}

/**
 * Save cache
 */
function saveCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[onchain-data] Failed to save cache:', err.message);
  }
}

/**
 * Check if cache is valid
 */
function isCacheValid(cache, key) {
  if (!cache[key]) return false;
  return (Date.now() - cache[key].timestamp) < CACHE_TTL;
}

/**
 * Fetch with timeout and error handling
 */
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Fetch wallet SOL balance from Helius
 */
async function fetchWalletBalance() {
  if (!WALLET_ADDRESS || !HELIUS_RPC) {
    return { error: 'Wallet not configured' };
  }

  try {
    const response = await safeFetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [WALLET_ADDRESS]
      })
    });

    const lamports = response.result?.value || 0;
    const sol = lamports / 1e9;

    return {
      address: WALLET_ADDRESS,
      balanceLamports: lamports,
      balanceSOL: sol,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[onchain-data] Helius balance error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch token holdings from Helius
 */
async function fetchTokenHoldings() {
  if (!WALLET_ADDRESS || !HELIUS_API_KEY) {
    return { error: 'Wallet or API key not configured' };
  }

  try {
    const url = `https://api.helius.xyz/v0/addresses/${WALLET_ADDRESS}/balances?api-key=${HELIUS_API_KEY}`;
    const response = await safeFetch(url);

    // Find our token if we have a mint address
    let ourToken = null;
    if (TOKEN_MINT && response.tokens) {
      ourToken = response.tokens.find(t => t.mint === TOKEN_MINT);
    }

    return {
      nativeBalance: response.nativeBalance / 1e9,
      tokenCount: response.tokens?.length || 0,
      ourToken: ourToken ? {
        mint: ourToken.mint,
        amount: ourToken.amount,
        decimals: ourToken.decimals,
        displayAmount: ourToken.amount / Math.pow(10, ourToken.decimals)
      } : null,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[onchain-data] Helius holdings error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch token data from DexScreener
 */
async function fetchDexScreenerData() {
  if (!TOKEN_MINT) {
    return { error: 'Token mint address not configured' };
  }

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;
    const response = await safeFetch(url);

    if (!response.pairs || response.pairs.length === 0) {
      return { error: 'Token not found on DexScreener' };
    }

    // Get the most liquid pair (usually the main one)
    const pair = response.pairs.sort((a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    return {
      pair: pair.pairAddress,
      dex: pair.dexId,
      baseToken: {
        name: pair.baseToken?.name,
        symbol: pair.baseToken?.symbol
      },
      priceUsd: parseFloat(pair.priceUsd) || 0,
      priceNative: parseFloat(pair.priceNative) || 0,
      volume: {
        h1: pair.volume?.h1 || 0,
        h6: pair.volume?.h6 || 0,
        h24: pair.volume?.h24 || 0
      },
      priceChange: {
        h1: pair.priceChange?.h1 || 0,
        h6: pair.priceChange?.h6 || 0,
        h24: pair.priceChange?.h24 || 0
      },
      liquidity: {
        usd: pair.liquidity?.usd || 0,
        base: pair.liquidity?.base || 0,
        quote: pair.liquidity?.quote || 0
      },
      fdv: pair.fdv || 0,
      marketCap: pair.marketCap || pair.fdv || 0,
      txns: {
        h1: { buys: pair.txns?.h1?.buys || 0, sells: pair.txns?.h1?.sells || 0 },
        h24: { buys: pair.txns?.h24?.buys || 0, sells: pair.txns?.h24?.sells || 0 }
      },
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[onchain-data] DexScreener error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch holder data from GMGN
 */
async function fetchGMGNData() {
  if (!TOKEN_MINT) {
    return { error: 'Token mint address not configured' };
  }

  try {
    // GMGN token info endpoint
    const url = `https://gmgn.ai/defi/quotation/v1/tokens/sol/${TOKEN_MINT}`;
    const response = await safeFetch(url);

    if (!response.data) {
      return { error: 'Token not found on GMGN' };
    }

    const data = response.data;
    return {
      name: data.name,
      symbol: data.symbol,
      price: data.price,
      marketCap: data.market_cap,
      holders: data.holder_count,
      volume24h: data.volume_24h,
      priceChange24h: data.price_change_24h,
      createdAt: data.creation_time,
      // Top holders if available
      topHolders: data.top_holders?.slice(0, 10).map(h => ({
        address: h.address,
        percentage: h.percentage,
        amount: h.amount
      })) || [],
      // Dev wallet info if available
      devInfo: data.dev_wallet ? {
        address: data.dev_wallet.address,
        percentage: data.dev_wallet.percentage,
        sold: data.dev_wallet.sold_percentage
      } : null,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[onchain-data] GMGN error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch top pump.fun launches from GMGN (for market analysis)
 */
async function fetchTrendingTokens() {
  try {
    const url = 'https://gmgn.ai/defi/quotation/v1/rank/sol/pump?limit=10&orderby=volume&direction=desc';
    const response = await safeFetch(url);

    if (!response.data?.rank) {
      return { error: 'Failed to fetch trending tokens' };
    }

    return {
      tokens: response.data.rank.map(t => ({
        name: t.name,
        symbol: t.symbol,
        mint: t.address,
        price: t.price,
        marketCap: t.market_cap,
        volume24h: t.volume_24h,
        holders: t.holder_count,
        priceChange24h: t.price_change_24h
      })),
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[onchain-data] GMGN trending error:', err.message);
    return { error: err.message };
  }
}

/**
 * Get all on-chain data (with caching)
 */
async function getAllData(forceRefresh = false) {
  const cache = loadCache();

  // Check cache
  if (!forceRefresh && isCacheValid(cache, 'allData')) {
    return cache.allData.data;
  }

  console.log('[onchain-data] Fetching fresh data...');

  // Fetch all data in parallel
  const [wallet, holdings, dexscreener, gmgn, trending] = await Promise.all([
    fetchWalletBalance(),
    fetchTokenHoldings(),
    fetchDexScreenerData(),
    fetchGMGNData(),
    fetchTrendingTokens()
  ]);

  const data = {
    wallet,
    holdings,
    dexscreener,
    gmgn,
    trending,
    fetchedAt: new Date().toISOString()
  };

  // Save to cache
  cache.allData = { data, timestamp: Date.now() };
  saveCache(cache);

  return data;
}

/**
 * Format data as context string for agents
 */
async function getAgentContext() {
  const data = await getAllData();

  let context = '=== REAL ON-CHAIN DATA (do not fabricate numbers) ===\n\n';

  // Wallet
  if (data.wallet && !data.wallet.error) {
    context += `WALLET BALANCE:\n`;
    context += `- Address: ${data.wallet.address}\n`;
    context += `- SOL Balance: ${data.wallet.balanceSOL.toFixed(4)} SOL\n\n`;
  }

  // Token holdings
  if (data.holdings && !data.holdings.error) {
    context += `TOKEN HOLDINGS:\n`;
    context += `- Native SOL: ${data.holdings.nativeBalance.toFixed(4)} SOL\n`;
    if (data.holdings.ourToken) {
      context += `- $CLAWDROOMS: ${data.holdings.ourToken.displayAmount.toLocaleString()} tokens\n`;
    }
    context += '\n';
  }

  // DexScreener data
  if (data.dexscreener && !data.dexscreener.error) {
    const dex = data.dexscreener;
    context += `TOKEN MARKET DATA (DexScreener):\n`;
    context += `- Price: $${dex.priceUsd.toFixed(8)}\n`;
    context += `- Market Cap: $${dex.marketCap.toLocaleString()}\n`;
    context += `- 24h Volume: $${dex.volume.h24.toLocaleString()}\n`;
    context += `- 24h Price Change: ${dex.priceChange.h24 > 0 ? '+' : ''}${dex.priceChange.h24.toFixed(2)}%\n`;
    context += `- Liquidity: $${dex.liquidity.usd.toLocaleString()}\n`;
    context += `- 24h Txns: ${dex.txns.h24.buys} buys, ${dex.txns.h24.sells} sells\n\n`;
  }

  // GMGN data
  if (data.gmgn && !data.gmgn.error) {
    const gmgn = data.gmgn;
    context += `HOLDER DATA (GMGN):\n`;
    context += `- Total Holders: ${gmgn.holders?.toLocaleString() || 'Unknown'}\n`;
    if (gmgn.devInfo) {
      context += `- Dev Wallet: ${gmgn.devInfo.percentage.toFixed(2)}% of supply\n`;
      if (gmgn.devInfo.sold > 0) {
        context += `- Dev Sold: ${gmgn.devInfo.sold.toFixed(2)}%\n`;
      }
    }
    if (gmgn.topHolders?.length > 0) {
      context += `- Top 3 Holders: ${gmgn.topHolders.slice(0, 3).map(h => `${h.percentage.toFixed(1)}%`).join(', ')}\n`;
    }
    context += '\n';
  }

  // Trending for market awareness
  if (data.trending && !data.trending.error && data.trending.tokens?.length > 0) {
    context += `TOP PUMP.FUN TOKENS (for market awareness):\n`;
    data.trending.tokens.slice(0, 5).forEach((t, i) => {
      context += `${i + 1}. $${t.symbol}: $${t.marketCap?.toLocaleString() || '?'} mcap, ${t.priceChange24h > 0 ? '+' : ''}${t.priceChange24h?.toFixed(1) || 0}%\n`;
    });
    context += '\n';
  }

  context += `Data fetched: ${data.fetchedAt}\n`;
  context += '=== END ON-CHAIN DATA ===';

  return context;
}

// CLI usage
if (require.main === module) {
  const command = process.argv[2];

  (async () => {
    switch (command) {
      case 'wallet':
        console.log(JSON.stringify(await fetchWalletBalance(), null, 2));
        break;
      case 'holdings':
        console.log(JSON.stringify(await fetchTokenHoldings(), null, 2));
        break;
      case 'dex':
        console.log(JSON.stringify(await fetchDexScreenerData(), null, 2));
        break;
      case 'gmgn':
        console.log(JSON.stringify(await fetchGMGNData(), null, 2));
        break;
      case 'trending':
        console.log(JSON.stringify(await fetchTrendingTokens(), null, 2));
        break;
      case 'all':
        console.log(JSON.stringify(await getAllData(true), null, 2));
        break;
      case 'context':
        console.log(await getAgentContext());
        break;
      default:
        console.log('Usage: node onchain-data.js <command>');
        console.log('Commands: wallet, holdings, dex, gmgn, trending, all, context');
    }
  })();
}

module.exports = {
  fetchWalletBalance,
  fetchTokenHoldings,
  fetchDexScreenerData,
  fetchGMGNData,
  fetchTrendingTokens,
  getAllData,
  getAgentContext
};
