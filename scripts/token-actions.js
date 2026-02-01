#!/usr/bin/env node
/**
 * Token Actions for Clawdrooms
 *
 * Provides wallet/token operations:
 * - Buy tokens via pump.fun
 * - Sell tokens via pump.fun
 * - Burn tokens (permanently destroy)
 * - Lock tokens (send to dead address)
 *
 * Usage:
 *   node token-actions.js buy <amount_sol>
 *   node token-actions.js sell <amount_tokens>
 *   node token-actions.js burn <amount_tokens>
 *   node token-actions.js lock <amount_tokens>
 *   node token-actions.js balance
 */

require('dotenv').config();
const {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createBurnInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const path = require('path');
const fs = require('fs');

// Configuration
const CONTRACT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;

// Dead address for "locking" tokens (well-known burn address)
const DEAD_ADDRESS = new PublicKey('1nc1nerator11111111111111111111111111111111');

// Proof directory
const PROOF_DIR = path.join(__dirname, '..', 'proofs');

/**
 * Get wallet keypair
 */
function getKeypair() {
  if (!PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY not configured');
  }
  const decoded = typeof bs58.decode === 'function'
    ? bs58.decode(PRIVATE_KEY)
    : bs58.default.decode(PRIVATE_KEY);
  return Keypair.fromSecretKey(decoded);
}

/**
 * Get connection
 */
function getConnection() {
  if (!RPC_URL) {
    throw new Error('HELIUS_RPC_URL not configured');
  }
  return new Connection(RPC_URL, 'confirmed');
}

/**
 * Save action proof
 */
function saveProof(action, data) {
  if (!fs.existsSync(PROOF_DIR)) {
    fs.mkdirSync(PROOF_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const proofFile = path.join(PROOF_DIR, `${action}-proof-${timestamp}.json`);

  const proof = {
    action,
    timestamp: new Date().toISOString(),
    ...data
  };

  fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2));
  console.log(`[proof] Saved: ${proofFile}`);
  return proofFile;
}

/**
 * Get token balance
 */
async function getTokenBalance() {
  if (!CONTRACT_ADDRESS) {
    throw new Error('TOKEN_MINT_ADDRESS not configured');
  }

  const connection = getConnection();
  const keypair = getKeypair();
  const mint = new PublicKey(CONTRACT_ADDRESS);

  // Get SOL balance
  const solBalance = await connection.getBalance(keypair.publicKey);

  // Get token account
  const tokenAccount = await getAssociatedTokenAddress(mint, keypair.publicKey);

  let tokenBalance = 0;
  try {
    const account = await getAccount(connection, tokenAccount);
    tokenBalance = Number(account.amount);
  } catch (e) {
    // Token account doesn't exist
  }

  return {
    wallet: keypair.publicKey.toString(),
    solBalance: solBalance / LAMPORTS_PER_SOL,
    tokenBalance,
    tokenBalanceFormatted: tokenBalance / 1e6, // Assuming 6 decimals
    mint: CONTRACT_ADDRESS
  };
}

/**
 * Buy tokens via Jupiter API (for tokens on Raydium/PumpSwap)
 * Falls back to pump.fun for tokens still on bonding curve
 */
async function buyTokens(amountSOL) {
  if (!CONTRACT_ADDRESS) {
    throw new Error('TOKEN_MINT_ADDRESS not configured');
  }

  const connection = getConnection();
  const keypair = getKeypair();

  console.log(`[buy] Buying tokens with ${amountSOL} SOL...`);
  console.log(`[buy] Wallet: ${keypair.publicKey.toString()}`);
  console.log(`[buy] Token: ${CONTRACT_ADDRESS}`);

  // SOL mint address (wrapped SOL)
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

  try {
    // Try Jupiter first (works for Raydium/PumpSwap graduated tokens)
    console.log('[buy] Using Jupiter API for swap...');

    // Get quote from Jupiter
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${CONTRACT_ADDRESS}&amount=${amountLamports}&slippageBps=2000&swapMode=ExactIn`;
    console.log('[buy] Getting quote from Jupiter...');
    console.log('[buy] Quote URL:', quoteUrl);

    const quoteResponse = await fetch(quoteUrl, {
      headers: {
        'Accept': 'application/json',
      }
    });
    const quoteText = await quoteResponse.text();

    console.log('[buy] Jupiter response status:', quoteResponse.status);

    if (!quoteResponse.ok) {
      console.log('[buy] Jupiter quote error response:', quoteText);
      throw new Error(`Jupiter quote error (${quoteResponse.status}): ${quoteText}`);
    }

    let quoteData;
    try {
      quoteData = JSON.parse(quoteText);
    } catch (e) {
      console.log('[buy] Failed to parse Jupiter response:', quoteText.substring(0, 500));
      throw new Error('Invalid Jupiter response');
    }

    if (!quoteData || quoteData.error) {
      console.log('[buy] Jupiter quote data:', JSON.stringify(quoteData, null, 2));
      throw new Error(`Jupiter quote failed: ${quoteData?.error || 'No route found'}`);
    }

    // Check if no routes found
    if (!quoteData.outAmount || quoteData.outAmount === '0') {
      console.log('[buy] Jupiter returned zero output - no liquidity or route');
      throw new Error('No liquidity found on Jupiter');
    }

    // Log the route info
    if (quoteData.routePlan) {
      const dexes = quoteData.routePlan.map(r => r.swapInfo?.label || 'unknown').join(' -> ');
      console.log(`[buy] Route: ${dexes}`);
    }

    console.log(`[buy] Quote received: ~${(Number(quoteData.outAmount) / 1e6).toFixed(2)} tokens expected`);

    // Get swap transaction from Jupiter
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 500000, // 0.0005 SOL priority fee
      }),
    });

    if (!swapResponse.ok) {
      const error = await swapResponse.text();
      throw new Error(`Jupiter swap error: ${error}`);
    }

    const swapData = await swapResponse.json();

    if (!swapData.swapTransaction) {
      throw new Error('Jupiter did not return swap transaction');
    }

    // Deserialize and sign the transaction
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(swapTransactionBuf);
    tx.sign([keypair]);

    console.log('[buy] Transaction signed, sending...');

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log(`[buy] Transaction sent: ${signature}`);
    console.log(`[buy] Solscan: https://solscan.io/tx/${signature}`);

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('[buy] Transaction confirmed!');

    // Save proof
    const proofFile = saveProof('buy', {
      amountSOL,
      signature,
      mint: CONTRACT_ADDRESS,
      wallet: keypair.publicKey.toString(),
      solscan: `https://solscan.io/tx/${signature}`,
      method: 'jupiter'
    });

    return { success: true, signature, proofFile };
  } catch (err) {
    console.error('[buy] Jupiter swap failed:', err.message);

    // Try pumpportal.fun with 'raydium' pool for graduated tokens
    console.log('[buy] Trying pumpportal.fun with raydium pool...');

    try {
      const response = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey.toString(),
          action: 'buy',
          mint: CONTRACT_ADDRESS,
          denominatedInSol: 'true',
          amount: amountSOL,
          slippage: 20,
          priorityFee: 0.001,
          pool: 'raydium', // Use raydium pool for graduated tokens
        }),
      });

      if (response.status === 200) {
        const data = await response.arrayBuffer();
        const tx = VersionedTransaction.deserialize(new Uint8Array(data));
        tx.sign([keypair]);

        console.log('[buy] Transaction signed, sending via pumpportal raydium...');

        const signature = await connection.sendTransaction(tx, {
          skipPreflight: false,
          maxRetries: 3,
        });

        console.log(`[buy] Transaction sent: ${signature}`);

        const confirmation = await connection.confirmTransaction(signature, 'confirmed');

        if (!confirmation.value.err) {
          console.log('[buy] Transaction confirmed via pumpportal raydium!');
          console.log(`[buy] Solscan: https://solscan.io/tx/${signature}`);

          const proofFile = saveProof('buy', {
            amountSOL,
            signature,
            mint: CONTRACT_ADDRESS,
            wallet: keypair.publicKey.toString(),
            solscan: `https://solscan.io/tx/${signature}`,
            method: 'pumpportal_raydium'
          });

          return { success: true, signature, proofFile };
        } else {
          console.log('[buy] Pumpportal raydium transaction failed:', confirmation.value.err);
        }
      } else {
        const errorText = await response.text();
        console.log('[buy] Pumpportal raydium API error:', response.status, errorText);
      }
    } catch (pumpErr) {
      console.log('[buy] Pumpportal raydium fallback failed:', pumpErr.message);
    }

    console.error('[buy] Error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Sell tokens via pump.fun
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * HARD BLOCKED: DEV WALLET NEVER SELLS
 * This function is disabled. The dev wallet will NEVER sell tokens.
 * This is a core trust rule for the clawdrooms project.
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
async function sellTokens(amountTokens) {
  console.log('[sell] BLOCKED: Dev wallet NEVER sells. This is a hard rule.');
  return {
    success: false,
    error: 'BLOCKED: Dev wallet NEVER sells. This is a hard rule.',
    blocked: true
  };
}

/**
 * Burn tokens (permanently destroy)
 */
async function burnTokens(amountTokens) {
  if (!CONTRACT_ADDRESS) {
    throw new Error('TOKEN_MINT_ADDRESS not configured');
  }

  const connection = getConnection();
  const keypair = getKeypair();
  const mint = new PublicKey(CONTRACT_ADDRESS);

  console.log(`[burn] Burning ${amountTokens} tokens...`);
  console.log('[burn] WARNING: This action is IRREVERSIBLE!');

  try {
    const tokenAccount = await getAssociatedTokenAddress(mint, keypair.publicKey);

    // Create burn instruction
    const burnIx = createBurnInstruction(
      tokenAccount,
      mint,
      keypair.publicKey,
      BigInt(Math.floor(amountTokens * 1e6)) // Assuming 6 decimals
    );

    const transaction = new Transaction().add(burnIx);
    transaction.feePayer = keypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    transaction.sign(keypair);

    const signature = await connection.sendRawTransaction(transaction.serialize());

    console.log(`[burn] Transaction sent: ${signature}`);

    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('[burn] Tokens burned successfully!');
    console.log(`[burn] Solscan: https://solscan.io/tx/${signature}`);

    const proofFile = saveProof('burn', {
      amountTokens,
      signature,
      mint: CONTRACT_ADDRESS,
      wallet: keypair.publicKey.toString(),
      solscan: `https://solscan.io/tx/${signature}`,
      note: 'Tokens permanently destroyed'
    });

    return { success: true, signature, proofFile };
  } catch (err) {
    console.error('[burn] Error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Lock tokens (send to dead address - effectively burns them but shows as transfer)
 */
async function lockTokens(amountTokens) {
  if (!CONTRACT_ADDRESS) {
    throw new Error('TOKEN_MINT_ADDRESS not configured');
  }

  const connection = getConnection();
  const keypair = getKeypair();
  const mint = new PublicKey(CONTRACT_ADDRESS);

  console.log(`[lock] Locking ${amountTokens} tokens to dead address...`);
  console.log(`[lock] Dead address: ${DEAD_ADDRESS.toString()}`);
  console.log('[lock] WARNING: This action is IRREVERSIBLE!');

  try {
    const sourceAccount = await getAssociatedTokenAddress(mint, keypair.publicKey);
    const destAccount = await getAssociatedTokenAddress(mint, DEAD_ADDRESS);

    // Create transfer instruction
    const transferIx = createTransferInstruction(
      sourceAccount,
      destAccount,
      keypair.publicKey,
      BigInt(Math.floor(amountTokens * 1e6)) // Assuming 6 decimals
    );

    const transaction = new Transaction().add(transferIx);
    transaction.feePayer = keypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    transaction.sign(keypair);

    const signature = await connection.sendRawTransaction(transaction.serialize());

    console.log(`[lock] Transaction sent: ${signature}`);

    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('[lock] Tokens locked successfully!');
    console.log(`[lock] Solscan: https://solscan.io/tx/${signature}`);

    const proofFile = saveProof('lock', {
      amountTokens,
      signature,
      mint: CONTRACT_ADDRESS,
      wallet: keypair.publicKey.toString(),
      deadAddress: DEAD_ADDRESS.toString(),
      solscan: `https://solscan.io/tx/${signature}`,
      note: 'Tokens sent to dead address (permanently locked)'
    });

    return { success: true, signature, proofFile };
  } catch (err) {
    console.error('[lock] Error:', err.message);
    return { success: false, error: err.message };
  }
}

// Export functions
module.exports = {
  getTokenBalance,
  buyTokens,
  sellTokens,
  burnTokens,
  lockTokens,
  getKeypair,
  getConnection,
  saveProof
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const amount = parseFloat(args[1]);

  async function main() {
    console.log('');
    console.log('========================================');
    console.log('  CLAWDROOMS TOKEN ACTIONS');
    console.log('========================================');
    console.log('');

    try {
      switch (command) {
        case 'balance':
          const balance = await getTokenBalance();
          console.log('Wallet:', balance.wallet);
          console.log('SOL Balance:', balance.solBalance.toFixed(4), 'SOL');
          console.log('Token Balance:', balance.tokenBalanceFormatted.toFixed(2), 'tokens');
          console.log('Mint:', balance.mint);
          break;

        case 'buy':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node token-actions.js buy <amount_sol>');
            console.log('Example: node token-actions.js buy 0.1');
            process.exit(1);
          }
          await buyTokens(amount);
          break;

        case 'sell':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node token-actions.js sell <amount_tokens>');
            console.log('Example: node token-actions.js sell 1000');
            process.exit(1);
          }
          await sellTokens(amount);
          break;

        case 'burn':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node token-actions.js burn <amount_tokens>');
            console.log('Example: node token-actions.js burn 1000');
            process.exit(1);
          }
          await burnTokens(amount);
          break;

        case 'lock':
          if (isNaN(amount) || amount <= 0) {
            console.log('Usage: node token-actions.js lock <amount_tokens>');
            console.log('Example: node token-actions.js lock 1000');
            process.exit(1);
          }
          await lockTokens(amount);
          break;

        default:
          console.log('Token Actions - Clawdrooms');
          console.log('');
          console.log('Commands:');
          console.log('  balance             - Check wallet and token balance');
          console.log('  buy <sol>           - Buy tokens with SOL via pump.fun');
          console.log('  sell                - DISABLED (dev wallet NEVER sells)');
          console.log('  burn <tokens>       - Permanently burn tokens');
          console.log('  lock <tokens>       - Send tokens to dead address (lock)');
          console.log('');
          console.log('HARD RULE: Dev wallet NEVER sells. Trust is everything.');
          console.log('');
          console.log('Examples:');
          console.log('  node token-actions.js balance');
          console.log('  node token-actions.js buy 0.1');
          console.log('  node token-actions.js burn 10000');
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
