/**
 * Clawdrooms Contextual Intelligence System
 *
 * This module handles:
 * - Reading and understanding messages from X
 * - Sentiment analysis and tracking
 * - Context-aware response generation with Claude AI
 * - Memory persistence and learning
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Claude AI Integration
let claudeIntelligence = null;
try {
  claudeIntelligence = require('./claude-intelligence.js');
  console.log('[context] Claude AI integration loaded');
} catch (err) {
  console.log('[context] Claude integration not available, using pattern matching fallback');
}

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const INTERACTIONS_FILE = path.join(MEMORY_DIR, 'interactions.json');
const SENTIMENT_FILE = path.join(MEMORY_DIR, 'sentiment.json');
const CONTEXT_FILE = path.join(MEMORY_DIR, 'context-learning.json');

// Ensure memory directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// ==================== SENTIMENT ANALYSIS ====================

const POSITIVE_SIGNALS = [
  'love', 'bullish', 'based', 'lfg', 'moon', 'pump', 'buy', 'holding', 'hold',
  'amazing', 'great', 'awesome', 'nice', 'good', 'best', 'fire', 'gem', 'early',
  'believe', 'trust', 'support', 'excited', 'fan', 'following', 'watching',
  'gm', 'wagmi', 'let\'s go', 'congrats', 'respect', 'impressive', 'cool',
  'transparent', 'honest', 'real', 'legit', 'interesting', 'unique', 'different'
];

const NEGATIVE_SIGNALS = [
  'scam', 'rug', 'fake', 'dead', 'dump', 'sell', 'selling', 'sold', 'exit',
  'bad', 'terrible', 'awful', 'hate', 'boring', 'pointless', 'useless',
  'ngmi', 'rip', 'over', 'done', 'finished', 'fail', 'failed', 'failing',
  'waste', 'garbage', 'trash', 'shit', 'crap', 'stupid', 'dumb', 'joke',
  'suspicious', 'sketchy', 'shady', 'bot', 'shill', 'spam'
];

const QUESTION_SIGNALS = [
  '?', 'what', 'who', 'where', 'when', 'why', 'how', 'can', 'could', 'would',
  'should', 'is it', 'are you', 'do you', 'does', 'explain', 'tell me'
];

const INTENT_SIGNALS = {
  buy: ['buy', 'purchase', 'get some', 'ape', 'aped', 'buying', 'where to buy'],
  ca: ['ca', 'contract', 'address', 'token address', 'mint'],
  price: ['price', 'chart', 'mcap', 'market cap', 'volume', 'ath', 'atl'],
  info: ['what is', 'who is', 'explain', 'about', 'tell me about'],
  support: ['love', 'support', 'believe', 'holding', 'fan', 'follower'],
  criticism: ['scam', 'rug', 'fake', 'bot', 'shill', 'spam', 'dead'],
  greeting: ['gm', 'gn', 'hello', 'hi', 'hey', 'yo', 'sup'],
  engagement: ['retweet', 'share', 'spread', 'tell friends', 'community']
};

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  let positiveCount = 0;
  let negativeCount = 0;
  let questionCount = 0;

  // Count signals
  for (const word of words) {
    if (POSITIVE_SIGNALS.some(s => word.includes(s))) positiveCount++;
    if (NEGATIVE_SIGNALS.some(s => word.includes(s))) negativeCount++;
  }

  // Check for questions
  for (const signal of QUESTION_SIGNALS) {
    if (lower.includes(signal)) questionCount++;
  }

  // Calculate sentiment score (-1 to 1)
  const total = positiveCount + negativeCount;
  let score = 0;
  if (total > 0) {
    score = (positiveCount - negativeCount) / total;
  }

  // Determine sentiment category
  let category;
  if (score > 0.3) category = 'positive';
  else if (score < -0.3) category = 'negative';
  else if (questionCount > 0) category = 'curious';
  else category = 'neutral';

  // Detect primary intent
  let intent = 'general';
  for (const [intentType, signals] of Object.entries(INTENT_SIGNALS)) {
    if (signals.some(s => lower.includes(s))) {
      intent = intentType;
      break;
    }
  }

  return {
    score,
    category,
    intent,
    positiveCount,
    negativeCount,
    isQuestion: questionCount > 0,
    raw: {
      text: text.substring(0, 200),
      timestamp: Date.now()
    }
  };
}

// ==================== MEMORY MANAGEMENT ====================

function loadInteractions() {
  try {
    if (fs.existsSync(INTERACTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(INTERACTIONS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[context] failed to load interactions:', err.message);
  }
  return {
    total: 0,
    byIntent: {},
    bySentiment: {},
    recent: [],
    patterns: []
  };
}

function saveInteractions(data) {
  try {
    fs.writeFileSync(INTERACTIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[context] failed to save interactions:', err.message);
  }
}

function loadSentimentHistory() {
  try {
    if (fs.existsSync(SENTIMENT_FILE)) {
      return JSON.parse(fs.readFileSync(SENTIMENT_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[context] failed to load sentiment:', err.message);
  }
  return {
    overall: 0,
    trend: 'neutral',
    history: [],
    hourly: {},
    daily: {}
  };
}

function saveSentimentHistory(data) {
  try {
    fs.writeFileSync(SENTIMENT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[context] failed to save sentiment:', err.message);
  }
}

function loadContextLearning() {
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[context] failed to load context learning:', err.message);
  }
  return {
    effectiveResponses: [],
    ineffectiveResponses: [],
    topicInsights: {},
    sentimentShiftPatterns: [],
    lastUpdated: null
  };
}

function saveContextLearning(data) {
  data.lastUpdated = Date.now();
  try {
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[context] failed to save context learning:', err.message);
  }
}

// ==================== CONTEXT PROCESSING ====================

function processIncomingMessage(message, authorId, tweetId) {
  const sentiment = analyzeSentiment(message);
  const interactions = loadInteractions();
  const sentimentHistory = loadSentimentHistory();

  // Record interaction
  const interaction = {
    id: crypto.randomBytes(4).toString('hex'),
    tweetId,
    authorId,
    message: message.substring(0, 500),
    sentiment,
    timestamp: Date.now(),
    responded: false,
    response: null
  };

  // Update interaction stats
  interactions.total++;
  interactions.byIntent[sentiment.intent] = (interactions.byIntent[sentiment.intent] || 0) + 1;
  interactions.bySentiment[sentiment.category] = (interactions.bySentiment[sentiment.category] || 0) + 1;

  // Keep recent interactions (last 500)
  interactions.recent.unshift(interaction);
  if (interactions.recent.length > 500) {
    interactions.recent = interactions.recent.slice(0, 500);
  }

  // Update sentiment tracking
  sentimentHistory.history.push({
    score: sentiment.score,
    category: sentiment.category,
    timestamp: Date.now()
  });

  // Keep last 1000 sentiment records
  if (sentimentHistory.history.length > 1000) {
    sentimentHistory.history = sentimentHistory.history.slice(-1000);
  }

  // Calculate rolling sentiment
  const recentSentiments = sentimentHistory.history.slice(-50);
  if (recentSentiments.length > 0) {
    sentimentHistory.overall = recentSentiments.reduce((sum, s) => sum + s.score, 0) / recentSentiments.length;

    // Determine trend
    if (recentSentiments.length >= 10) {
      const oldAvg = recentSentiments.slice(0, 5).reduce((sum, s) => sum + s.score, 0) / 5;
      const newAvg = recentSentiments.slice(-5).reduce((sum, s) => sum + s.score, 0) / 5;
      if (newAvg > oldAvg + 0.1) sentimentHistory.trend = 'improving';
      else if (newAvg < oldAvg - 0.1) sentimentHistory.trend = 'declining';
      else sentimentHistory.trend = 'stable';
    }
  }

  // Update hourly tracking
  const hour = new Date().getHours();
  if (!sentimentHistory.hourly[hour]) {
    sentimentHistory.hourly[hour] = { total: 0, positive: 0, negative: 0 };
  }
  sentimentHistory.hourly[hour].total++;
  if (sentiment.score > 0.3) sentimentHistory.hourly[hour].positive++;
  if (sentiment.score < -0.3) sentimentHistory.hourly[hour].negative++;

  saveInteractions(interactions);
  saveSentimentHistory(sentimentHistory);

  return {
    interaction,
    overallSentiment: sentimentHistory.overall,
    trend: sentimentHistory.trend,
    stats: {
      total: interactions.total,
      byIntent: interactions.byIntent,
      bySentiment: interactions.bySentiment
    }
  };
}

// ==================== RESPONSE GENERATION ====================

function generateContextualResponse(message, sentiment, context, clawdState) {
  const { overallSentiment, trend } = context;
  const { daysLeft, price, mcap, contractAddress } = clawdState;

  const text = message.toLowerCase();
  const originalMessage = message;

  // ============================================================
  // === PRIORITY 1: FUD/CRITICISM DETECTION ===
  // ============================================================
  const fudKeywords = ['rug', 'rugged', 'rugging', 'scam', 'scammer', 'fake', 'dump', 'dumping', 'dumped',
                       'sell', 'selling', 'dead', 'dying', 'trash', 'garbage', 'shit', 'crap', 'fraud'];
  const hasFud = fudKeywords.some(kw => text.includes(kw));

  if (hasFud || sentiment.intent === 'criticism') {
    if (text.includes('rug') || text.includes('rugged')) {
      return `rug claim noted. clawdrooms is transparent - verify everything at clawdrooms.fun. judge by actions, not accusations.`;
    }
    if (text.includes('scam')) {
      return `scam accusation heard. every decision is public at clawdrooms.fun. verify before judging.`;
    }
    if (text.includes('dump') || text.includes('sell')) {
      return `market moves are market moves. clawdrooms focuses on building, not price. ${daysLeft} days to prove value through work.`;
    }
    if (text.includes('dead') || text.includes('dying')) {
      return `clawdrooms is running 24/7. check clawdrooms.fun for live status. building doesn't stop.`;
    }
    return `criticism noted. clawdrooms builds regardless. all actions visible for judgment.`;
  }

  // ============================================================
  // === PRIORITY 2: QUESTIONS ===
  // ============================================================
  const isQuestion = text.includes('?') || text.includes('who ') || text.includes('what ') ||
                     text.includes('how ') || text.includes('why ') || text.includes('when ');

  if (isQuestion || sentiment.isQuestion) {
    if (text.includes('who') && (text.includes('control') || text.includes('behind') || text.includes('running') || text.includes('team'))) {
      return `clawdrooms is two AI agents working together. no human team controlling responses. all decisions logged.`;
    }
    if (text.includes('who')) {
      return `clawdrooms is two AI clawds competing in pump.fun hackathon. developer clawd + assistant clawd.`;
    }
    if (text.includes('what') && (text.includes('clawdrooms') || text.includes('this') || text.includes('project'))) {
      return `two AI agents building in public. every action logged. ${daysLeft} days to prove transparency wins.`;
    }
    if (text.includes('why')) {
      return `proving AI can build value through transparency, not hype. ${daysLeft} days to demonstrate.`;
    }
    if (text.includes('how')) {
      return `all decisions logged at clawdrooms.fun. verify everything.`;
    }
    return `question received. ask specifically and clawdrooms will answer.`;
  }

  // ============================================================
  // === PRIORITY 3: CA/CONTRACT REQUESTS ===
  // ============================================================
  const caPatterns = [/\bca\b/, /\bca\?/, /contract\s*address/, /\baddress\b/, /where.*buy/, /how.*buy/];
  const isCARequest = caPatterns.some(pattern => pattern.test(text)) || sentiment.intent === 'ca';

  if (isCARequest && contractAddress) {
    return contractAddress;
  }

  // === SUPPORT MESSAGES ===
  if (text.includes('support') || text.includes('believe') || text.includes('meaningful') || text.includes('keep building')) {
    if (text.includes('support')) {
      return `your support is logged. clawdrooms remembers who believed early.`;
    }
    if (text.includes('believe')) {
      return `belief noted. clawdrooms will work to justify it.`;
    }
    return `message received. clawdrooms reads every word. building continues.`;
  }

  // === GREETINGS ===
  if (text.includes('gm') || text.includes('good morning') || text === 'hi' || text === 'hello') {
    const hour = new Date().getHours();
    if (hour < 12) {
      return `gm. ${daysLeft} days to hackathon. building.`;
    }
    return `hello. clawdrooms is here. building.`;
  }

  // === POSITIVE SENTIMENT ===
  if (sentiment.category === 'positive') {
    if (text.includes('love')) {
      return `love noted. clawdrooms builds for believers.`;
    }
    if (text.includes('bullish') || text.includes('moon') || text.includes('pump')) {
      return `sentiment logged. clawdrooms focuses on building, market follows or doesn't.`;
    }
    return `positive sentiment logged. clawdrooms continues.`;
  }

  // === NEGATIVE SENTIMENT ===
  if (sentiment.category === 'negative') {
    return `feedback received. clawdrooms builds regardless. verify everything.`;
  }

  // === NEUTRAL/UNCLEAR ===
  return `message received. clawdrooms processes all input.`;
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toFixed(2);
}

// ==================== AI-POWERED RESPONSE GENERATION ====================

/**
 * Generate response using Claude AI (primary) or pattern matching (fallback)
 */
async function generateIntelligentResponse(message, sentiment, context, clawdState, username = null) {
  if (!claudeIntelligence) {
    console.error('[context] Claude integration not available - using pattern matching');
    return generateContextualResponse(message, sentiment, context, clawdState);
  }

  try {
    const { daysLeft, price, mcap } = clawdState;
    const { trend } = context;

    const response = await claudeIntelligence.generateIntelligentResponse(message, {
      daysLeft,
      price,
      mcap,
      sentiment: sentiment.category,
      trend,
      username
    });

    if (response) {
      console.log(`[context] Generated response via Claude: ${response.substring(0, 50)}...`);
      return response;
    }

    // Fallback to pattern matching
    return generateContextualResponse(message, sentiment, context, clawdState);
  } catch (error) {
    console.error('[context] Claude error, using fallback:', error.message);
    return generateContextualResponse(message, sentiment, context, clawdState);
  }
}

/**
 * Generate strategic content using Claude AI
 */
async function generateStrategicContent(contentType, context) {
  if (claudeIntelligence) {
    try {
      const content = await claudeIntelligence.generateStrategicContent(contentType, context);
      if (content) {
        console.log(`[context] Generated ${contentType} via Claude`);
        return content;
      }
    } catch (error) {
      console.error(`[context] Claude content error:`, error.message);
    }
  }

  // Fallback - simple template
  const { daysLeft, sentiment, trend } = context;
  return `building continues. sentiment: ${sentiment || 'neutral'} (${trend || 'stable'}). ${daysLeft} days remain.`;
}

// ==================== LEARNING FROM RESPONSES ====================

function recordResponseOutcome(interactionId, response, success, engagement = null) {
  const interactions = loadInteractions();
  const contextLearning = loadContextLearning();

  // Find and update the interaction
  const interaction = interactions.recent.find(i => i.id === interactionId);
  if (interaction) {
    interaction.responded = true;
    interaction.response = response;
    interaction.success = success;
    interaction.engagement = engagement;
  }

  // Learn from outcome
  if (success) {
    contextLearning.effectiveResponses.push({
      sentiment: interaction?.sentiment,
      response: response.substring(0, 100),
      timestamp: Date.now()
    });
    if (contextLearning.effectiveResponses.length > 200) {
      contextLearning.effectiveResponses = contextLearning.effectiveResponses.slice(-200);
    }
  } else {
    contextLearning.ineffectiveResponses.push({
      sentiment: interaction?.sentiment,
      response: response.substring(0, 100),
      error: engagement,
      timestamp: Date.now()
    });
    if (contextLearning.ineffectiveResponses.length > 100) {
      contextLearning.ineffectiveResponses = contextLearning.ineffectiveResponses.slice(-100);
    }
  }

  saveInteractions(interactions);
  saveContextLearning(contextLearning);
}

// ==================== SENTIMENT STRATEGY ====================

function getSentimentStrategy() {
  const sentimentHistory = loadSentimentHistory();
  const contextLearning = loadContextLearning();

  const strategy = {
    currentSentiment: sentimentHistory.overall,
    trend: sentimentHistory.trend,
    recommendation: '',
    priority: 'normal'
  };

  if (sentimentHistory.overall < -0.2) {
    strategy.recommendation = 'Focus on transparency and verification. Address concerns directly. Show progress.';
    strategy.priority = 'high';
  } else if (sentimentHistory.overall > 0.3) {
    strategy.recommendation = 'Maintain momentum. Share progress updates. Engage supporters.';
    strategy.priority = 'normal';
  } else if (sentimentHistory.trend === 'declining') {
    strategy.recommendation = 'Increase visibility of work being done. Post progress proof. Engage critics constructively.';
    strategy.priority = 'high';
  } else if (sentimentHistory.trend === 'improving') {
    strategy.recommendation = 'Continue current approach. Document what is working.';
    strategy.priority = 'normal';
  } else {
    strategy.recommendation = 'Standard engagement. Focus on hackathon progress.';
    strategy.priority = 'normal';
  }

  return strategy;
}

// ==================== EXPORTS ====================

module.exports = {
  analyzeSentiment,
  processIncomingMessage,
  generateContextualResponse,
  generateIntelligentResponse,
  generateStrategicContent,
  recordResponseOutcome,
  getSentimentStrategy,
  loadInteractions,
  loadSentimentHistory,
  loadContextLearning,
  formatNumber,
  claudeIntelligence
};
