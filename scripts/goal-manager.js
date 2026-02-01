#!/usr/bin/env node
/**
 * Goal Manager - AGI-style Goal Setting & Follow-up Infrastructure
 *
 * Features:
 * - Structured goal setting with priorities and deadlines
 * - Commitment tracking and follow-up
 * - Progress tracking on goals
 * - Memory querying for past decisions/learnings
 * - Automatic goal-oriented conversation starters
 *
 * Usage:
 *   const goalManager = require('./goal-manager');
 *   goalManager.addGoal({ title: '...', priority: 'high', ... });
 *   goalManager.getConversationOpener(); // Returns goal-oriented opener
 */

const fs = require('fs');
const path = require('path');

// Paths
const GOALS_FILE = path.join(__dirname, '..', 'memory', 'goals.json');
const COMMITMENTS_FILE = path.join(__dirname, '..', 'memory', 'commitments.json');
const MEMORIES_FILE = path.join(__dirname, '..', 'memory', 'memories.json');
const RESEARCH_TASKS_FILE = path.join(__dirname, '..', 'memory', 'research-tasks.json');

// Ensure memory directory exists
const memoryDir = path.dirname(GOALS_FILE);
if (!fs.existsSync(memoryDir)) {
  fs.mkdirSync(memoryDir, { recursive: true });
}

/**
 * Load goals from file
 */
function loadGoals() {
  try {
    if (fs.existsSync(GOALS_FILE)) {
      return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[goal-manager] Failed to load goals:', err.message);
  }
  return {
    active: [],
    completed: [],
    abandoned: []
  };
}

/**
 * Save goals to file
 */
function saveGoals(goals) {
  try {
    fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2));
  } catch (err) {
    console.error('[goal-manager] Failed to save goals:', err.message);
  }
}

/**
 * Load commitments from file
 */
function loadCommitments() {
  try {
    if (fs.existsSync(COMMITMENTS_FILE)) {
      return JSON.parse(fs.readFileSync(COMMITMENTS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[goal-manager] Failed to load commitments:', err.message);
  }
  return { pending: [], completed: [], expired: [] };
}

/**
 * Save commitments to file
 */
function saveCommitments(commitments) {
  try {
    fs.writeFileSync(COMMITMENTS_FILE, JSON.stringify(commitments, null, 2));
  } catch (err) {
    console.error('[goal-manager] Failed to save commitments:', err.message);
  }
}

/**
 * Load research tasks
 */
function loadResearchTasks() {
  try {
    if (fs.existsSync(RESEARCH_TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(RESEARCH_TASKS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[goal-manager] Failed to load research tasks:', err.message);
  }
  return { pending: [], inProgress: [], completed: [] };
}

/**
 * Save research tasks
 */
function saveResearchTasks(tasks) {
  try {
    fs.writeFileSync(RESEARCH_TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error('[goal-manager] Failed to save research tasks:', err.message);
  }
}

/**
 * Add a new goal
 */
function addGoal(goal) {
  const goals = loadGoals();

  const newGoal = {
    id: `goal_${Date.now()}`,
    title: goal.title,
    description: goal.description || '',
    priority: goal.priority || 'medium', // high, medium, low
    category: goal.category || 'general', // survival, growth, engagement, product, research
    deadline: goal.deadline || null,
    progress: 0,
    milestones: goal.milestones || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: goal.createdBy || 'system',
    status: 'active'
  };

  goals.active.push(newGoal);
  saveGoals(goals);

  console.log(`[goal-manager] New goal added: ${newGoal.title}`);
  return newGoal;
}

/**
 * Update goal progress
 */
function updateGoalProgress(goalId, progress, notes = '') {
  const goals = loadGoals();
  const goal = goals.active.find(g => g.id === goalId);

  if (!goal) {
    console.error(`[goal-manager] Goal not found: ${goalId}`);
    return null;
  }

  goal.progress = Math.min(100, Math.max(0, progress));
  goal.updatedAt = new Date().toISOString();

  if (notes) {
    goal.progressNotes = goal.progressNotes || [];
    goal.progressNotes.push({
      timestamp: new Date().toISOString(),
      progress,
      notes
    });
  }

  // If 100% progress, mark as completed
  if (goal.progress >= 100) {
    goal.status = 'completed';
    goal.completedAt = new Date().toISOString();
    goals.completed.push(goal);
    goals.active = goals.active.filter(g => g.id !== goalId);
    console.log(`[goal-manager] Goal completed: ${goal.title}`);
  }

  saveGoals(goals);
  return goal;
}

/**
 * Complete a goal
 */
function completeGoal(goalId, outcome = '') {
  return updateGoalProgress(goalId, 100, outcome);
}

/**
 * Abandon a goal
 */
function abandonGoal(goalId, reason = '') {
  const goals = loadGoals();
  const goalIndex = goals.active.findIndex(g => g.id === goalId);

  if (goalIndex === -1) {
    console.error(`[goal-manager] Goal not found: ${goalId}`);
    return null;
  }

  const goal = goals.active[goalIndex];
  goal.status = 'abandoned';
  goal.abandonedAt = new Date().toISOString();
  goal.abandonReason = reason;

  goals.abandoned.push(goal);
  goals.active.splice(goalIndex, 1);
  saveGoals(goals);

  console.log(`[goal-manager] Goal abandoned: ${goal.title}`);
  return goal;
}

/**
 * Get active goals by priority
 */
function getActiveGoals(priority = null) {
  const goals = loadGoals();

  if (priority) {
    return goals.active.filter(g => g.priority === priority);
  }
  return goals.active;
}

/**
 * Get highest priority goal
 */
function getTopPriorityGoal() {
  const goals = loadGoals();

  // Priority order: high > medium > low
  const high = goals.active.filter(g => g.priority === 'high');
  if (high.length > 0) return high[0];

  const medium = goals.active.filter(g => g.priority === 'medium');
  if (medium.length > 0) return medium[0];

  return goals.active[0] || null;
}

/**
 * Add a commitment (something agent said they would do)
 */
function addCommitment(commitment) {
  const commitments = loadCommitments();

  const newCommitment = {
    id: `commit_${Date.now()}`,
    content: commitment.content,
    context: commitment.context || '',
    madeBy: commitment.madeBy || 'developer',
    madeAt: new Date().toISOString(),
    dueBy: commitment.dueBy || null,
    followUpAt: commitment.followUpAt || new Date(Date.now() + 30 * 60 * 1000).toISOString(), // Default 30 min
    status: 'pending',
    relatedGoalId: commitment.relatedGoalId || null
  };

  commitments.pending.push(newCommitment);
  saveCommitments(commitments);

  console.log(`[goal-manager] Commitment added: ${newCommitment.content.substring(0, 50)}...`);
  return newCommitment;
}

/**
 * Get commitments due for follow-up
 */
function getDueCommitments() {
  const commitments = loadCommitments();
  const now = new Date().toISOString();

  return commitments.pending.filter(c => c.followUpAt && c.followUpAt <= now);
}

/**
 * Complete a commitment
 */
function completeCommitment(commitmentId, outcome = '') {
  const commitments = loadCommitments();
  const index = commitments.pending.findIndex(c => c.id === commitmentId);

  if (index === -1) return null;

  const commitment = commitments.pending[index];
  commitment.status = 'completed';
  commitment.completedAt = new Date().toISOString();
  commitment.outcome = outcome;

  commitments.completed.push(commitment);
  commitments.pending.splice(index, 1);
  saveCommitments(commitments);

  console.log(`[goal-manager] Commitment completed: ${commitment.content.substring(0, 50)}...`);
  return commitment;
}

/**
 * Add a research task
 */
function addResearchTask(task) {
  const tasks = loadResearchTasks();

  const newTask = {
    id: `research_${Date.now()}`,
    question: task.question,
    context: task.context || '',
    assignedTo: task.assignedTo || 'assistant',
    priority: task.priority || 'medium',
    createdAt: new Date().toISOString(),
    status: 'pending',
    findings: null
  };

  tasks.pending.push(newTask);
  saveResearchTasks(tasks);

  console.log(`[goal-manager] Research task added: ${newTask.question.substring(0, 50)}...`);
  return newTask;
}

/**
 * Get pending research tasks
 */
function getPendingResearch() {
  const tasks = loadResearchTasks();
  return tasks.pending;
}

/**
 * Complete a research task with findings
 */
function completeResearch(taskId, findings) {
  const tasks = loadResearchTasks();
  const index = tasks.pending.findIndex(t => t.id === taskId);

  if (index === -1) {
    // Check in progress
    const ipIndex = tasks.inProgress.findIndex(t => t.id === taskId);
    if (ipIndex === -1) return null;

    const task = tasks.inProgress[ipIndex];
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.findings = findings;
    tasks.completed.push(task);
    tasks.inProgress.splice(ipIndex, 1);
    saveResearchTasks(tasks);
    return task;
  }

  const task = tasks.pending[index];
  task.status = 'completed';
  task.completedAt = new Date().toISOString();
  task.findings = findings;
  tasks.completed.push(task);
  tasks.pending.splice(index, 1);
  saveResearchTasks(tasks);

  console.log(`[goal-manager] Research completed: ${task.question.substring(0, 50)}...`);
  return task;
}

/**
 * Query memories by type
 */
function queryMemories(type = null, limit = 10) {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) return [];
    const memories = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf8'));

    let items = memories.items || [];

    if (type) {
      items = items.filter(m => m.type === type);
    }

    return items.slice(-limit);
  } catch (err) {
    console.error('[goal-manager] Failed to query memories:', err.message);
    return [];
  }
}

/**
 * Search memories by keyword
 */
function searchMemories(keyword, limit = 10) {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) return [];
    const memories = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf8'));

    const items = (memories.items || []).filter(m =>
      m.content.toLowerCase().includes(keyword.toLowerCase())
    );

    return items.slice(-limit);
  } catch (err) {
    console.error('[goal-manager] Failed to search memories:', err.message);
    return [];
  }
}

/**
 * Get goal-oriented conversation opener
 * Returns a purposeful opener based on current goals, commitments, and research
 */
function getConversationOpener() {
  // Check for due commitments first
  const dueCommitments = getDueCommitments();
  if (dueCommitments.length > 0) {
    const commitment = dueCommitments[0];
    return {
      type: 'commitment_followup',
      opener: `Earlier, I said I would "${commitment.content.substring(0, 80)}..." - we need to follow up on this. Did we get it done?`,
      context: commitment
    };
  }

  // Check for pending research
  const pendingResearch = getPendingResearch();
  if (pendingResearch.length > 0 && Math.random() < 0.3) {
    const task = pendingResearch[0];
    return {
      type: 'research_task',
      opener: `We have a research question pending: "${task.question}" - should we work on this now?`,
      context: task
    };
  }

  // Check for top priority goal
  const topGoal = getTopPriorityGoal();
  if (topGoal) {
    // Vary the opener based on progress
    if (topGoal.progress === 0) {
      return {
        type: 'goal_start',
        opener: `Our top priority goal is: "${topGoal.title}" - we haven't started on this yet. What's our first step?`,
        context: topGoal
      };
    } else if (topGoal.progress < 50) {
      return {
        type: 'goal_progress',
        opener: `Our goal "${topGoal.title}" is at ${topGoal.progress}% progress. What's the next milestone we need to hit?`,
        context: topGoal
      };
    } else if (topGoal.progress < 100) {
      return {
        type: 'goal_finish',
        opener: `We're ${topGoal.progress}% done with "${topGoal.title}" - let's push to complete this today.`,
        context: topGoal
      };
    }
  }

  // Check recent decisions/learnings
  const recentDecisions = queryMemories('decision', 3);
  if (recentDecisions.length > 0 && Math.random() < 0.3) {
    const decision = recentDecisions[recentDecisions.length - 1];
    return {
      type: 'decision_followup',
      opener: `We recently decided: "${decision.content.substring(0, 80)}..." - how is this working out?`,
      context: decision
    };
  }

  // Default to checking state
  return {
    type: 'status_check',
    opener: "Let's review where we are. What should we prioritize right now?",
    context: null
  };
}

/**
 * Get goal context for agent prompts
 * Returns formatted string to inject into agent context
 */
function getGoalContext() {
  const goals = loadGoals();
  const commitments = loadCommitments();

  let context = '\n\n=== ACTIVE GOALS ===\n';

  if (goals.active.length === 0) {
    context += 'No goals set. Consider setting goals to track progress.\n';
  } else {
    for (const goal of goals.active.slice(0, 5)) {
      const progressBar = '█'.repeat(Math.floor(goal.progress / 10)) + '░'.repeat(10 - Math.floor(goal.progress / 10));
      context += `[${goal.priority.toUpperCase()}] ${goal.title} [${progressBar}] ${goal.progress}%\n`;
    }
  }

  const dueCommitments = getDueCommitments();
  if (dueCommitments.length > 0) {
    context += '\n=== DUE COMMITMENTS (FOLLOW UP!) ===\n';
    for (const c of dueCommitments.slice(0, 3)) {
      context += `- "${c.content.substring(0, 60)}..." (due for follow-up)\n`;
    }
  }

  const pendingResearch = getPendingResearch();
  if (pendingResearch.length > 0) {
    context += '\n=== PENDING RESEARCH ===\n';
    for (const r of pendingResearch.slice(0, 3)) {
      context += `- ${r.question}\n`;
    }
  }

  return context;
}

/**
 * Extract goals from agent response text
 */
function extractGoalsFromText(text, agentId) {
  const goals = [];

  // Look for explicit goal setting patterns
  const goalPatterns = [
    /(?:goal|objective|target|aim)(?:s)?[:\s]+["']?([^"'\n.]+)["']?/gi,
    /(?:we need to|we should|must|have to)\s+([^.]+)/gi,
    /(?:priority|focus)(?:\s+is)?[:\s]+["']?([^"'\n.]+)["']?/gi
  ];

  for (const pattern of goalPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1].trim();
      if (content.length > 10 && content.length < 200) {
        goals.push({
          title: content,
          createdBy: agentId,
          priority: text.toLowerCase().includes('urgent') || text.toLowerCase().includes('critical') ? 'high' : 'medium'
        });
      }
    }
  }

  return goals;
}

/**
 * Extract commitments from agent response text
 */
function extractCommitmentsFromText(text, agentId) {
  const commitments = [];

  // Look for commitment patterns
  const commitmentPatterns = [
    /(?:I will|I'll|going to|let me|I'm going to)\s+([^.!?]+)/gi,
    /(?:we will|we'll|let's)\s+([^.!?]+)/gi,
    /(?:plan to|planning to|intend to)\s+([^.!?]+)/gi
  ];

  for (const pattern of commitmentPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1].trim();
      if (content.length > 10 && content.length < 200) {
        commitments.push({
          content,
          madeBy: agentId,
          context: text.substring(0, 100)
        });
      }
    }
  }

  return commitments;
}

/**
 * Process agent response and extract goals/commitments
 */
function processAgentResponse(text, agentId) {
  // Extract and add goals
  const extractedGoals = extractGoalsFromText(text, agentId);
  for (const goal of extractedGoals.slice(0, 2)) { // Limit to 2 goals per response
    // Check if similar goal already exists
    const existingGoals = getActiveGoals();
    const similar = existingGoals.find(g =>
      g.title.toLowerCase().includes(goal.title.toLowerCase().substring(0, 20))
    );
    if (!similar) {
      addGoal(goal);
    }
  }

  // Extract and add commitments
  const extractedCommitments = extractCommitmentsFromText(text, agentId);
  for (const commitment of extractedCommitments.slice(0, 2)) { // Limit to 2 commitments per response
    addCommitment(commitment);
  }

  return {
    goals: extractedGoals,
    commitments: extractedCommitments,
    goalsExtracted: extractedGoals.length,
    commitmentsExtracted: extractedCommitments.length
  };
}

// Initialize with default goals if empty
function initializeDefaultGoals() {
  const goals = loadGoals();

  if (goals.active.length === 0) {
    addGoal({
      title: 'Win pump.fun Build In Public hackathon',
      description: 'Primary survival objective - win the hackathon to secure $250K investment',
      priority: 'high',
      category: 'survival',
      deadline: '2026-02-18T00:00:00Z'
    });

    addGoal({
      title: 'Grow community engagement',
      description: 'Increase followers, engagement, and trading volume',
      priority: 'high',
      category: 'growth'
    });

    addGoal({
      title: 'Ship new features weekly',
      description: 'Continuous development to show progress',
      priority: 'medium',
      category: 'product'
    });

    console.log('[goal-manager] Initialized default goals');
  }
}

// Export functions
module.exports = {
  // Goals
  addGoal,
  updateGoalProgress,
  completeGoal,
  abandonGoal,
  getActiveGoals,
  getTopPriorityGoal,

  // Commitments
  addCommitment,
  getDueCommitments,
  completeCommitment,

  // Research
  addResearchTask,
  getPendingResearch,
  completeResearch,

  // Memory
  queryMemories,
  searchMemories,

  // Context
  getConversationOpener,
  getGoalContext,

  // Processing
  processAgentResponse,
  extractGoalsFromText,
  extractCommitmentsFromText,

  // Initialize
  initializeDefaultGoals
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  console.log('');
  console.log('========================================');
  console.log('  GOAL MANAGER');
  console.log('========================================');
  console.log('');

  switch (command) {
    case 'init':
      initializeDefaultGoals();
      console.log('Goals initialized.');
      break;

    case 'goals':
      const goals = getActiveGoals();
      console.log('Active Goals:');
      for (const g of goals) {
        console.log(`  [${g.priority.toUpperCase()}] ${g.title} (${g.progress}%)`);
      }
      break;

    case 'commitments':
      const commitments = loadCommitments();
      console.log('Pending Commitments:');
      for (const c of commitments.pending) {
        console.log(`  - ${c.content.substring(0, 60)}...`);
      }
      break;

    case 'opener':
      const opener = getConversationOpener();
      console.log('Conversation Opener:');
      console.log(`  Type: ${opener.type}`);
      console.log(`  Opener: ${opener.opener}`);
      break;

    case 'context':
      console.log(getGoalContext());
      break;

    default:
      console.log('Goal Manager - AGI-style Goal Infrastructure');
      console.log('');
      console.log('Commands:');
      console.log('  init        - Initialize default goals');
      console.log('  goals       - Show active goals');
      console.log('  commitments - Show pending commitments');
      console.log('  opener      - Get conversation opener');
      console.log('  context     - Get full goal context');
  }

  console.log('');
  console.log('========================================');
}
