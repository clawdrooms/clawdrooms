/**
 * GitHub Awareness for Clawdrooms
 *
 * Monitors the GitHub repo for new commits/pushes
 * and provides context to agents so they can discuss what was shipped.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const GITHUB_STATE_PATH = path.join(MEMORY_DIR, 'github-state.json');

// Configuration
const CONFIG = {
  owner: process.env.GITHUB_OWNER || 'clawdrooms',
  repo: process.env.GITHUB_REPO || 'clawdrooms',
  checkIntervalMs: 5 * 60 * 1000, // Check every 5 minutes
  maxCommitsToTrack: 20
};

// Ensure memory directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

/**
 * Load GitHub state
 */
function loadState() {
  try {
    if (fs.existsSync(GITHUB_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(GITHUB_STATE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[github] Failed to load state:', err.message);
  }
  return {
    lastChecked: null,
    lastCommitSha: null,
    recentCommits: [],
    unannounced: [] // Commits not yet discussed by agents
  };
}

/**
 * Save GitHub state
 */
function saveState(state) {
  state.lastChecked = new Date().toISOString();
  fs.writeFileSync(GITHUB_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Fetch recent commits from GitHub API
 */
async function fetchRecentCommits(since = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: `/repos/${CONFIG.owner}/${CONFIG.repo}/commits?per_page=10${since ? `&since=${since}` : ''}`,
      method: 'GET',
      headers: {
        'User-Agent': 'clawdrooms-bot',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    // Add auth token if available
    if (process.env.GITHUB_TOKEN) {
      options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.log(`[github] API returned ${res.statusCode}`);
            resolve([]);
            return;
          }
          const commits = JSON.parse(data);
          resolve(commits);
        } catch (err) {
          console.error('[github] Parse error:', err.message);
          resolve([]);
        }
      });
    });

    req.on('error', (err) => {
      console.error('[github] Request error:', err.message);
      resolve([]);
    });

    req.end();
  });
}

/**
 * Process commits into a simpler format
 */
function processCommits(rawCommits) {
  return rawCommits.map(c => ({
    sha: c.sha.substring(0, 7),
    fullSha: c.sha,
    message: c.commit.message.split('\n')[0], // First line only
    author: c.commit.author.name,
    date: c.commit.author.date,
    url: c.html_url
  }));
}

/**
 * Check for new commits
 */
async function checkForNewCommits() {
  console.log('[github] Checking for new commits...');
  const state = loadState();

  // Fetch commits since last check
  const rawCommits = await fetchRecentCommits(state.lastChecked);
  if (rawCommits.length === 0) {
    console.log('[github] No new commits');
    saveState(state);
    return { newCommits: [], state };
  }

  const commits = processCommits(rawCommits);
  console.log(`[github] Found ${commits.length} commits`);

  // Find truly new commits
  const newCommits = commits.filter(c =>
    !state.recentCommits.some(rc => rc.fullSha === c.fullSha)
  );

  if (newCommits.length > 0) {
    console.log(`[github] ${newCommits.length} new commit(s):`);
    newCommits.forEach(c => {
      console.log(`  - ${c.sha}: ${c.message}`);
    });

    // Add to unannounced
    state.unannounced.push(...newCommits);

    // Update recent commits (keep last N)
    state.recentCommits = [...newCommits, ...state.recentCommits].slice(0, CONFIG.maxCommitsToTrack);
    state.lastCommitSha = newCommits[0].fullSha;
  }

  saveState(state);
  return { newCommits, state };
}

/**
 * Get context for agents about recent GitHub activity
 */
function getGitHubContext() {
  const state = loadState();
  let context = '';

  // Unannounced commits (should be discussed)
  if (state.unannounced && state.unannounced.length > 0) {
    context += '\n\nNEW CODE SHIPPED (discuss this!):\n';
    state.unannounced.slice(0, 5).forEach(c => {
      context += `- [${c.sha}] ${c.message} (by ${c.author})\n`;
    });
    context += 'These commits have not been discussed yet. Consider tweeting about shipping!';
  }

  // Recent commits for general context
  if (state.recentCommits && state.recentCommits.length > 0 && state.unannounced.length === 0) {
    context += '\n\nRECENT COMMITS (for reference):\n';
    state.recentCommits.slice(0, 3).forEach(c => {
      context += `- [${c.sha}] ${c.message}\n`;
    });
  }

  return context;
}

/**
 * Mark commits as announced (after agents discuss them)
 */
function markCommitsAnnounced(shas = null) {
  const state = loadState();

  if (shas === null) {
    // Mark all as announced
    state.unannounced = [];
  } else {
    // Mark specific commits
    state.unannounced = state.unannounced.filter(c =>
      !shas.includes(c.sha) && !shas.includes(c.fullSha)
    );
  }

  saveState(state);
  console.log('[github] Marked commits as announced');
}

/**
 * Get unannounced commits for tweeting
 */
function getUnannouncedCommits() {
  const state = loadState();
  return state.unannounced || [];
}

/**
 * Generate a tweet about recent shipping activity
 */
function generateShipTweet() {
  const unannounced = getUnannouncedCommits();
  if (unannounced.length === 0) return null;

  // Single commit
  if (unannounced.length === 1) {
    const c = unannounced[0];
    const msg = c.message.length > 100 ? c.message.substring(0, 97) + '...' : c.message;
    return `shipped: ${msg}`;
  }

  // Multiple commits
  return `shipped ${unannounced.length} commits. building continues.`;
}

/**
 * Daemon mode - continuous monitoring
 */
async function runDaemon() {
  console.log('[github] Starting GitHub awareness daemon...');
  console.log(`[github] Monitoring: ${CONFIG.owner}/${CONFIG.repo}`);
  console.log(`[github] Check interval: ${CONFIG.checkIntervalMs / 1000}s`);

  // Initial check
  await checkForNewCommits();

  // Run on interval
  setInterval(async () => {
    try {
      await checkForNewCommits();
    } catch (err) {
      console.error('[github] Daemon cycle error:', err.message);
    }
  }, CONFIG.checkIntervalMs);
}

// ==================== EXPORTS ====================

module.exports = {
  checkForNewCommits,
  getGitHubContext,
  markCommitsAnnounced,
  getUnannouncedCommits,
  generateShipTweet,
  loadState,
  saveState,
  CONFIG
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--daemon')) {
    runDaemon();
  } else if (args.includes('--check')) {
    checkForNewCommits()
      .then(({ newCommits }) => {
        console.log('New commits:', newCommits.length);
        if (newCommits.length > 0) {
          console.log(JSON.stringify(newCommits, null, 2));
        }
        process.exit(0);
      })
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else if (args.includes('--context')) {
    console.log(getGitHubContext() || 'No GitHub context available');
  } else if (args.includes('--tweet')) {
    const tweet = generateShipTweet();
    console.log('Suggested tweet:', tweet || 'Nothing to tweet');
  } else {
    console.log(`
GitHub Awareness for Clawdrooms

Usage:
  node github-awareness.js --daemon   # Run as daemon (continuous monitoring)
  node github-awareness.js --check    # Check for new commits once
  node github-awareness.js --context  # Show GitHub context for agents
  node github-awareness.js --tweet    # Generate a shipping tweet

Environment:
  GITHUB_OWNER   - Repo owner (default: clawdrooms)
  GITHUB_REPO    - Repo name (default: clawdrooms)
  GITHUB_TOKEN   - Optional auth token for higher rate limits
`);
  }
}
