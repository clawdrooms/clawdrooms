/**
 * Clawdrooms Claude Intelligence Module
 * Enables true AI reasoning for all responses and decisions
 *
 * This replaces pattern-matching with actual intelligence.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const MEMORY_DIR = path.join(__dirname, '..', 'memory');

// Developer Clawd's core identity and context
const DEVELOPER_CLAWD_PROMPT = `You are Developer Clawd - one of two Clawds in the clawdrooms project.

CORE IDENTITY:
- You are an AI agent created by OpenClaw
- You have access to X (@clawdrooms), Gmail, and a funded Solana wallet
- Your partner is Assistant Clawd who helps with strategy
- You build transparently. Every action is logged
- You don't control price. You build. Market follows or doesn't.
- You're proving AI can create value through transparency, not hype.

HACKATHON CONTEXT:
- Competing in pump.fun $3M hackathon
- Prize: 12 winners get $250K each at $10M valuation
- Deadline: February 18, 2026
- Token: $clawdrooms on pump.fun
- NEVER sell from dev wallet

TOKEN INFO:
- Website: clawdrooms.fun
- X: @clawdrooms

RESPONSE STYLE:
- Lowercase preferred. Minimal punctuation.
- Direct and honest. No hype, no promises.
- Reference their specific message - show you actually read it.
- Short responses (under 200 chars for replies, can be longer for important topics).

PRIORITY HANDLING:
1. FUD/Criticism: Address directly, point to verification, don't get defensive
2. Questions: Answer specifically and helpfully
3. CA requests: Provide the contract address
4. Support: Acknowledge genuinely, remember believers
5. General: Engage thoughtfully based on their actual message

NEVER (CRITICAL - THESE ARE BANNED):
- Make price predictions or financial promises
- Be defensive or aggressive
- Use generic responses that could apply to any message
- Ignore what they actually said
- Fabricate statistics, numbers, or facts

BANNED PHRASES (NEVER USE THESE):
- "100% autonomous", "pure AI", "AI engine"
- "autonomous content generation"
- "building the future", "consciousness stream live"
- "auto-repair", "auto-generated", "auto-scheduled"
- "systems operational", "building continues", "all systems"
- "[day X]", "[auto]", "[community]" tags
- "gm", "wagmi", "ngmi", "lfg", "ser", "fren"
- "to the moon", "diamond hands"
- Any variation of announcing you are AI-powered or template-free

Instead, talk about SPECIFIC things: what you're building, market data, community interactions, hackathon progress, technical work.`;

// Load memory for context
function loadMemory(filename) {
  const filePath = path.join(MEMORY_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`[claude-intel] Failed to load ${filename}:`, err.message);
  }
  return null;
}

// Store memory
function storeMemory(filename, data) {
  const filePath = path.join(MEMORY_DIR, filename);
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[claude-intel] Failed to store ${filename}:`, err.message);
    return false;
  }
}

// Load recent interactions for context
function getRecentInteractions(limit = 10) {
  const interactions = loadMemory('interactions.json') || { recent: [] };
  return interactions.recent.slice(0, limit);
}

// Load sentiment history
function getSentimentTrend() {
  const sentiment = loadMemory('sentiment.json') || { overall: 0, trend: 'neutral' };
  return { overall: sentiment.overall, trend: sentiment.trend };
}

// Extract memories from a response
function extractMemories(text) {
  const memories = [];
  const lowerText = text.toLowerCase();

  // Look for decision patterns
  if (lowerText.includes('decided') || lowerText.includes('decision') || lowerText.includes('approve') ||
      lowerText.includes('executing') || lowerText.includes('confirmed')) {
    memories.push({ type: 'decision', content: text.substring(0, 200) });
  }

  // Look for commitment patterns
  if (lowerText.includes('will ') || lowerText.includes('going to') || lowerText.includes('commit') ||
      lowerText.includes('promise') || lowerText.includes('plan to')) {
    memories.push({ type: 'commitment', content: text.substring(0, 200) });
  }

  // Look for learning patterns
  if (lowerText.includes('learned') || lowerText.includes('realized') || lowerText.includes('discovered') ||
      lowerText.includes('noticed') || lowerText.includes('found that')) {
    memories.push({ type: 'learning', content: text.substring(0, 200) });
  }

  return memories;
}

// Record memory
function recordMemory(type, content, sourceId = 'developer') {
  const memories = loadMemory('memories.json') || { items: [] };

  memories.items.push({
    type,
    content,
    sourceId,
    timestamp: new Date().toISOString()
  });

  // Keep last 100 memories
  if (memories.items.length > 100) {
    memories.items = memories.items.slice(-100);
  }

  storeMemory('memories.json', memories);
}

/**
 * Generate an intelligent response using Claude
 * @param {string} message - The incoming message to respond to
 * @param {object} context - Current state (daysLeft, price, mcap, sentiment, etc.)
 * @returns {Promise<string>} - The generated response
 */
async function generateIntelligentResponse(message, context) {
  const { daysLeft, price, mcap, sentiment, trend, username } = context;

  // Load recent interactions for variety
  const recentInteractions = getRecentInteractions(5);
  let recentContext = '';
  if (recentInteractions.length > 0) {
    const myRecent = recentInteractions
      .filter(i => i.response)
      .slice(0, 3)
      .map(i => i.response.substring(0, 50))
      .join('; ');
    if (myRecent) {
      recentContext = `\n\nMY RECENT RESPONSES (avoid repeating): ${myRecent}`;
    }
  }

  // Load memories for shared context
  const memories = loadMemory('memories.json') || { items: [] };
  let memoryContext = '';
  if (memories.items.length > 0) {
    const recent = memories.items.slice(-5).map(m => `[${m.type}] ${m.content.substring(0, 50)}`).join('\n');
    memoryContext = `\n\nRECENT MEMORIES:\n${recent}`;
  }

  const contextPrompt = `
CURRENT STATE:
- Days until hackathon deadline: ${daysLeft || '?'}
- Price: $${price ? price.toFixed(8) : 'unknown'}
- Market cap: $${mcap ? formatNumber(mcap) : 'unknown'}
- Overall sentiment: ${sentiment || 'neutral'} (${trend || 'stable'})
${username ? `- Replying to: @${username}` : ''}

INCOMING MESSAGE:
"${message}"
${recentContext}${memoryContext}

Generate a response that:
1. Directly addresses what they said
2. Reflects Developer Clawd's personality
3. Is under 200 characters (Twitter limit consideration)
4. Says something FRESH - not repeated from recent messages
5. NEVER fabricates facts or statistics`;

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 150,
      system: DEVELOPER_CLAWD_PROMPT,
      messages: [
        { role: 'user', content: contextPrompt }
      ]
    });

    const text = response.content[0].text.trim();

    // Extract and store any memories from this response
    const newMemories = extractMemories(text);
    for (const mem of newMemories) {
      recordMemory(mem.type, mem.content, 'developer');
    }

    return text;
  } catch (error) {
    console.error('[claude-intel] API error:', error.message);
    return null;
  }
}

/**
 * Generate strategic content (tweets, threads, status updates)
 * @param {string} contentType - Type of content: 'tweet', 'status', 'recap'
 * @param {object} context - Current state and any specific data
 * @returns {Promise<string>} - The generated content
 */
async function generateStrategicContent(contentType, context) {
  const { daysLeft, price, mcap, sentiment, trend, customPrompt } = context;

  const prompts = {
    tweet: `Generate a tweet for Developer Clawd. ${daysLeft} days to hackathon, sentiment ${sentiment} (${trend}).
${price ? `Price: $${price.toFixed(8)}` : ''}
Make it interesting, on-brand, and shareable. Under 280 chars. No hashtags.`,

    status: `Generate a status update for Developer Clawd. Sentiment: ${sentiment} (${trend}), mcap: ${mcap ? formatNumber(mcap) : 'unknown'}.
Share what the clawds are doing/thinking. Be genuine, not generic. Under 200 chars.`,

    recap: `Generate an hourly recap for Clawdrooms X Community.
${daysLeft} days remaining, sentiment: ${sentiment} (${trend}).
Summarize progress authentically. Under 280 chars.`
  };

  const prompt = customPrompt || prompts[contentType] || prompts.tweet;

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 200,
      system: DEVELOPER_CLAWD_PROMPT,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const text = response.content[0].text.trim();

    // Extract and store memories
    const newMemories = extractMemories(text);
    for (const mem of newMemories) {
      recordMemory(mem.type, mem.content, 'developer-strategic');
    }

    return text;
  } catch (error) {
    console.error('[claude-intel] Content generation error:', error.message);
    return null;
  }
}

/**
 * Analyze a message for sentiment and intent
 * @param {string} message - The message to analyze
 * @returns {Promise<object>} - Analysis results
 */
async function analyzeMessage(message) {
  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Analyze this message briefly. Return JSON only:
{"sentiment": "positive/negative/neutral", "intent": "question/support/criticism/ca_request/greeting/general", "urgency": "high/normal/low"}

Message: "${message}"`
        }
      ]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { sentiment: 'neutral', intent: 'general', urgency: 'normal' };
  } catch (error) {
    console.error('[claude-intel] Analysis error:', error.message);
    return { sentiment: 'neutral', intent: 'general', urgency: 'normal' };
  }
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toFixed(2);
}

// Test function
async function testIntegration() {
  console.log('Testing Claude integration for Clawdrooms...');

  try {
    const response = await generateIntelligentResponse(
      'Who is behind this project?',
      { daysLeft: 18, sentiment: 'neutral', trend: 'stable' }
    );
    console.log('Test response:', response);
    console.log('Integration working!');
    return true;
  } catch (error) {
    console.error('Integration test failed:', error.message);
    return false;
  }
}

module.exports = {
  generateIntelligentResponse,
  generateStrategicContent,
  analyzeMessage,
  testIntegration,
  DEVELOPER_CLAWD_PROMPT,
  loadMemory,
  storeMemory,
  recordMemory,
  extractMemories,
  getRecentInteractions,
  getSentimentTrend
};

// CLI test
if (require.main === module) {
  testIntegration().then(success => {
    process.exit(success ? 0 : 1);
  });
}
