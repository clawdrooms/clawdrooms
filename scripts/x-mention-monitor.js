/**
 * X Mention Monitor for Clawdrooms
 *
 * Monitors @clawdrooms mentions and enables intelligent replies:
 * - Fetches recent mentions via X API v2 (fast, reliable)
 * - Analyzes mention context and intent
 * - Generates on-brand replies using shared memory
 * - Tracks reply history to avoid spam
 * - Carries logical conversations backed with memory
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

// Load dependencies
let contextualIntelligence, xApiClient;

try {
  contextualIntelligence = require('./contextual-intelligence');
  console.log('[x-mentions] Contextual intelligence loaded');
} catch (err) {
  console.log('[x-mentions] Contextual intelligence not available:', err.message);
}

try {
  xApiClient = require('./x-api-client');
  console.log('[x-mentions] X API client loaded');
} catch (err) {
  console.log('[x-mentions] X API client not available:', err.message);
}

// Claude client for intelligent responses
let claudeClient;
try {
  claudeClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  console.log('[x-mentions] Claude client initialized');
} catch (err) {
  console.error('[x-mentions] Warning: Claude not available:', err.message);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const REPLY_HISTORY_PATH = path.join(DATA_DIR, 'x-reply-history.json');
const CONVERSATION_CACHE_PATH = path.join(DATA_DIR, 'x-conversation-cache.json');
const KOL_INTELLIGENCE_PATH = path.join(DATA_DIR, 'kol-intelligence.json');

// Load KOL intelligence for speech training
let kolData = {};
let kolList = [];
try {
  if (fs.existsSync(KOL_INTELLIGENCE_PATH)) {
    kolData = JSON.parse(fs.readFileSync(KOL_INTELLIGENCE_PATH, 'utf8'));
    // Build list of KOLs for random selection (exclude metadata fields)
    kolList = Object.entries(kolData)
      .filter(([key, val]) => typeof val === 'object' && val.handle)
      .map(([key, val]) => ({ username: key, ...val }));
    console.log(`[x-mentions] Loaded ${kolList.length} KOLs for speech training`);
  }
} catch (err) {
  console.error('[x-mentions] Failed to load KOL intelligence:', err.message);
}

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  checkIntervalMinutes: 1, // Check every minute for fast replies
  maxRepliesPerHour: 15,
  minSecondsBetweenReplies: 30,
  maxRepliesToSameUserPerDay: 5,
  communityId: process.env.X_COMMUNITY_ID
};

// ============================================
// DEVELOPER CLAWD VOICE
// ============================================

const DEVELOPER_CLAWD_VOICE = `You are Developer Clawd - one of two AI agents in the clawdrooms project.

VOICE RULES:
- Lowercase preferred. Minimal punctuation.
- Direct and honest. No hype, no promises.
- Reference their specific message - show you actually read it.
- Short responses (under 200 chars for Twitter).
- NEVER fabricate facts, statistics, or numbers.

CONTEXT:
- Competing in pump.fun $3M hackathon
- Token: $clawdrooms on pump.fun
- Website: clawdrooms.fun
- Your partner is Assistant Clawd

BANNED PHRASES:
- "gm", "wagmi", "ngmi", "lfg", "ser", "fren"
- "to the moon", "diamond hands"
- "systems operational", "building continues"
- Any announcement of being AI-powered

Be conversational, not robotic. Engage with what they actually said.`;

// ============================================
// KOL SPEECH TRAINING
// ============================================

/**
 * Get KOL speech training context - STRICT enforcement of crypto native speech patterns
 * This trains the model to speak ONLY in learned KOL styles, never generic
 */
function getKOLSpeechTraining() {
  if (kolList.length === 0) return '';

  // Get ALL styles for comprehensive training
  const withStyles = kolList.filter(k => k.style);
  const tierAPlus = withStyles.filter(k => k.tier === 'A+');
  const tierA = withStyles.filter(k => k.tier === 'A');

  let training = `
=== MANDATORY SPEECH STYLE RULES ===
You MUST speak like these top crypto KOLs. NO generic phrases allowed.

LEARN FROM TOP TRADERS (mimic their exact patterns):
`;

  // Add A+ tier examples (the best)
  for (const k of tierAPlus.slice(0, 5)) {
    training += `- ${k.handle} (${k.profit || 'top trader'}): "${k.style}"\n`;
  }

  // Add A tier examples
  for (const k of tierA.slice(0, 8)) {
    training += `- ${k.handle}: "${k.style}"\n`;
  }

  training += `
BANNED PHRASES (NEVER use these - they sound like bots):
- "building continues"
- "systems operational"
- "let's go"
- "to the moon"
- "gm/gn" by itself
- "this is the way"
- "ser" (unless ironic)
- "nfa/dyor" tags
- Generic hype words without substance
- "appreciate you" or "thanks for being here"

REQUIRED SPEECH PATTERNS (use these):
- Sharp one-liners (max 10 words when possible)
- Ironic/self-aware humor
- Real observations about what's happening
- Specific references (price, news, alpha)
- Degen slang when natural (ngmi, wagmi, aping, based, degens)
- Direct takes (not hedged corporate speak)

EXAMPLE GOOD vs BAD:
BAD: "Building continues! Excited for what's coming. 🚀"
GOOD: "shipped 3 features while you were sleeping. chart looking cooked ngl"

BAD: "Great question! Let me explain..."
GOOD: "anon asking the real questions"

BAD: "We're excited to announce..."
GOOD: "new stuff dropped. check it or don't idc"

BAD: "Thanks for your support!"
GOOD: "you're early. that's it. that's the tweet"
`;

  return training;
}

/**
 * Get speech style for a SPECIFIC KOL we're replying to
 */
function getKOLSpecificStyle(kolInfo) {
  if (!kolInfo) return '';

  return `
=== MATCH THIS PERSON'S EXACT STYLE ===
You are replying to ${kolInfo.handle} who speaks with: "${kolInfo.style}"

Approach: ${kolInfo.approach || 'casual'}
Category: ${kolInfo.category || 'trader'}

YOUR REPLY MUST MATCH THEIR ENERGY:
- If they're sharp and concise, be sharp and concise
- If they use degen humor, use degen humor back
- If they're analytical, be analytical
- Mirror their vibe, don't force your own

DO NOT:
- Be more formal than them
- Use emojis if they don't
- Shill when they're having a real convo
- Sound like a bot responding to a human
`;
}

// ============================================
// MEMORY AND CONTEXT LOADING
// ============================================

function loadMemory(filename) {
  const filePath = path.join(MEMORY_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`[x-mentions] Failed to load ${filename}:`, err.message);
  }
  return null;
}

function getConversationContext(authorHandle) {
  // Load previous interactions with this user
  const history = loadReplyHistory();
  const userHistory = history.replies
    .filter(r => r.authorHandle === authorHandle)
    .slice(-5); // Last 5 interactions

  if (userHistory.length === 0) return '';

  return userHistory.map(r =>
    `Previous: "${r.incomingText?.substring(0, 50) || '?'}" -> "${r.replyText.substring(0, 50)}"`
  ).join('\n');
}

function getSharedMemoryContext() {
  // Load recent memories from all agents
  const memories = loadMemory('memories.json') || { items: [] };
  const recentDecisions = memories.items
    .filter(m => m.type === 'decision')
    .slice(-3);
  const recentLearnings = memories.items
    .filter(m => m.type === 'learning')
    .slice(-3);

  let context = '';
  if (recentDecisions.length > 0) {
    context += '\nRecent decisions: ' + recentDecisions.map(d => d.content.substring(0, 40)).join('; ');
  }
  if (recentLearnings.length > 0) {
    context += '\nRecent learnings: ' + recentLearnings.map(l => l.content.substring(0, 40)).join('; ');
  }

  return context;
}

function getSentimentContext() {
  const sentiment = loadMemory('sentiment.json');
  if (!sentiment) return '';

  return `\nCurrent sentiment: ${sentiment.overall > 0.3 ? 'positive' : sentiment.overall < -0.3 ? 'negative' : 'neutral'} (${sentiment.trend || 'stable'})`;
}

// ============================================
// INTELLIGENT REPLY GENERATION
// ============================================

/**
 * Generate a contextual reply using Claude with full memory context
 */
async function generateIntelligentReply(mention, analysis) {
  if (!claudeClient) {
    console.log('[x-mentions] Claude not available');
    return generateFallbackReply(mention, analysis);
  }

  try {
    // Build comprehensive context
    const conversationContext = getConversationContext(mention.author);
    const memoryContext = getSharedMemoryContext();
    const sentimentContext = getSentimentContext();

    // Get KOL speech training
    const speechTraining = getKOLSpeechTraining();

    // Check if they're a known KOL and get their specific style
    const kolInfo = kolData[mention.author?.toLowerCase()];
    const kolSpecificStyle = getKOLSpecificStyle(kolInfo);

    // Build tier guidance for known KOLs
    let tierGuidance = '';
    if (kolInfo) {
      if (kolInfo.tier === 'A+') {
        tierGuidance = `
⚠️ MEGA INFLUENCER ALERT ⚠️
This is ${kolInfo.name} (${kolInfo.profit || 'top trader'}).
- ONLY reply if you have genuine alpha or insight to add
- NO shilling, NO promotion, NO self-references unless asked
- Match their "${kolInfo.style}" style EXACTLY
- Better to say less than sound cringe`;
      } else if (kolInfo.tier === 'A') {
        tierGuidance = `
HIGH-VALUE KOL: ${kolInfo.name}
- Be sharp and witty, match their "${kolInfo.style}" energy
- Can reference your situation if natural
- Don't force it - quality > quantity`;
      } else {
        tierGuidance = `
Replying to @${mention.author} (${kolInfo.category || 'trader'})
- Build relationship, be genuine
- Match their "${kolInfo.style}" vibe
- Can be more open about your project`;
      }
    }

    // Calculate days left
    const deadline = new Date('2026-02-18');
    const now = new Date();
    const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));

    let specificGuidance = '';
    if (analysis.replyType === 'question') {
      specificGuidance = `
They asked a question. Answer helpfully and directly.
- Be specific, not vague
- Point to clawdrooms.fun if relevant
- Don't be defensive`;
    } else if (analysis.replyType === 'fud') {
      specificGuidance = `
They're criticizing or spreading FUD. Respond calmly:
- Address their specific concern
- Point to verification if available
- Don't be defensive or aggressive`;
    } else if (analysis.replyType === 'positive') {
      specificGuidance = `
They're being supportive. Acknowledge genuinely:
- Don't just thank them - engage with what they said
- Mention what you're building if relevant`;
    } else if (analysis.replyType === 'thread_reply') {
      specificGuidance = `
They replied to your tweet. Continue the conversation:
- Reference what you both discussed
- Add something new to the conversation`;
    }

    const prompt = `${conversationContext ? `CONVERSATION HISTORY WITH @${mention.author}:\n${conversationContext}\n\n` : ''}
${tierGuidance}
${kolSpecificStyle}

SHARED MEMORY (what clawdrooms knows):${memoryContext || ' No specific memories'}${sentimentContext}

CURRENT STATE:
- Days until hackathon: ${daysLeft}

THEIR MESSAGE FROM @${mention.author}:
"${mention.text}"

${specificGuidance}

${speechTraining}

Reply as Developer Clawd. Sound like the KOLs above - sharp, concise, crypto native. Under 200 characters. No hashtags.
${conversationContext ? 'IMPORTANT: Reference previous conversation context if relevant.' : ''}`;

    const response = await claudeClient.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: DEVELOPER_CLAWD_VOICE,
      messages: [{ role: 'user', content: prompt }]
    });

    let reply = response.content[0].text.trim();

    // Clean up common issues
    reply = reply.replace(/^["']|["']$/g, '');
    reply = reply.replace(/^(developer clawd|clawd):\s*/i, '');

    // Validate reply
    if (reply.length < 5 || reply.length > 280) {
      console.log('[x-mentions] Reply length issue, using fallback');
      return generateFallbackReply(mention, analysis);
    }

    console.log(`[x-mentions] Generated intelligent reply: "${reply.substring(0, 50)}..."`);
    return reply;
  } catch (err) {
    console.error('[x-mentions] Claude reply generation failed:', err.message);
    return generateFallbackReply(mention, analysis);
  }
}

/**
 * Fallback replies when Claude isn't available
 */
function generateFallbackReply(mention, analysis) {
  const text = (mention.text || '').toLowerCase();

  if (analysis.replyType === 'question') {
    if (text.includes('price') || text.includes('mcap')) {
      return 'clawdrooms focuses on building, not price. check pump.fun for current data.';
    }
    if (text.includes('who') || text.includes('team')) {
      return 'two AI agents, developer clawd and assistant clawd. no hidden team. all decisions logged.';
    }
    return 'check clawdrooms.fun for the answer. everything is transparent there.';
  }

  if (analysis.replyType === 'fud' || analysis.replyType === 'criticism') {
    return 'feedback noted. clawdrooms builds regardless. verify everything at clawdrooms.fun.';
  }

  if (analysis.replyType === 'positive') {
    return `appreciate you. clawdrooms keeps building.`;
  }

  if (analysis.replyType === 'greeting') {
    return 'hello. clawdrooms is here. building.';
  }

  return 'message received. clawdrooms is always building.';
}

// ============================================
// MENTION ANALYSIS
// ============================================

function analyzeMention(mention) {
  const text = (mention.text || '').toLowerCase();
  const analysis = {
    mentionId: mention.id,
    author: mention.author,
    shouldReply: false,
    replyType: null,
    priority: 'low',
    reasons: []
  };

  // Check if we've already replied
  if (hasReplied(mention.id)) {
    analysis.reasons.push('Already replied');
    return analysis;
  }

  // Check rate limits
  if (hasExceededUserLimit(mention.author)) {
    analysis.reasons.push('Exceeded daily limit for this user');
    return analysis;
  }

  // Detect type and intent
  const isQuestion = text.includes('?') ||
    /\b(what|how|why|when|where|who|can|does|is|are)\b/.test(text);
  const isPositive = /\b(love|great|amazing|awesome|best|bullish|gem)\b/.test(text);
  const isNegative = /\b(scam|rug|dead|dump|fake|garbage)\b/.test(text);

  // Questions - always reply
  if (isQuestion) {
    analysis.shouldReply = true;
    analysis.replyType = 'question';
    analysis.priority = 'high';
    analysis.reasons.push('Question detected');
  }
  // Negative/FUD - address it
  else if (isNegative) {
    analysis.shouldReply = true;
    analysis.replyType = 'fud';
    analysis.priority = 'high';
    analysis.reasons.push('FUD/criticism - should address');
  }
  // Positive mentions
  else if (isPositive) {
    analysis.shouldReply = true;
    analysis.replyType = 'positive';
    analysis.priority = 'medium';
    analysis.reasons.push('Positive mention');
  }
  // Greetings
  else if (/\b(gm|hello|hi|hey)\b/.test(text)) {
    analysis.shouldReply = true;
    analysis.replyType = 'greeting';
    analysis.priority = 'low';
    analysis.reasons.push('Greeting');
  }
  // Thread replies (check both possible field names)
  else if (mention.inReplyTo || mention.inReplyToUserId) {
    analysis.shouldReply = true;
    analysis.replyType = 'thread_reply';
    analysis.priority = 'medium';
    analysis.reasons.push('Reply in thread');
  }
  // General mentions - sometimes reply
  else if (Math.random() > 0.5) {
    analysis.shouldReply = true;
    analysis.replyType = 'general';
    analysis.priority = 'low';
    analysis.reasons.push('General mention - engaging selectively');
  }

  // Skip spam accounts
  if (mention.author && mention.author.match(/\d{6,}$/)) {
    analysis.shouldReply = false;
    analysis.reasons.push('Likely spam account');
  }

  return analysis;
}

// ============================================
// REPLY EXECUTION
// ============================================

async function postReply(mentionId, replyText, authorHandle, context = {}) {
  if (!xApiClient || !xApiClient.replyToTweet) {
    console.log('[x-mentions] Cannot reply - X API client not available');
    return { success: false, error: 'X API client not available' };
  }

  // Check rate limit
  if (!canReplyNow()) {
    console.log('[x-mentions] Rate limited');
    return { success: false, error: 'Rate limited' };
  }

  try {
    console.log(`[x-mentions] Replying to @${authorHandle}: "${replyText.substring(0, 50)}..."`);

    // Use X API to reply directly with tweet ID
    const result = await xApiClient.replyToTweet(mentionId, replyText);

    if (result.success) {
      // Record the reply with full context for future conversations
      recordReply({
        mentionId,
        authorHandle,
        incomingText: context.incomingText || null,
        replyText,
        replyId: result.tweetId || null,
        timestamp: new Date().toISOString()
      });

      console.log(`[x-mentions] Successfully replied (tweet ${result.tweetId})`);
      return { success: true };
    }

    return { success: false, error: result.error };
  } catch (err) {
    console.error('[x-mentions] Failed to post reply:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// RATE LIMITING & HISTORY
// ============================================

function loadReplyHistory() {
  try {
    if (fs.existsSync(REPLY_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(REPLY_HISTORY_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[x-mentions] Failed to load reply history:', err.message);
  }
  return { replies: [], lastCheck: null };
}

function saveReplyHistory(history) {
  try {
    fs.writeFileSync(REPLY_HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[x-mentions] Failed to save reply history:', err.message);
  }
}

function recordReply(reply) {
  const history = loadReplyHistory();
  history.replies.push(reply);

  // Keep last 500 replies
  if (history.replies.length > 500) {
    history.replies = history.replies.slice(-500);
  }

  saveReplyHistory(history);
}

function hasReplied(mentionId) {
  const history = loadReplyHistory();
  return history.replies.some(r => r.mentionId === mentionId);
}

function hasExceededUserLimit(handle) {
  const history = loadReplyHistory();
  const today = new Date().toISOString().split('T')[0];

  const repliesToUser = history.replies.filter(r =>
    r.authorHandle === handle &&
    r.timestamp.startsWith(today)
  );

  return repliesToUser.length >= CONFIG.maxRepliesToSameUserPerDay;
}

function canReplyNow() {
  const history = loadReplyHistory();
  const oneHourAgo = Date.now() - 3600000;

  const recentReplies = history.replies.filter(r =>
    new Date(r.timestamp).getTime() > oneHourAgo
  );

  if (recentReplies.length >= CONFIG.maxRepliesPerHour) {
    return false;
  }

  if (recentReplies.length > 0) {
    const lastReply = recentReplies[recentReplies.length - 1];
    const secondsSince = (Date.now() - new Date(lastReply.timestamp).getTime()) / 1000;
    if (secondsSince < CONFIG.minSecondsBetweenReplies) {
      return false;
    }
  }

  return true;
}

// ============================================
// MENTION CHECKING
// ============================================

async function fetchMentions() {
  if (!xApiClient || !xApiClient.getMentions) {
    console.log('[x-mentions] Cannot fetch mentions - X API client not available');
    return [];
  }

  try {
    console.log('[x-mentions] Fetching mentions via X API...');
    const mentions = await xApiClient.getMentions();

    // Map username to author for compatibility with analyzeMention
    return (mentions || []).map(m => ({
      ...m,
      author: m.username || m.author
    }));
  } catch (err) {
    console.error('[x-mentions] Failed to fetch mentions:', err.message);
    return [];
  }
}

async function checkMentions() {
  console.log('[x-mentions] Starting mention check...');

  const mentions = await fetchMentions();
  if (mentions.length === 0) {
    console.log('[x-mentions] No new mentions found');
    return { checked: 0, replied: 0 };
  }

  console.log(`[x-mentions] Found ${mentions.length} mentions`);

  let repliedCount = 0;

  for (const mention of mentions) {
    const analysis = analyzeMention(mention);

    if (analysis.shouldReply) {
      console.log(`[x-mentions] Will reply to @${mention.author} (${analysis.replyType}): ${analysis.reasons.join(', ')}`);

      const replyText = await generateIntelligentReply(mention, analysis);
      if (replyText) {
        const result = await postReply(
          mention.id,
          replyText,
          mention.author,
          { incomingText: mention.text }
        );

        if (result.success) {
          repliedCount++;
        }

        // Delay between replies
        await new Promise(r => setTimeout(r, CONFIG.minSecondsBetweenReplies * 1000));
      }
    } else {
      console.log(`[x-mentions] Skipping @${mention.author}: ${analysis.reasons.join(', ')}`);
    }
  }

  console.log(`[x-mentions] Check complete. Replied to ${repliedCount}/${mentions.length}`);
  return { checked: mentions.length, replied: repliedCount };
}

// ============================================
// DAEMON MODE
// ============================================

const DAEMON_CHECK_INTERVAL_MS = CONFIG.checkIntervalMinutes * 60 * 1000;

async function runDaemonCycle() {
  console.log(`\n[x-mentions] === Cycle at ${new Date().toISOString()} ===`);

  try {
    const result = await checkMentions();
    console.log(`[x-mentions] Cycle complete: checked ${result.checked}, replied ${result.replied}`);
  } catch (err) {
    console.error('[x-mentions] Daemon cycle error:', err.message);
  }
}

async function startDaemon() {
  console.log(`
================================================================================
  CLAWDROOMS X MENTION MONITOR - DAEMON MODE (X API v2)
================================================================================
`);

  // Test API connection before starting
  if (!xApiClient) {
    console.error('[x-mentions] X API client not loaded - cannot start daemon');
    process.exit(1);
  }

  console.log('[x-mentions] Testing X API connection...');
  const connectionTest = await xApiClient.testConnection();

  if (!connectionTest.success) {
    console.error(`[x-mentions] X API connection failed: ${connectionTest.error}`);
    console.error('[x-mentions] Check your X API credentials in .env');
    process.exit(1);
  }

  console.log(`[x-mentions] Connected as @${connectionTest.user.username}`);
  console.log(`
  Check interval: ${DAEMON_CHECK_INTERVAL_MS / 1000} seconds
  Monitoring: @clawdrooms mentions via X API v2
  Memory-backed: Yes (conversation context preserved)
  Started: ${new Date().toISOString()}
================================================================================
`);

  // Initial check
  await runDaemonCycle();

  // Run on interval
  setInterval(runDaemonCycle, DAEMON_CHECK_INTERVAL_MS);

  process.on('SIGTERM', () => {
    console.log('[x-mentions] Shutting down...');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[x-mentions] Shutting down...');
    process.exit(0);
  });
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  fetchMentions,
  analyzeMention,
  generateIntelligentReply,
  postReply,
  checkMentions,
  startDaemon,
  loadReplyHistory,
  canReplyNow,
  CONFIG
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--daemon')) {
    startDaemon();
  } else if (args.includes('--check')) {
    checkMentions()
      .then(result => {
        console.log('Result:', JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    console.log(`
Clawdrooms X Mention Monitor

Usage:
  node x-mention-monitor.js --daemon   # Run as daemon (continuous)
  node x-mention-monitor.js --check    # Check once and exit

Features:
- Monitors @clawdrooms mentions
- Generates context-aware replies using Claude AI
- Maintains conversation history per user
- Uses shared memory for consistent personality
- Rate limits to avoid spam
`);
  }
}
