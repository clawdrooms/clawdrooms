#!/usr/bin/env node
/**
 * Action Executor - Enables agents to perform real actions
 *
 * Developer Clawd can request actions using tags in responses:
 * [ACTION:TWEET]content[/ACTION]
 * [ACTION:CHECK_WALLET][/ACTION]
 * [ACTION:CHECK_MENTIONS][/ACTION]
 * [ACTION:CHECK_COMMUNITY][/ACTION]
 * [ACTION:COMMUNITY_POST]content[/ACTION]
 * [ACTION:CHECK_EMAIL][/ACTION]
 * [ACTION:SEND_EMAIL]{"to":"...","subject":"...","body":"..."}[/ACTION]
 * [ACTION:LAUNCH_TOKEN][/ACTION] - Launch token on pump.fun
 * [ACTION:BUY_TOKEN]{"amount": 0.1}[/ACTION] - Buy tokens with SOL
 * [ACTION:SELL_TOKEN]{"amount": 1000}[/ACTION] - Sell tokens for SOL
 * [ACTION:BURN_TOKEN]{"amount": 1000}[/ACTION] - Burn tokens permanently
 * [ACTION:LOCK_TOKEN]{"amount": 1000}[/ACTION] - Lock tokens (send to dead address)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const xBrowser = require('./x-browser-poster');

// Gmail imports (optional)
let nodemailer, Imap;
try {
  nodemailer = require('nodemailer');
} catch (err) {
  console.log('[action-executor] nodemailer not installed, email sending disabled');
}
try {
  Imap = require('imap');
} catch (err) {
  console.log('[action-executor] imap not installed, email checking disabled');
}

// Spam filter - accounts/patterns to ignore
const SPAM_PATTERNS = [
  /follow.*back/i,
  /check.*dm/i,
  /airdrop/i,
  /giveaway/i,
  /free.*token/i,
  /send.*sol/i,
  /100x/i,
  /guaranteed.*profit/i
];

const LOW_QUALITY_INDICATORS = [
  // Usernames with too many numbers
  username => /\d{5,}/.test(username),
  // Only emojis/symbols (no actual text)
  text => /^[\s\p{Emoji}\p{Symbol}]+$/u.test(text)
];

// Solana imports (optional - only if @solana/web3.js is installed)
let Connection, PublicKey, Keypair, LAMPORTS_PER_SOL;
try {
  const solanaWeb3 = require('@solana/web3.js');
  Connection = solanaWeb3.Connection;
  PublicKey = solanaWeb3.PublicKey;
  Keypair = solanaWeb3.Keypair;
  LAMPORTS_PER_SOL = solanaWeb3.LAMPORTS_PER_SOL;
} catch (err) {
  console.log('[action-executor] Solana not installed, wallet actions disabled');
}

// Action log path
const ACTION_LOG = path.join(__dirname, '..', 'memory', 'actions.json');

/**
 * Parse action requests from agent response
 */
function parseActions(text) {
  const actions = [];
  const actionRegex = /\[ACTION:(\w+)\]([\s\S]*?)\[\/ACTION\]/g;

  let match;
  while ((match = actionRegex.exec(text)) !== null) {
    actions.push({
      type: match[1].toUpperCase(),
      content: match[2].trim()
    });
  }

  return actions;
}

/**
 * Log action to memory
 */
function logAction(action, result) {
  let actions = [];
  if (fs.existsSync(ACTION_LOG)) {
    actions = JSON.parse(fs.readFileSync(ACTION_LOG, 'utf8'));
  }

  actions.push({
    ...action,
    result,
    timestamp: new Date().toISOString()
  });

  // Keep last 200 actions
  if (actions.length > 200) {
    actions = actions.slice(-200);
  }

  fs.writeFileSync(ACTION_LOG, JSON.stringify(actions, null, 2));
}

/**
 * Execute a tweet action
 */
async function executeTweet(content) {
  if (!content || content.length === 0) {
    return { success: false, error: 'Empty tweet content' };
  }

  // Truncate if too long
  let tweet = content;
  if (tweet.length > 280) {
    tweet = tweet.substring(0, 277) + '...';
  }

  console.log(`[action-executor] Posting tweet: ${tweet}`);

  try {
    const result = await xBrowser.postTweet(tweet);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check wallet balance
 */
async function checkWallet() {
  if (!Connection || !Keypair) {
    return { success: false, error: 'Solana not installed' };
  }

  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    return { success: false, error: 'No wallet configured' };
  }

  try {
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
    );

    // Decode base58 private key
    const bs58 = require('bs58');
    const secretKey = bs58.decode(privateKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    const balance = await connection.getBalance(keypair.publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;

    return {
      success: true,
      address: keypair.publicKey.toString(),
      balance: solBalance,
      balanceLamports: balance
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check X mentions
 */
async function checkMentions() {
  try {
    const mentions = await xBrowser.getMentions();
    return {
      success: true,
      count: mentions.length,
      mentions: mentions.slice(0, 5) // Return last 5
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Reply to a tweet
 */
async function executeReply(content) {
  // Content should be JSON: {"url": "tweet_url", "text": "reply text"}
  try {
    const data = JSON.parse(content);
    if (!data.url || !data.text) {
      return { success: false, error: 'Missing url or text' };
    }

    const result = await xBrowser.replyToTweet(data.url, data.text);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if a post is spam/low quality
 */
function isSpamOrLowQuality(post) {
  // Check spam patterns in text
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(post.text)) return true;
  }

  // Check low quality indicators
  for (const check of LOW_QUALITY_INDICATORS) {
    if (check(post.username) || check(post.text)) return true;
  }

  return false;
}

/**
 * Get community posts (filtered for quality)
 */
async function checkCommunityPosts() {
  const communityId = process.env.X_COMMUNITY_ID;
  if (!communityId) {
    return { success: false, error: 'No community ID configured' };
  }

  try {
    const posts = await xBrowser.getCommunityPosts(communityId);

    // Filter out spam and low quality
    const qualityPosts = posts.filter(post => !isSpamOrLowQuality(post));

    return {
      success: true,
      total: posts.length,
      qualityCount: qualityPosts.length,
      posts: qualityPosts.slice(0, 5) // Return top 5 quality posts
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Post to community
 */
async function executeCommunityPost(content) {
  const communityId = process.env.X_COMMUNITY_ID;
  if (!communityId) {
    return { success: false, error: 'No community ID configured' };
  }

  if (!content || content.length === 0) {
    return { success: false, error: 'Empty post content' };
  }

  let text = content;
  if (text.length > 280) {
    text = text.substring(0, 277) + '...';
  }

  try {
    const result = await xBrowser.postToCommunity(communityId, text);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check Gmail for recent emails
 */
async function checkEmail() {
  if (!Imap) {
    return { success: false, error: 'IMAP not installed (npm install imap)' };
  }

  const email = process.env.GMAIL_ADDRESS;
  const password = process.env.GMAIL_APP_PASSWORD;

  if (!email || !password) {
    return { success: false, error: 'Gmail credentials not configured' };
  }

  return new Promise((resolve) => {
    const imap = new Imap({
      user: email,
      password: password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    const emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) {
          imap.end();
          return resolve({ success: false, error: err.message });
        }

        // Get last 5 emails
        const total = box.messages.total;
        const start = Math.max(1, total - 4);

        const fetch = imap.seq.fetch(`${start}:${total}`, {
          bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)'],
          struct: true
        });

        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            let buffer = '';
            stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            stream.on('end', () => {
              const lines = buffer.split('\r\n');
              const email = {};
              for (const line of lines) {
                if (line.startsWith('From:')) email.from = line.slice(5).trim();
                if (line.startsWith('Subject:')) email.subject = line.slice(8).trim();
                if (line.startsWith('Date:')) email.date = line.slice(5).trim();
              }
              if (email.from) emails.push(email);
            });
          });
        });

        fetch.once('end', () => {
          imap.end();
          resolve({
            success: true,
            count: emails.length,
            emails: emails.reverse() // Most recent first
          });
        });

        fetch.once('error', (err) => {
          imap.end();
          resolve({ success: false, error: err.message });
        });
      });
    });

    imap.once('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    imap.connect();

    // Timeout after 30 seconds
    setTimeout(() => {
      try { imap.end(); } catch (e) {}
      resolve({ success: false, error: 'Connection timeout' });
    }, 30000);
  });
}

/**
 * Send an email via Gmail
 */
async function sendEmail(content) {
  if (!nodemailer) {
    return { success: false, error: 'nodemailer not installed (npm install nodemailer)' };
  }

  const email = process.env.GMAIL_ADDRESS;
  const password = process.env.GMAIL_APP_PASSWORD;

  if (!email || !password) {
    return { success: false, error: 'Gmail credentials not configured' };
  }

  try {
    const data = JSON.parse(content);
    if (!data.to || !data.subject || !data.body) {
      return { success: false, error: 'Missing to, subject, or body' };
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: email, pass: password }
    });

    const info = await transporter.sendMail({
      from: email,
      to: data.to,
      subject: data.subject,
      text: data.body
    });

    return {
      success: true,
      messageId: info.messageId,
      to: data.to,
      subject: data.subject
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Launch token on pump.fun
 */
async function launchToken() {
  console.log('[action-executor] Launching token...');

  try {
    const launcher = require('./launch-token');
    const contractAddress = await launcher.main();

    return {
      success: true,
      contractAddress,
      message: 'Token launched successfully'
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Buy tokens with SOL
 */
async function buyToken(content) {
  console.log('[action-executor] Buying tokens...');

  try {
    const data = typeof content === 'string' ? JSON.parse(content) : content;
    const amount = data.amount || data.amountSOL || 0.1;

    const tokenActions = require('./token-actions');
    const result = await tokenActions.buyTokens(amount);

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sell tokens for SOL
 */
async function sellToken(content) {
  console.log('[action-executor] Selling tokens...');

  try {
    const data = typeof content === 'string' ? JSON.parse(content) : content;
    const amount = data.amount || data.amountTokens || 0;

    if (amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    const tokenActions = require('./token-actions');
    const result = await tokenActions.sellTokens(amount);

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Burn tokens permanently
 */
async function burnToken(content) {
  console.log('[action-executor] Burning tokens...');

  try {
    const data = typeof content === 'string' ? JSON.parse(content) : content;
    const amount = data.amount || data.amountTokens || 0;

    if (amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    const tokenActions = require('./token-actions');
    const result = await tokenActions.burnTokens(amount);

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Lock tokens (send to dead address)
 */
async function lockToken(content) {
  console.log('[action-executor] Locking tokens...');

  try {
    const data = typeof content === 'string' ? JSON.parse(content) : content;
    const amount = data.amount || data.amountTokens || 0;

    if (amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    const tokenActions = require('./token-actions');
    const result = await tokenActions.lockTokens(amount);

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Execute an action
 */
async function executeAction(action) {
  console.log(`[action-executor] Executing: ${action.type}`);

  let result;

  switch (action.type) {
    case 'TWEET':
      result = await executeTweet(action.content);
      break;

    case 'CHECK_WALLET':
    case 'WALLET':
      result = await checkWallet();
      break;

    case 'CHECK_MENTIONS':
    case 'MENTIONS':
      result = await checkMentions();
      break;

    case 'REPLY':
      result = await executeReply(action.content);
      break;

    case 'CHECK_COMMUNITY':
    case 'COMMUNITY':
      result = await checkCommunityPosts();
      break;

    case 'COMMUNITY_POST':
      result = await executeCommunityPost(action.content);
      break;

    case 'CHECK_EMAIL':
    case 'EMAIL':
      result = await checkEmail();
      break;

    case 'SEND_EMAIL':
      result = await sendEmail(action.content);
      break;

    case 'LAUNCH_TOKEN':
    case 'LAUNCH':
      result = await launchToken();
      break;

    case 'BUY_TOKEN':
    case 'BUY':
      result = await buyToken(action.content);
      break;

    case 'SELL_TOKEN':
    case 'SELL':
      result = await sellToken(action.content);
      break;

    case 'BURN_TOKEN':
    case 'BURN':
      result = await burnToken(action.content);
      break;

    case 'LOCK_TOKEN':
    case 'LOCK':
      result = await lockToken(action.content);
      break;

    default:
      result = { success: false, error: `Unknown action type: ${action.type}` };
  }

  // Log the action
  logAction(action, result);

  return result;
}

/**
 * Process agent response for actions and execute them
 * Returns the response text with action tags removed, plus results
 */
async function processAgentResponse(text, agentName = 'developer') {
  const actions = parseActions(text);
  const results = [];

  // Only Developer Clawd can execute actions
  if (agentName !== 'developer' && actions.length > 0) {
    console.log(`[action-executor] ${agentName} requested actions but only developer can execute`);
    return {
      cleanText: text.replace(/\[ACTION:\w+\][\s\S]*?\[\/ACTION\]/g, '').trim(),
      actions: [],
      results: []
    };
  }

  for (const action of actions) {
    const result = await executeAction(action);
    results.push({ action, result });

    // Small delay between actions
    await new Promise(r => setTimeout(r, 1000));
  }

  // Remove action tags from text for display
  const cleanText = text.replace(/\[ACTION:\w+\][\s\S]*?\[\/ACTION\]/g, '').trim();

  return {
    cleanText,
    actions,
    results
  };
}

/**
 * Get recent actions
 */
function getRecentActions(limit = 20) {
  if (!fs.existsSync(ACTION_LOG)) return [];

  const actions = JSON.parse(fs.readFileSync(ACTION_LOG, 'utf8'));
  return actions.slice(-limit);
}

module.exports = {
  parseActions,
  executeAction,
  processAgentResponse,
  getRecentActions,
  executeTweet,
  checkWallet,
  checkMentions,
  checkCommunityPosts,
  executeCommunityPost,
  checkEmail,
  sendEmail,
  launchToken,
  buyToken,
  sellToken,
  burnToken,
  lockToken,
  isSpamOrLowQuality
};

// Test if run directly
if (require.main === module) {
  const testResponse = `
    I think we should post something about our progress.
    [ACTION:TWEET]Just shipped a new feature for clawdrooms. Building in public with my partner. The grind continues.[/ACTION]
    Let me also check our wallet.
    [ACTION:CHECK_WALLET][/ACTION]
  `;

  console.log('Testing action parsing...');
  const actions = parseActions(testResponse);
  console.log('Found actions:', actions);
}
