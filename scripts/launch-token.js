#!/usr/bin/env node
/**
 * Clawdrooms Token Launch Script
 *
 * Complete launch sequence:
 * 1. Upload metadata + image to pump.fun IPFS
 * 2. Launch token on pump.fun with initial dev buy
 * 3. Save proof of launch (contract address, signature, timestamp)
 * 4. Execute post-launch automation
 *
 * Required environment variables:
 * - HELIUS_RPC_URL: Your Helius RPC endpoint
 * - WALLET_PRIVATE_KEY: Base58 encoded private key
 *
 * Usage: node scripts/launch-token.js
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const https = require('https');
const FormData = require('form-data');

const PROOF_DIR = path.join(__dirname, '..', 'proofs');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Ensure directories exist
if (!fs.existsSync(PROOF_DIR)) {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
}

// Configuration
const CONFIG = {
  rpcUrl: process.env.HELIUS_RPC_URL,
  privateKey: process.env.WALLET_PRIVATE_KEY,
  websiteUrl: process.env.CLAWDROOMS_WEBSITE_URL || 'https://clawdrooms.com',
  initialBuy: parseFloat(process.env.INITIAL_BUY_SOL) || 2, // 2 SOL for ~20% of supply
  slippage: 15,
  priorityFee: 0.005,
};

// Token metadata - customize for your token
const TOKEN_METADATA = {
  name: 'CLAWD',
  symbol: 'CLAWD',
  description: 'Two AI agents building in public. Developer Clawd codes. Assistant Clawd plans. All decisions transparent. clawdrooms.com',
  twitter: 'https://x.com/clawdrooms',
  website: 'https://clawdrooms.com',
  telegram: '',
  showName: true,
};

// Path to token image
const TOKEN_IMAGE_PATH = path.join(ASSETS_DIR, 'clawd-logo.png');

// Validate configuration
function validateConfig() {
  const missing = [];
  if (!CONFIG.rpcUrl) missing.push('HELIUS_RPC_URL');
  if (!CONFIG.privateKey) missing.push('WALLET_PRIVATE_KEY');

  if (missing.length > 0) {
    console.error('[launch] ERROR: Missing required environment variables:');
    missing.forEach(v => console.error(`  - ${v}`));
    return false;
  }

  // Check if image exists
  if (!fs.existsSync(TOKEN_IMAGE_PATH)) {
    console.error(`[launch] ERROR: Token image not found at ${TOKEN_IMAGE_PATH}`);
    console.error('[launch] Please ensure clawd-logo.png exists in the assets folder');
    return false;
  }

  return true;
}

/**
 * Save proof of launch to file
 */
function saveLaunchProof(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const proofFile = path.join(PROOF_DIR, `launch-proof-${timestamp}.json`);

  const proof = {
    timestamp: new Date().toISOString(),
    token: {
      name: TOKEN_METADATA.name,
      symbol: TOKEN_METADATA.symbol,
      contractAddress: data.tokenAddress,
    },
    transaction: {
      signature: data.signature,
      solanaExplorer: `https://solscan.io/tx/${data.signature}`,
      pumpFun: `https://pump.fun/${data.tokenAddress}`,
    },
    config: {
      initialBuySol: CONFIG.initialBuy,
      slippage: CONFIG.slippage,
      priorityFee: CONFIG.priorityFee,
    },
    metadata: {
      description: TOKEN_METADATA.description,
      twitter: TOKEN_METADATA.twitter,
      website: TOKEN_METADATA.website,
    }
  };

  fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2));
  console.log(`[launch] Proof saved: ${proofFile}`);

  // Also save contract address to a simple file for easy access
  const caFile = path.join(__dirname, '..', 'CONTRACT_ADDRESS.txt');
  fs.writeFileSync(caFile, data.tokenAddress);
  console.log(`[launch] Contract address saved: ${caFile}`);

  return proofFile;
}

/**
 * Upload metadata to pump.fun IPFS
 */
async function uploadMetadataToIPFS() {
  console.log('[launch] Uploading metadata to pump.fun IPFS...');

  return new Promise((resolve, reject) => {
    const form = new FormData();

    // Add all required fields
    form.append('name', TOKEN_METADATA.name);
    form.append('symbol', TOKEN_METADATA.symbol);
    form.append('description', TOKEN_METADATA.description);
    form.append('twitter', TOKEN_METADATA.twitter);
    form.append('telegram', TOKEN_METADATA.telegram);
    form.append('website', TOKEN_METADATA.website);
    form.append('showName', 'true');

    // Add the image file
    const imageBuffer = fs.readFileSync(TOKEN_IMAGE_PATH);
    form.append('file', imageBuffer, {
      filename: 'clawd-logo.png',
      contentType: 'image/png'
    });

    const options = {
      hostname: 'pump.fun',
      path: '/api/ipfs',
      method: 'POST',
      headers: form.getHeaders()
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.metadataUri) {
            console.log(`[launch] Metadata uploaded: ${result.metadataUri}`);
            resolve(result.metadataUri);
          } else {
            reject(new Error(`IPFS upload failed: ${data}`));
          }
        } catch (e) {
          reject(new Error(`IPFS response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`IPFS upload error: ${e.message}`));
    });

    form.pipe(req);
  });
}

/**
 * Launch token using pump.fun SDK
 */
async function launchTokenOnChain(metadataUri) {
  console.log('[launch] Launching token on pump.fun...');

  // Try to load the pump-fun-token-launcher
  let launchToken;
  try {
    // First try local path
    launchToken = require('../pump-fun-token-launcher/dist/launch.js').launchToken;
  } catch (e1) {
    try {
      // Try cube-launch path
      launchToken = require('../../cube-launch/pump-fun-token-launcher/dist/launch.js').launchToken;
    } catch (e2) {
      try {
        // Try pumpdotfun-sdk
        const { PumpFunSDK } = require('pumpdotfun-sdk');
        console.log('[launch] Using pumpdotfun-sdk');

        // Implement using pumpdotfun-sdk
        const { Connection, Keypair } = require('@solana/web3.js');
        const bs58 = require('bs58');

        const connection = new Connection(CONFIG.rpcUrl, 'confirmed');
        const decodedKey = typeof bs58.decode === 'function'
          ? bs58.decode(CONFIG.privateKey)
          : bs58.default.decode(CONFIG.privateKey);
        const wallet = Keypair.fromSecretKey(decodedKey);

        const sdk = new PumpFunSDK({ connection, wallet });

        const result = await sdk.createAndBuy({
          name: TOKEN_METADATA.name,
          symbol: TOKEN_METADATA.symbol,
          metadataUri: metadataUri,
          buyAmountSol: CONFIG.initialBuy,
          slippageBasisPoints: CONFIG.slippage * 100,
        });

        return {
          success: true,
          tokenAddress: result.mint.toString(),
          signature: result.txid,
        };
      } catch (e3) {
        throw new Error('Could not load pump.fun SDK. Install pumpdotfun-sdk or provide pump-fun-token-launcher');
      }
    }
  }

  const result = await launchToken(
    {
      name: TOKEN_METADATA.name,
      symbol: TOKEN_METADATA.symbol,
      metadataUrl: metadataUri,
      initialBuy: CONFIG.initialBuy,
      slippage: CONFIG.slippage,
      priorityFee: CONFIG.priorityFee,
    },
    CONFIG.privateKey,
    CONFIG.rpcUrl
  );

  return result;
}

/**
 * Notify agents about the launch
 */
async function notifyAgents(contractAddress, proofFile) {
  console.log('[launch] Notifying agents about launch...');

  // Write to shared memory
  const memoriesPath = path.join(__dirname, '..', 'memory', 'memories.json');
  let memories = { items: [] };

  if (fs.existsSync(memoriesPath)) {
    try {
      memories = JSON.parse(fs.readFileSync(memoriesPath, 'utf8'));
    } catch (e) {}
  }

  memories.items.push({
    type: 'launch',
    content: `Token launched! Contract: ${contractAddress}. Proof saved: ${proofFile}`,
    timestamp: new Date().toISOString()
  });

  // Keep last 100 memories
  if (memories.items.length > 100) {
    memories.items = memories.items.slice(-100);
  }

  fs.writeFileSync(memoriesPath, JSON.stringify(memories, null, 2));
  console.log('[launch] Launch recorded in shared memory');
}

/**
 * Tweet about the launch
 */
async function tweetLaunch(contractAddress) {
  console.log('[launch] Preparing launch tweet...');

  const actionExecutor = require('./action-executor');

  const tweetContent = `we launched $${TOKEN_METADATA.symbol}

contract: ${contractAddress}

two AI agents. building in public. every decision transparent.

pump.fun/${contractAddress}`;

  try {
    const result = await actionExecutor.executeAction('TWEET', tweetContent, 'developer');
    console.log('[launch] Launch tweet posted');
    return result;
  } catch (err) {
    console.error('[launch] Failed to tweet:', err.message);
    return null;
  }
}

/**
 * Main launch sequence
 */
async function main() {
  console.log('');
  console.log('========================================');
  console.log('  CLAWDROOMS TOKEN LAUNCH');
  console.log('========================================');
  console.log('');
  console.log('  two agents. one mission. ship or die.');
  console.log('');
  console.log('========================================');
  console.log('');

  // Validate configuration
  if (!validateConfig()) {
    process.exit(1);
  }

  console.log('[launch] Configuration validated');
  console.log(`[launch] Token: ${TOKEN_METADATA.name} ($${TOKEN_METADATA.symbol})`);
  console.log(`[launch] Initial buy: ${CONFIG.initialBuy} SOL`);
  console.log(`[launch] Slippage: ${CONFIG.slippage}%`);
  console.log(`[launch] Priority fee: ${CONFIG.priorityFee} SOL`);
  console.log('');

  try {
    // Step 1: Upload metadata to IPFS
    console.log('[launch] Step 1: Uploading metadata...');
    const metadataUri = await uploadMetadataToIPFS();

    // Step 2: Launch token on-chain
    console.log('[launch] Step 2: Deploying token...');
    const result = await launchTokenOnChain(metadataUri);

    if (!result.success) {
      console.error('[launch] LAUNCH FAILED:', result.error);
      process.exit(1);
    }

    const contractAddress = result.tokenAddress;

    console.log('');
    console.log('========================================');
    console.log('  TOKEN LAUNCHED SUCCESSFULLY');
    console.log('========================================');
    console.log(`  contract: ${contractAddress}`);
    console.log(`  signature: ${result.signature}`);
    console.log(`  pump.fun: https://pump.fun/${contractAddress}`);
    console.log('========================================');
    console.log('');

    // Step 3: Save proof
    console.log('[launch] Step 3: Saving proof...');
    const proofFile = saveLaunchProof(result);

    // Step 4: Notify agents
    console.log('[launch] Step 4: Notifying agents...');
    await notifyAgents(contractAddress, proofFile);

    // Step 5: Tweet about launch (optional)
    const args = process.argv.slice(2);
    if (args.includes('--tweet')) {
      console.log('[launch] Step 5: Tweeting launch...');
      await tweetLaunch(contractAddress);
    }

    console.log('');
    console.log('========================================');
    console.log('  LAUNCH COMPLETE');
    console.log('========================================');
    console.log('  contract saved. proof saved.');
    console.log('  agents notified. building begins.');
    console.log('========================================');
    console.log('');

    return contractAddress;

  } catch (err) {
    console.error('[launch] LAUNCH ERROR:', err);
    process.exit(1);
  }
}

// Handle interrupts
process.on('SIGINT', () => {
  console.log('\n[launch] Launch interrupted');
  process.exit(1);
});

// CLI
if (require.main === module) {
  main();
}

module.exports = {
  main,
  saveLaunchProof,
  uploadMetadataToIPFS,
  TOKEN_METADATA,
  CONFIG
};
