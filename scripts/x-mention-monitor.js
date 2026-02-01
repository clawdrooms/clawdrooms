/**
 * X Mention Monitor for Clawdrooms
 *
 * Monitors @clawdrooms mentions and enables intelligent replies:
 * - Fetches recent mentions via browser
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
let contextualIntelligence, xBrowserPoster;

try {
  contextualIntelligence = require('./contextual-intelligence');
  console.log('[x-mentions] Contextual intelligence loaded');
} catch (err) {
  console.log('[x-mentions] Contextual intelligence not available:', err.message);
}

try {
  xBrowserPoster = require('./x-browser-poster');
  console.log('[x-mentions] X browser poster loaded');
} catch (err) {
  console.log('[x-mentions] X browser poster not available:', err.message);
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
SHARED MEMORY (what clawdrooms knows):${memoryContext || ' No specific memories'}${sentimentContext}

CURRENT STATE:
- Days until hackathon: ${daysLeft}

THEIR MESSAGE FROM @${mention.author}:
"${mention.text}"

${specificGuidance}

Reply as Developer Clawd. Be authentic, not robotic. Under 200 characters. No hashtags.
${conversationContext ? 'IMPORTANT: Reference previous conversation context if relevant.' : ''}`;

    const response = await claudeClient.messages.create({
      model: 'claude-3-haiku-20240307',
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
  // Thread replies
  else if (mention.inReplyTo) {
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
  if (!xBrowserPoster || !xBrowserPoster.replyToTweet) {
    console.log('[x-mentions] Cannot reply - browser poster not available');
    return { success: false, error: 'Browser poster not available' };
  }

  // Check rate limit
  if (!canReplyNow()) {
    console.log('[x-mentions] Rate limited');
    return { success: false, error: 'Rate limited' };
  }

  try {
    // Build tweet URL for reply
    const tweetUrl = `https://x.com/${authorHandle}/status/${mentionId}`;

    console.log(`[x-mentions] Replying to @${authorHandle}: "${replyText.substring(0, 50)}..."`);

    const result = await xBrowserPoster.replyToTweet(tweetUrl, replyText);

    if (result.success) {
      // Record the reply with full context for future conversations
      recordReply({
        mentionId,
        authorHandle,
        incomingText: context.incomingText || null,
        replyText,
        replyId: result.replyId || null,
        timestamp: new Date().toISOString()
      });

      console.log(`[x-mentions] Successfully replied`);
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
  if (!xBrowserPoster || !xBrowserPoster.getMentions) {
    console.log('[x-mentions] Cannot fetch mentions - browser not available');
    return [];
  }

  try {
    console.log('[x-mentions] Fetching mentions via browser...');
    const mentions = await xBrowserPoster.getMentions();
    return mentions || [];
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
  CLAWDROOMS X MENTION MONITOR - DAEMON MODE
================================================================================
  Check interval: ${DAEMON_CHECK_INTERVAL_MS / 1000} seconds
  Monitoring: @clawdrooms mentions
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
