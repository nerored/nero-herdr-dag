import { clean } from './text.mjs';

export const CYCLE_MS = 160_000;

const NODES = [
  {
    id: 'intake', label: 'intake', taskId: 'st_intake', start: 0, duration: 6_000,
    agent: 'scout', model: 'acme/orion-reasoner',
    description: 'Collect requirements and map the workflow surface',
    activity: ['reading workflow brief', 'extracting constraints', 'mapping edge cases'],
    logs: ['reading workflow brief', 'resolved 11 dependency edges', 'constraints written to .omo/plan.md'],
    inRate: 90, outRate: 22, baseIn: 800, baseOut: 180, phase: 'thinking',
  },
  {
    id: 'scaffold', label: 'scaffold', taskId: 'st_scaffold', start: 6_000, duration: 12_000,
    agent: 'forge', model: 'acme/atlas-code',
    description: 'Create the package skeleton and test harness',
    activity: ['creating package skeleton', 'writing config loader', 'linking test harness'],
    logs: ['created package.json', 'wired node --test', 'installed no runtime dependencies'],
    inRate: 140, outRate: 38, baseIn: 1800, baseOut: 420, phase: 'text',
  },
  {
    id: 'api', label: 'build-api', taskId: 'st_api', start: 18_000, duration: 52_000,
    agent: 'forge', model: 'acme/atlas-code',
    description: 'Implement the HTTP API and its validation layer',
    activity: ['editing src/api/routes.ts', 'running typecheck', 'writing handler tests', 'polishing error envelopes'],
    logs: ['reading src/api/schema.ts', 'added POST /runs', 'typecheck clean', 'added 14 handler tests'],
    inRate: 190, outRate: 44, baseIn: 2400, baseOut: 600, phase: 'text', children: true,
  },
  {
    id: 'ui', label: 'build-ui', taskId: 'st_ui', start: 18_000, duration: 57_000,
    agent: 'canvas', model: 'acme/muse-ui',
    description: 'Build the animated workflow canvas and panel system',
    activity: ['rendering workflow canvas', 'tuning panel layout', 'adding edge flow motion', 'checking narrow widths'],
    logs: ['created canvas cell model', 'added truecolor fallback', 'layout passes at 70 columns'],
    inRate: 165, outRate: 51, baseIn: 2100, baseOut: 520, phase: 'text',
  },
  {
    id: 'security', label: 'security-review', taskId: 'st_security', start: 18_000, duration: 22_000,
    agent: 'sentinel', model: 'acme/guard-2',
    description: 'Audit shell quoting, redaction, and path handling',
    activity: ['auditing shell quoting', 'checking secret redaction', 'reviewing path joins'],
    logs: ['reviewed herdr quoting', 'verified 0600 snapshot mode', 'no prompt fields persisted'],
    inRate: 120, outRate: 26, baseIn: 1500, baseOut: 310, phase: 'thinking',
  },
  {
    id: 'tests', label: 'test-coverage', taskId: 'st_tests', start: 70_000, duration: 18_000,
    agent: 'probe', model: 'acme/orion-reasoner',
    description: 'Run the full suite and close coverage gaps',
    activity: ['running test suite (312/480)', 'collecting coverage', 'triaging one slow case'],
    logs: ['started node --test', 'coverage 87.4%', 'no flaky failures yet'],
    inRate: 150, outRate: 34, baseIn: 2000, baseOut: 430, phase: 'tool', tool: 'pytest', children: true,
  },
  {
    id: 'docs', label: 'write-docs', taskId: 'st_docs', start: 75_000, duration: 23_000,
    agent: 'scribe', model: 'acme/quill-1',
    description: 'Document the demo, install path, and key bindings',
    activity: ['writing README section', 'adding screenshots', 'checking CLI examples'],
    logs: ['drafted demo section', 'documented v2 snapshot', 'spellcheck clean'],
    inRate: 110, outRate: 42, baseIn: 1300, baseOut: 380, phase: 'text', children: true,
  },
  {
    id: 'gate', label: 'verify-evidence', taskId: 'st_gate', start: 98_000, duration: 20_000,
    agent: 'judge', model: 'acme/judge-3',
    description: 'Cross-check every acceptance criterion against evidence',
    activity: ['checking evidence matrix', 'replaying key sequences', 'signing the gate'],
    logs: ['loaded acceptance matrix', 'all 7 criteria mapped', 'gate evidence attached'],
    inRate: 135, outRate: 30, baseIn: 1700, baseOut: 350, phase: 'waiting',
  },
  {
    id: 'release', label: 'release', taskId: 'st_release', start: 118_000, duration: 20_000,
    agent: 'runner', model: 'acme/ship-1',
    description: 'Package the build and publish the release artifact',
    activity: ['packing artifacts', 'writing changelog', 'publishing 0.1.0'],
    logs: ['bun pm pack complete', 'artifact checksum recorded', 'release notes generated'],
    inRate: 95, outRate: 28, baseIn: 900, baseOut: 210, phase: 'tool', tool: 'tar',
  },
];

const EDGES = [
  ['intake', 'scaffold'],
  ['scaffold', 'api'],
  ['scaffold', 'ui'],
  ['scaffold', 'security'],
  ['api', 'tests'],
  ['api', 'docs'],
  ['ui', 'docs'],
  ['tests', 'gate'],
  ['security', 'gate'],
  ['docs', 'gate'],
  ['gate', 'release'],
];

const INCOMING = new Map();
for (const [from, to] of EDGES) {
  if (!INCOMING.has(to)) INCOMING.set(to, []);
  INCOMING.get(to).push(from);
}

const BY_ID = new Map(NODES.map(node => [node.id, node]));

function logTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function stateAt(id, phase, memo) {
  if (memo.has(id)) return memo.get(id);
  const spec = BY_ID.get(id);
  const dependencies = (INCOMING.get(id) ?? []).map(dep => stateAt(dep, phase, memo));
  const ready = dependencies.every(state => state === 'completed');
  let state;
  if (phase >= spec.start + spec.duration) state = 'completed';
  else if (phase >= spec.start && ready) state = 'running';
  else if (ready) state = 'pending';
  else state = 'blocked';
  memo.set(id, state);
  return state;
}

function childStatus(percent, threshold, completedAtThreshold) {
  if (percent >= completedAtThreshold) return 'completed';
  if (percent >= threshold) return 'running';
  return 'pending';
}

function childrenFor(id, percent, state) {
  if (state === 'completed') {
    if (id === 'api') return [
      { id: 'st_api_lint', description: 'lint changed files', status: 'completed', percent: 100, agent: 'forge', model: 'acme/atlas-code' },
      { id: 'st_api_types', description: 'typecheck api', status: 'completed', percent: 100, agent: 'forge', model: 'acme/atlas-code' },
      { id: 'st_api_tests', description: 'handler tests', status: 'completed', percent: 100, agent: 'probe', model: 'acme/orion-reasoner' },
    ];
    if (id === 'tests') return [
      { id: 'st_tests_unit', description: 'unit suite', status: 'completed', percent: 100, agent: 'probe', model: 'acme/orion-reasoner' },
      { id: 'st_tests_cov', description: 'coverage report', status: 'completed', percent: 100, agent: 'probe', model: 'acme/orion-reasoner' },
    ];
    if (id === 'docs') return [
      { id: 'st_docs_spell', description: 'spellcheck docs', status: 'completed', percent: 100, agent: 'scribe', model: 'acme/quill-1' },
    ];
  }
  if (id === 'api') return [
    { id: 'st_api_lint', description: 'lint changed files', status: childStatus(percent, 25, 35), percent: percent >= 35 ? 100 : percent, agent: 'forge', model: 'acme/atlas-code' },
    { id: 'st_api_types', description: 'typecheck api', status: childStatus(percent, 50, 65), percent: percent >= 65 ? 100 : Math.max(0, percent - 25), agent: 'forge', model: 'acme/atlas-code' },
    { id: 'st_api_tests', description: 'handler tests', status: childStatus(percent, 70, 90), percent: percent >= 90 ? 100 : Math.max(0, percent - 65), agent: 'probe', model: 'acme/orion-reasoner' },
  ];
  if (id === 'tests') return [
    { id: 'st_tests_unit', description: 'unit suite', status: childStatus(percent, 20, 70), percent, agent: 'probe', model: 'acme/orion-reasoner' },
    { id: 'st_tests_cov', description: 'coverage report', status: childStatus(percent, 60, 95), percent, agent: 'probe', model: 'acme/orion-reasoner' },
  ];
  if (id === 'docs') return [
    { id: 'st_docs_spell', description: 'spellcheck docs', status: childStatus(percent, 40, 80), percent, agent: 'scribe', model: 'acme/quill-1' },
  ];
  return undefined;
}

function activityFor(spec, percent, state, now, startAt) {
  if (state !== 'running') return undefined;
  const bucket = Math.min(spec.activity.length - 1, Math.floor(percent / (100 / spec.activity.length)));
  const text = clean(spec.activity[bucket]);
  const since = startAt + (bucket / spec.activity.length) * spec.duration;
  const lastAt = now - ((Math.floor(now / 700) % 3) * 240 + 120);
  const base = { phase: spec.phase, since, lastAt };
  if (spec.phase === 'tool') return { ...base, tool: spec.tool, text };
  if (spec.phase === 'waiting') return base;
  return { ...base, text };
}

function tokenRate(spec, now, seed) {
  const values = [];
  for (let index = 0; index < 24; index++) {
    const wave = Math.sin(now / 2200 + index * 0.57 + seed) * 0.42;
    const noise = ((index * 13 + seed * 7) % 9) - 4;
    values.push(Math.max(1, Math.round(spec.inRate * (0.72 + wave) + noise)));
  }
  return values;
}

function nodeTask(spec, state, percent, now, cycleStart, completedAt) {
  const startAt = cycleStart + spec.start;
  const activeSeconds = state === 'completed' ? spec.duration / 1000 :
    state === 'running' ? Math.max(0, (now - startAt) / 1000) : 0;
  const status = state === 'running' ? 'running' : state === 'completed' ? 'completed' : 'pending';
  // A blocked node is not started, so it must not report work it never did.
  const started = status !== 'pending';
  const activity = activityFor(spec, percent, state, now, startAt);
  const logs = state === 'running' || state === 'completed'
    ? spec.logs.map((line, index) => `[${logTime((index + 1) * (spec.duration / (spec.logs.length + 2)))}] ${line}`)
    : [];
  if (state === 'running') logs.push(`[${logTime(Math.max(0, now - startAt))}] ${clean(spec.activity[Math.min(spec.activity.length - 1, Math.floor(percent / 100 * spec.activity.length))])}`);
  const rate = state === 'running' ? tokenRate(spec, now, spec.start / 1000) : undefined;
  const task = {
    id: spec.taskId,
    description: spec.description,
    agent: spec.agent,
    model: spec.model,
    status,
    percent: Math.round(percent),
    tokensIn: started ? Math.round(spec.baseIn + spec.inRate * activeSeconds) : undefined,
    tokensOut: started ? Math.round(spec.baseOut + spec.outRate * activeSeconds) : undefined,
    turns: started ? Math.max(1, Math.floor(activeSeconds / 7) + 1) : 0,
    toolCalls: started ? Math.max(1, Math.floor(activeSeconds / 2.8) + 1) : 0,
    retries: spec.id === 'tests' && percent > 55 ? 1 : 0,
    startedAt: started ? new Date(startAt).toISOString() : undefined,
    completedAt: state === 'completed' ? new Date(completedAt).toISOString() : undefined,
    activity,
    logs: logs.length ? logs : undefined,
    children: childrenFor(spec.id, percent, state),
    tokenRate: rate,
    progress: state === 'running' ? clean(spec.activity[Math.min(spec.activity.length - 1, Math.floor(percent / 100 * spec.activity.length))]) : undefined,
  };
  return Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined));
}

function activeRun(now, cycleStart, phase) {
  const memo = new Map();
  const nodes = NODES.map(spec => {
    const state = stateAt(spec.id, phase, memo);
    const percent = state === 'completed' ? 100 : state === 'running'
      ? Math.max(2, Math.min(99, ((phase - spec.start) / spec.duration) * 100)) : 0;
    const completedAt = cycleStart + spec.start + spec.duration;
    const node = {
      id: spec.id,
      label: spec.label,
      state,
      attempt: spec.id === 'tests' && percent > 55 ? 2 : 1,
      taskId: spec.taskId,
      percent: Math.round(percent),
      error: undefined,
    };
    return { node, task: nodeTask(spec, state, percent, now, cycleStart, completedAt) };
  });
  // The run is complete only when every node is. Deriving it from the node
  // states keeps the run status correct if a node window changes.
  const runStatus = nodes.every(item => item.node.state === 'completed') ? 'completed' : 'running';
  return {
    run: {
      id: 'run_integration',
      name: 'integration review',
      status: runStatus,
      createdAt: new Date(cycleStart - 30_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      nodes: nodes.map(item => item.node),
      edges: EDGES.map(([from, to]) => ({ from, to })),
    },
    tasks: nodes.map(item => item.task),
  };
}

function staticRun({ id, name, status, createdAt, updatedAt, nodes, edges, tasks }) {
  return {
    // A static snapshot records completed work from the first attempt unless a
    // node explicitly reports the attempt it failed on.
    run: { id, name, status, createdAt, updatedAt, nodes: nodes.map(node => ({ attempt: 1, ...node })), edges },
    tasks,
  };
}

function completedTask(id, description, agent, model, startedAt, completedAt, extra = {}) {
  return {
    id, description, agent, model, status: 'completed', percent: 100,
    tokensIn: 3200, tokensOut: 780, turns: 6, toolCalls: 14, retries: 0,
    startedAt: new Date(startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(),
    logs: ['evidence attached', 'checks passed'],
    ...extra,
  };
}

function goldbachStaticRun(now) {
  const start = now - 3 * 3600_000;
  const at = minutes => new Date(start + minutes * 60_000);
  const task = (id, description, agent, model, status, startMin, endMin, extra = {}) => {
    // Blocked and pending tasks never started, so they must not carry work
    // totals or a startedAt that would make them look mid-flight.
    const started = startMin !== undefined && status !== 'blocked' && status !== 'pending';
    const base = {
      id, description, agent, model, status,
      percent: status === 'completed' || status === 'failed' ? 100 : 0,
      turns: started ? 3 : 0, toolCalls: started ? 7 : 0, retries: 0,
      tokensIn: started ? 1200 : undefined,
      tokensOut: started ? 280 : undefined,
      startedAt: started ? at(startMin).toISOString() : undefined,
      completedAt: endMin === undefined ? undefined : at(endMin).toISOString(),
    };
    return Object.fromEntries(Object.entries({ ...base, ...extra }).filter(([, value]) => value !== undefined));
  };

  const nodes = [
    { id: 'gb_spec', label: 'formalize-statement', state: 'completed', taskId: 'st_gb_spec', percent: 100 },
    { id: 'gb_sieve', label: 'prime-sieve', state: 'completed', taskId: 'st_gb_sieve', percent: 100 },
    { id: 'gb_small', label: 'small-cases', state: 'completed', taskId: 'st_gb_small', percent: 100 },
    { id: 'gb_lean', label: 'lean-model', state: 'completed', taskId: 'st_gb_lean', percent: 100 },
    { id: 'gb_coverage', label: 'coverage-proof', state: 'completed', taskId: 'st_gb_coverage', percent: 100 },
    { id: 'gb_pairs', label: 'pair-search', state: 'completed', taskId: 'st_gb_pairs', percent: 100 },
    { id: 'gb_kernel', label: 'kernel-check', state: 'completed', taskId: 'st_gb_kernel', percent: 100 },
    { id: 'gb_shards', label: 'shard-verify', state: 'completed', taskId: 'st_gb_shards', percent: 100 },
    { id: 'gb_adversary', label: 'counterexample-hunt', state: 'completed', taskId: 'st_gb_adversary', percent: 100 },
    { id: 'gb_analytic', label: 'analytic-bound', state: 'failed', taskId: 'st_gb_analytic', percent: 100, attempt: 2 },
    { id: 'gb_induction', label: 'induction-step', state: 'failed', taskId: 'st_gb_induction', percent: 100, attempt: 2 },
    { id: 'gb_review', label: 'independent-review', state: 'blocked', taskId: 'st_gb_review', percent: 0 },
    { id: 'gb_evidence', label: 'evidence-package', state: 'blocked', taskId: 'st_gb_evidence', percent: 0 },
    { id: 'gb_report', label: 'write-report', state: 'blocked', taskId: 'st_gb_report', percent: 0 },
    { id: 'gb_publish', label: 'publish-claim', state: 'cancelled', taskId: 'st_gb_publish', percent: 0 },
  ];

  const edges = [
    ['gb_spec', 'gb_sieve'],
    ['gb_spec', 'gb_small'],
    ['gb_spec', 'gb_lean'],
    ['gb_sieve', 'gb_coverage'],
    ['gb_sieve', 'gb_pairs'],
    ['gb_pairs', 'gb_shards'],
    ['gb_shards', 'gb_adversary'],
    ['gb_coverage', 'gb_analytic'],
    ['gb_lean', 'gb_kernel'],
    ['gb_analytic', 'gb_induction'],
    ['gb_kernel', 'gb_induction'],
    ['gb_adversary', 'gb_induction'],
    ['gb_induction', 'gb_review'],
    ['gb_review', 'gb_evidence'],
    ['gb_evidence', 'gb_report'],
    ['gb_report', 'gb_publish'],
  ];

  const tasks = [
    task('st_gb_spec', "Formalize Goldbach's conjecture and proof obligations", 'oracle', 'acme/orion-reasoner', 'completed', 0, 14, {
      tokensIn: 4200, tokensOut: 1100, turns: 8, toolCalls: 10,
      logs: ['normalized statement: every even n > 2 is p + q', 'encoded proof obligations in Lean', 'scope pinned at finite verification plus induction'],
      children: [
        { id: 'st_gb_spec_scope', description: 'scope all even n > 2', status: 'completed', percent: 100, agent: 'oracle', model: 'acme/orion-reasoner' },
        { id: 'st_gb_spec_audit', description: 'audit formal statement', status: 'completed', percent: 100, agent: 'judge', model: 'acme/judge-3' },
      ],
    }),
    task('st_gb_sieve', 'Build a verified prime sieve up to 4e18', 'forge', 'acme/atlas-code', 'completed', 14, 58, {
      tokensIn: 12800, tokensOut: 2400, turns: 16, toolCalls: 42,
      logs: ['wheel factorization enabled', 'shards 0..4095 checksummed', 'prime table manifest signed'],
      children: [
        { id: 'st_gb_sieve_wheel', description: 'wheel factorization', status: 'completed', percent: 100, agent: 'forge', model: 'acme/atlas-code' },
        { id: 'st_gb_sieve_shard', description: 'shard 0..2047', status: 'completed', percent: 100, agent: 'runner', model: 'acme/ship-1' },
        { id: 'st_gb_sieve_manifest', description: 'manifest and checksums', status: 'completed', percent: 100, agent: 'sentinel', model: 'acme/guard-2' },
      ],
    }),
    task('st_gb_small', 'Check all small even numbers by exhaustive search', 'probe', 'acme/orion-reasoner', 'completed', 14, 32, {
      tokensIn: 6400, tokensOut: 900, turns: 12, toolCalls: 18,
      logs: ['checked 0..10^8', 'no counterexample in the small range', 'result cache pinned'],
    }),
    task('st_gb_lean', 'Formalize the argument in Lean 4', 'oracle', 'acme/orion-reasoner', 'completed', 16, 70, {
      tokensIn: 15200, tokensOut: 5200, turns: 21, toolCalls: 48,
      logs: ['defined primePair relation', 'imported Mathlib number theory lemmas', 'proof development typechecks'],
      children: [
        { id: 'st_gb_lean_defs', description: 'definitions and notation', status: 'completed', percent: 100, agent: 'oracle', model: 'acme/orion-reasoner' },
        { id: 'st_gb_lean_lemmas', description: 'number theory lemma library', status: 'completed', percent: 100, agent: 'oracle', model: 'acme/orion-reasoner' },
        { id: 'st_gb_lean_lint', description: 'proof lint', status: 'completed', percent: 100, agent: 'judge', model: 'acme/judge-3' },
      ],
    }),
    task('st_gb_pairs', 'Search a prime pair for every even number in range', 'runner', 'acme/ship-1', 'completed', 58, 95, {
      tokensIn: 18400, tokensOut: 3600, turns: 19, toolCalls: 55,
      logs: ['interval 4..10^9 complete', 'interval 10^9..10^12 complete', 'interval 10^12..4e18 complete'],
      children: [
        { id: 'st_gb_pairs_small', description: '4..10^9', status: 'completed', percent: 100, agent: 'runner', model: 'acme/ship-1' },
        { id: 'st_gb_pairs_mid', description: '10^9..10^12', status: 'completed', percent: 100, agent: 'runner', model: 'acme/ship-1' },
        { id: 'st_gb_pairs_tail', description: '10^12..4e18', status: 'completed', percent: 100, agent: 'runner', model: 'acme/ship-1' },
      ],
    }),
    task('st_gb_coverage', 'Prove finite-range coverage of the pair search', 'judge', 'acme/judge-3', 'completed', 58, 76, {
      tokensIn: 7600, tokensOut: 2800, turns: 11, toolCalls: 22,
      logs: ['coverage argument checked', 'all shard boundaries covered', 'finite claim accepted'],
    }),
    task('st_gb_kernel', 'Kernel-check the Lean proof development', 'runner', 'acme/ship-1', 'completed', 70, 88, {
      tokensIn: 3100, tokensOut: 420, turns: 4, toolCalls: 7,
      logs: ['lake build complete', 'no sorry in the finite development', 'kernel exit 0'],
    }),
    task('st_gb_shards', 'Verify distributed sieve shard manifests', 'sentinel', 'acme/guard-2', 'completed', 95, 110, {
      tokensIn: 4800, tokensOut: 900, turns: 7, toolCalls: 14,
      logs: ['4096 manifests verified', 'checksum chain intact', 'no missing shard'],
    }),
    task('st_gb_adversary', 'Hunt for counterexamples and boundary cases', 'probe', 'acme/orion-reasoner', 'completed', 110, 124, {
      tokensIn: 9800, tokensOut: 1700, turns: 13, toolCalls: 31,
      logs: ['adversarial search exhausted 4e18', 'no counterexample found', 'boundary cases recorded'],
    }),
    task('st_gb_analytic', 'Close the analytic exceptional-set bound', 'oracle', 'acme/orion-reasoner', 'failed', 76, 120, {
      tokensIn: 8900, tokensOut: 2100, turns: 15, toolCalls: 28, retries: 2,
      error: 'exceptional-set estimate grows with the interval; no uniform bound at 4e18',
      logs: ['major arcs estimated', 'minor arcs leave an exceptional set', 'retry 2 failed to close the gap'],
    }),
    task('st_gb_induction', 'Prove the induction step for every even n', 'oracle', 'acme/orion-reasoner', 'failed', 124, 150, {
      tokensIn: 11300, tokensOut: 3400, turns: 18, toolCalls: 37, retries: 1,
      error: 'cannot close the induction step: the tail bound is not uniform in n',
      logs: ['base case discharged', 'induction hypothesis instantiated', 'tail bound grows without a uniform margin'],
      children: [
        { id: 'st_gb_induction_base', description: 'base case', status: 'completed', percent: 100, agent: 'oracle', model: 'acme/orion-reasoner' },
        { id: 'st_gb_induction_tail', description: 'uniform tail bound', status: 'failed', percent: 100, agent: 'oracle', model: 'acme/orion-reasoner' },
        { id: 'st_gb_induction_lemma', description: 'induction lemma', status: 'blocked', percent: 0, agent: 'oracle', model: 'acme/orion-reasoner' },
      ],
    }),
    task('st_gb_review', 'Independent referee review', 'judge', 'acme/judge-3', 'blocked', 150, undefined, {
      logs: ['waiting for a complete induction proof', 'no review started'],
      children: [
        { id: 'st_gb_referee_a', description: 'referee A', status: 'pending', percent: 0, agent: 'judge', model: 'acme/judge-3' },
        { id: 'st_gb_referee_b', description: 'referee B', status: 'pending', percent: 0, agent: 'judge', model: 'acme/judge-3' },
      ],
    }),
    task('st_gb_evidence', 'Package reproducible evidence', 'scribe', 'acme/quill-1', 'blocked', 150, undefined, {
      logs: ['blocked by review gate'],
      children: [
        { id: 'st_gb_evidence_corpus', description: 'verification corpus', status: 'pending', percent: 0, agent: 'runner', model: 'acme/ship-1' },
        { id: 'st_gb_evidence_repro', description: 'reproducibility bundle', status: 'pending', percent: 0, agent: 'scribe', model: 'acme/quill-1' },
      ],
    }),
    task('st_gb_report', 'Write the proof report', 'scribe', 'acme/quill-1', 'blocked', 150, undefined, {
      logs: ['waiting for evidence package'],
    }),
    task('st_gb_publish', 'Publish the proof claim', 'runner', 'acme/ship-1', 'cancelled', 150, 155, {
      logs: ['claim publication cancelled', 'proof is incomplete: induction step is open'],
    }),
  ];

  return staticRun({
    id: 'run_goldbach',
    name: 'Goldbach proof attempt',
    status: 'failed',
    createdAt: new Date(start).toISOString(),
    updatedAt: at(155).toISOString(),
    nodes,
    edges: edges.map(([from, to]) => ({ from, to })),
    tasks,
  });
}

function demoStaticRuns(now) {
  const docsStart = now - 2 * 3600_000;
  const docsDone = docsStart + 55 * 60_000;
  const docsNodes = [
    { id: 'outline', label: 'outline', state: 'completed', taskId: 'st_doc_outline', percent: 100 },
    { id: 'draft', label: 'draft', state: 'completed', taskId: 'st_doc_draft', percent: 100 },
    { id: 'review', label: 'review', state: 'completed', taskId: 'st_doc_review', percent: 100 },
    { id: 'publish', label: 'publish', state: 'completed', taskId: 'st_doc_publish', percent: 100 },
  ];
  const docsTasks = [
    completedTask('st_doc_outline', 'Outline the docs refresh', 'scribe', 'acme/quill-1', docsStart, docsStart + 8 * 60_000),
    completedTask('st_doc_draft', 'Rewrite the getting-started guide', 'scribe', 'acme/quill-1', docsStart + 8 * 60_000, docsStart + 30 * 60_000, { tokensIn: 6800, tokensOut: 1900, turns: 11, toolCalls: 25 }),
    completedTask('st_doc_review', 'Review docs for accuracy', 'judge', 'acme/judge-3', docsStart + 30 * 60_000, docsStart + 45 * 60_000, { tokensIn: 2100, tokensOut: 460, turns: 4, toolCalls: 8 }),
    completedTask('st_doc_publish', 'Publish the docs update', 'runner', 'acme/ship-1', docsStart + 45 * 60_000, docsDone, { tokensIn: 900, tokensOut: 180, turns: 2, toolCalls: 5 }),
  ];

  const auditStart = now - 5 * 3600_000;
  const auditNodes = [
    { id: 'snapshot', label: 'snapshot', state: 'completed', taskId: 'st_audit_snapshot', percent: 100 },
    { id: 'policy-scan', label: 'policy-scan', state: 'failed', taskId: 'st_audit_policy', percent: 100 },
    { id: 'license-check', label: 'license-check', state: 'completed', taskId: 'st_audit_license', percent: 100 },
    { id: 'sign', label: 'sign', state: 'cancelled', taskId: 'st_audit_sign', percent: 0 },
    { id: 'publish', label: 'publish', state: 'blocked', taskId: 'st_audit_publish', percent: 0 },
  ];
  const auditTasks = [
    completedTask('st_audit_snapshot', 'Snapshot release candidates', 'runner', 'acme/ship-1', auditStart, auditStart + 12 * 60_000),
    {
      id: 'st_audit_policy', description: 'Scan artifacts against policy SEC-114', agent: 'sentinel', model: 'acme/guard-2',
      status: 'failed', percent: 100, tokensIn: 4400, tokensOut: 820, turns: 7, toolCalls: 19, retries: 0,
      startedAt: new Date(auditStart + 12 * 60_000).toISOString(), completedAt: new Date(auditStart + 28 * 60_000).toISOString(),
      error: 'denied by rule SEC-114: world-readable artifact',
      logs: ['loaded policy pack SEC-114', 'artifact release.tar.gz has mode 0644', 'scan aborted'],
    },
    completedTask('st_audit_license', 'Verify third-party licenses', 'scribe', 'acme/quill-1', auditStart + 12 * 60_000, auditStart + 35 * 60_000, { tokensIn: 2800, tokensOut: 610, turns: 5, toolCalls: 11 }),
    {
      id: 'st_audit_sign', description: 'Sign the release artifact', agent: 'runner', model: 'acme/ship-1',
      status: 'cancelled', percent: 0, turns: 0, toolCalls: 0,
      startedAt: new Date(auditStart + 35 * 60_000).toISOString(),
      logs: ['waiting for policy-scan', 'cancelled by gate'],
    },
    {
      id: 'st_audit_publish', description: 'Publish the audited release', agent: 'runner', model: 'acme/ship-1',
      status: 'pending', percent: 0, turns: 0, toolCalls: 0,
      logs: ['blocked by sign'],
    },
  ];

  return [
    goldbachStaticRun(now),
    staticRun({
      id: 'run_docs', name: 'docs polish', status: 'completed',
      createdAt: new Date(docsStart).toISOString(), updatedAt: new Date(docsDone).toISOString(),
      nodes: docsNodes,
      edges: [{ from: 'outline', to: 'draft' }, { from: 'draft', to: 'review' }, { from: 'review', to: 'publish' }],
      tasks: docsTasks,
    }),
    staticRun({
      id: 'run_audit', name: 'release audit', status: 'failed',
      createdAt: new Date(auditStart).toISOString(), updatedAt: new Date(auditStart + 40 * 60_000).toISOString(),
      nodes: auditNodes,
      edges: [
        { from: 'snapshot', to: 'policy-scan' },
        { from: 'snapshot', to: 'license-check' },
        { from: 'policy-scan', to: 'sign' },
        { from: 'license-check', to: 'sign' },
        { from: 'sign', to: 'publish' },
      ],
      tasks: auditTasks,
    }),
  ];
}

function goldbachStandaloneTasks(now, phase) {
  const rate = seed => Array.from({ length: 24 }, (_, index) =>
    42 + Math.round(24 * Math.sin(phase / 1700 + index * 0.61 + seed)) + (index % 4));
  const activity = (text, tool, sinceOffset = 12_000) => ({
    phase: 'tool', tool, since: now - sinceOffset, lastAt: now - 300, text,
  });

  return [
    {
      id: 'st_gb_sieve_audit', description: 'Audit prime sieve checksum', agent: 'sentinel', model: 'acme/guard-2',
      status: 'running', percent: 68, tokensIn: 5800 + Math.round(phase / 45), tokensOut: 920 + Math.round(phase / 190),
      tokenRate: rate(1), turns: 7, toolCalls: 16, retries: 0,
      startedAt: new Date(now - 620_000).toISOString(),
      progress: 'verifying shard 2817/4096',
      activity: activity('verifying shard 2817/4096', 'sha256sum'),
      logs: ['[01:04] 4096 manifests queued', '[02:12] shard 2816 matches', '[02:28] tail manifest pending'],
      children: [
        { id: 'st_gb_sieve_audit_head', description: 'head shard chain', status: 'completed', percent: 100, agent: 'sentinel', model: 'acme/guard-2' },
        { id: 'st_gb_sieve_audit_tail', description: 'tail shard chain', status: 'running', percent: 54, agent: 'sentinel', model: 'acme/guard-2' },
        { id: 'st_gb_sieve_audit_sign', description: 'sign audit receipt', status: 'pending', percent: 0, agent: 'runner', model: 'acme/ship-1' },
      ],
    },
    {
      id: 'st_gb_shard_bench', description: 'Benchmark pair-search shard', agent: 'probe', model: 'acme/orion-reasoner',
      status: 'running', percent: 41, tokensIn: 3300 + Math.round(phase / 70), tokensOut: 610 + Math.round(phase / 240),
      tokenRate: rate(7), turns: 5, toolCalls: 11, retries: 1,
      startedAt: new Date(now - 380_000).toISOString(),
      progress: 'benchmarking shard 17/42',
      activity: activity('benchmarking shard 17/42', 'hyperfine'),
      logs: ['[00:32] pinned CPU frequency', '[01:03] shard 16: 2.8M even numbers/s', '[01:18] cache pressure detected'],
      children: [
        { id: 'st_gb_bench_pin', description: 'pin CPU frequency', status: 'completed', percent: 100, agent: 'probe', model: 'acme/orion-reasoner' },
        { id: 'st_gb_bench_tail', description: 'tail shard benchmark', status: 'running', percent: 41, agent: 'probe', model: 'acme/orion-reasoner' },
      ],
    },
    {
      id: 'st_gb_lean_review', description: 'Review Lean induction lemma', agent: 'judge', model: 'acme/judge-3',
      status: 'failed', percent: 100, tokensIn: 4600, tokensOut: 980, turns: 6, toolCalls: 13, retries: 1,
      startedAt: new Date(now - 1280_000).toISOString(), completedAt: new Date(now - 840_000).toISOString(),
      error: 'proof review rejected the induction lemma: tail bound is not uniform in n',
      logs: ['opened induction-step.lean', 'found an unproven uniform tail bound', 'review rejected with one blocker'],
      children: [
        { id: 'st_gb_review_a', description: 'referee A', status: 'failed', percent: 100, agent: 'judge', model: 'acme/judge-3' },
        { id: 'st_gb_review_b', description: 'referee B', status: 'completed', percent: 100, agent: 'judge', model: 'acme/judge-3' },
      ],
    },
    {
      id: 'st_gb_corpus', description: 'Rebuild Goldbach corpus', agent: 'runner', model: 'acme/ship-1',
      status: 'paused', percent: 72, tokensIn: 2700, tokensOut: 540, turns: 4, toolCalls: 9, retries: 0,
      startedAt: new Date(now - 960_000).toISOString(),
      progress: 'paused for cache rebuild',
      logs: ['[00:18] loaded 4e18 range index', '[00:44] corpus 72% complete', '[00:51] paused by operator'],
    },
    {
      id: 'st_gb_pack', description: 'Package Goldbach evidence', agent: 'scribe', model: 'acme/quill-1',
      status: 'pending', percent: 0, turns: 0, toolCalls: 0,
      logs: ['waiting for induction and review gates'],
    },
    {
      id: 'st_gb_appendix', description: 'Write Goldbach proof appendix', agent: 'scribe', model: 'acme/quill-1',
      status: 'completed', percent: 100, tokensIn: 3900, tokensOut: 1100, turns: 5, toolCalls: 8, retries: 0,
      startedAt: new Date(now - 2600_000).toISOString(), completedAt: new Date(now - 2100_000).toISOString(),
      logs: ['documented finite verification', 'recorded open induction gap', 'appendix checked for reproducibility'],
    },
  ];
}

function standaloneTasks(now, phase) {
  const indexPercent = 38 + 24 * (0.5 + 0.5 * Math.sin(phase / 9000));
  const indexStarted = now - 84_000;
  return [
    {
      id: 'st_index', description: 'Refresh dependency index', agent: 'indexer', model: 'acme/atlas-code',
      status: 'running', percent: Math.round(indexPercent),
      tokensIn: 7600 + Math.round(phase / 40), tokensOut: 1400 + Math.round(phase / 160),
      tokenRate: Array.from({ length: 24 }, (_, index) => 70 + Math.round(28 * Math.sin(phase / 1800 + index * 0.6)) + (index % 5)),
      turns: 5, toolCalls: 13, retries: 0,
      startedAt: new Date(indexStarted).toISOString(),
      progress: 'walking .omo/senpi-task/tasks',
      activity: { phase: 'tool', tool: 'rg', since: now - 12_000, lastAt: now - 400, text: 'walking .omo/senpi-task/tasks' },
      logs: ['[00:12] indexed 128 records', '[00:41] rebuilt reverse map', '[01:03] watching for changes'],
    },
    {
      id: 'st_cleanup', description: 'Cleanup stale branches', agent: 'runner', model: 'acme/ship-1',
      status: 'completed', percent: 100, tokensIn: 2300, tokensOut: 510, turns: 3, toolCalls: 7, retries: 0,
      startedAt: new Date(now - 3600_000).toISOString(), completedAt: new Date(now - 3300_000).toISOString(),
      logs: ['deleted 4 merged branches', 'kept 2 protected branches'],
    },
    {
      id: 'st_probe', description: 'Probe GPU runner', agent: 'scout', model: 'acme/orion-reasoner',
      status: 'pending', percent: 0, turns: 0, toolCalls: 0,
      logs: ['waiting for runner capacity'],
    },
    {
      id: 'st_replay', description: 'Replay flaky history test', agent: 'probe', model: 'acme/orion-reasoner',
      status: 'paused', percent: 55, tokensIn: 1800, tokensOut: 390, turns: 2, toolCalls: 4, retries: 1,
      startedAt: new Date(now - 900_000).toISOString(),
      progress: 'paused after 3/10 repetitions',
      logs: ['repetition 1 passed', 'repetition 2 passed', 'paused by operator'],
    },
    ...goldbachStandaloneTasks(now, phase),
  ];
}

function withModelNarrative(task) {
  if (task.thinking || task.reply) return task;
  const first = task.logs?.[0] ?? task.progress ?? task.description;
  const last = task.logs?.at(-1) ?? task.progress ?? task.description;
  const thinking = clean(`Plan: ${task.description}. ${first}`).slice(0, 600);
  let reply;
  if (task.status === 'failed' || task.status === 'error') {
    reply = clean(`Blocked on ${task.description}. ${task.error ?? last}`).slice(0, 600);
  } else if (task.status === 'completed') {
    reply = clean(`Finished ${task.description}. ${last}`).slice(0, 600);
  } else if (task.status === 'running') {
    reply = clean(`Working on ${task.description}. ${last}`).slice(0, 600);
  } else {
    reply = clean(`Waiting on ${task.description}. ${last}`).slice(0, 600);
  }
  return { ...task, thinking, reply };
}

export class DemoEngine {
  constructor({ now = Date.now(), startOffset = 32_000, cycleMs = CYCLE_MS } = {}) {
    this.origin = now - startOffset;
    this.cycleMs = cycleMs;
  }

  reset(now = Date.now()) {
    this.origin = now;
  }

  phase(now = Date.now()) {
    const elapsed = now - this.origin;
    if (elapsed < 0) return { phase: 0, cycleStart: this.origin, cycle: 0 };
    const cycle = Math.floor(elapsed / this.cycleMs);
    const phase = elapsed - cycle * this.cycleMs;
    return { phase, cycleStart: this.origin + cycle * this.cycleMs, cycle };
  }

  snapshot(now = Date.now()) {
    const { phase, cycleStart, cycle } = this.phase(now);
    const active = activeRun(now, cycleStart, phase, cycle);
    const staticRuns = demoStaticRuns(now);
    return {
      version: 3,
      sessionId: 'demo-7f3a',
      mode: 'demo',
      connected: true,
      language: 'en',
      generatedAt: new Date(now).toISOString(),
      provenance: {
        origin: 'demo-engine',
        capturedAt: new Date(now).toISOString(),
        view: 'watch',
        demo: { cycle, phase, cycleMs: this.cycleMs },
      },
      demo: { cycle, phase, cycleMs: this.cycleMs },
      runs: [active.run, ...staticRuns.map(item => item.run)],
      tasks: [...active.tasks, ...staticRuns.flatMap(item => item.tasks), ...standaloneTasks(now, phase)]
        .map(withModelNarrative),
    };
  }
}
