// Template tests for autoresearch-bootstrap workflow-template.js
// Zero-dependency: uses only Node built-ins (node:test, node:assert, node:fs, node:vm, node:path, node:url).
//
// These tests cover:
//   - placeholder fill => parseable, no leftover placeholders
//   - args.action dispatch
//   - static safety assertions (no git reset --hard / git add -A / agent background-wait)
//   - protocol presence (worktree add, main-session handoff, git-common-dir state)
//
// They do NOT spin up the real Workflow runtime; they execute the template module inside a
// sandbox where the Workflow globals (agent/phase/log/budget/args) are mocked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.join(__dirname, '..', 'references', 'workflow-template.js')
const RAW = fs.readFileSync(TEMPLATE_PATH, 'utf8')

// Canonical placeholder fixture: every {PLACEHOLDER} filled with a safe value.
const FIXTURE = {
  PROJECT_NAME: 'demo',
  research_focus: 'push val_loss down',
  max_experiments: '4',
  primary_metric: 'val_loss',
  best_direction: 'lowest',
  noise_floor: '0.001',
  complex_code_lines: '20',
  simplicity_threshold_guidance: 'treat <0.001 as noise; confine edits to the loss block',
  train_command: 'python train.py',
  train_command_with_logging: 'RUN=__RUN_ID__; ATTEMPT=__ATTEMPT_ID__; COMMIT=__SOURCE_COMMIT__; WT=__WORKTREE__; REMOTE=__REMOTE_DIR__; LOG=__LOG_PATH__; DONE=__DONE_PATH__; OWNER=__OWNER_PATH__; PIDFILE=__PID_PATH__; mkdir -p "$REMOTE"; printf "{\\"runIdentity\\":\\"%s\\",\\"sourceCommit\\":\\"%s\\",\\"pid\\":%s,\\"processGroupId\\":%s,\\"processStartId\\":\\"%s\\"}" "$ATTEMPT" "$COMMIT" "$$" "$$" "start" > "$OWNER"; printf "%s" "$$" > "$PIDFILE"; timeout 1800 python train.py > "$LOG" 2>&1; rc=$?; printf "{\\"schemaVersion\\":1,\\"runIdentity\\":\\"%s\\",\\"sourceCommit\\":\\"%s\\",\\"pid\\":%s,\\"processGroupId\\":%s,\\"processStartId\\":\\"%s\\",\\"exitCode\\":%s,\\"timedOut\\":false,\\"outcome\\":\\"finished\\",\\"startedAt\\":\\"start\\",\\"finishedAt\\":\\"end\\",\\"logPath\\":\\"%s\\"}" "$ATTEMPT" "$COMMIT" "$$" "$$" "start" "$rc" "$LOG" > "$DONE.tmp"; mv "$DONE.tmp" "$DONE" # done.json.tmp',
  metric_extract_command: 'RUN=__RUN_ID__; ATTEMPT=__ATTEMPT_ID__; COMMIT=__SOURCE_COMMIT__; WT=__WORKTREE__; REMOTE=__REMOTE_DIR__; LOG=__LOG_PATH__; DONE=__DONE_PATH__; OWNER=__OWNER_PATH__; PIDFILE=__PID_PATH__; grep "^val_loss:" "$LOG" | tail -1',
  additional_metric_extract_commands: 'echo secondary',
  budget_description: '5 epochs',
  max_duration_seconds: '1800',
  data_verification_steps: 'ls data && echo OK',
  crash_value: '999.0',
  baseline_retry_cap: '2',
  remote_run_root: '/tmp/demo/runs',
  research_ideas_json: '["lower lr", "add dropout"]',
  train_scope_list_json: '["model.py", "train.py"]',
  prepare_scope_list_json: '["data.py", "metric.py"]',
  secondary_metrics_json: '{"train_loss": "stable"}',
}

function fillTemplate(raw, fixture) {
  let out = raw
  // Bare-key {PLACEHOLDER} replacement. Match exactly the documented keys so stray {x} in
  // sample code (e.g. shell ${X}) is untouched.
  for (const [k, v] of Object.entries(fixture)) {
    out = out.replaceAll('{' + k + '}', v)
  }
  return out
}

const FILLED = fillTemplate(RAW, FIXTURE)

test('fixture leaves no {PLACEHOLDER} tokens', () => {
  const leftover = FILLED.match(/\{[A-Z][A-Z0-9_]*\}/g)
  assert.equal(leftover, null, `unfilled placeholders: ${JSON.stringify(leftover)}`)
})

test('filled template is valid JS (node --check equivalent)', () => {
  // Workflow scripts execute in an async top-level context. Strip the ESM export and wrap in
  // an async IIFE to model that parser context without executing the promise.
  const parseSource = FILLED.replace(/export const meta\s*=/, 'globalThis.__meta =')
  assert.doesNotThrow(() => new vm.Script(`(async () => {\n${parseSource}\n})()`, { filename: 'workflow-template.filled.js' }))
})

test('template exposes all documented actions', () => {
  for (const a of ['init', 'prepare', 'mark_started', 'finalize', 'status', 'cleanup']) {
    assert.ok(FILLED.includes(`'${a}'`) || FILLED.includes(`"${a}"`), `action ${a} not referenced`)
  }
})

test('static safety (real): no git reset --hard as an issued command', () => {
  assert.doesNotMatch(FILLED, /git reset --hard/, 'template must not issue git reset --hard')
  assert.doesNotMatch(FILLED, /git add -A/, 'template must not issue whole-tree git add -A')
})

test('protocol presence: worktree isolation, main-session handoff, git-common-dir state', () => {
  assert.match(FILLED, /git worktree add/, 'must create worktrees')
  assert.match(FILLED, /MAIN CONVERSATION/i, 'must name the main conversation as the launcher')
  assert.match(FILLED, /git-common-dir/, 'must keep state under the git common dir')
  assert.match(FILLED, /schemaVersion/, 'must version persisted state')
  assert.match(FILLED, /fingerprint/i, 'must record a config fingerprint')
  assert.match(FILLED, /done\.json/, 'must use an identity-bound done marker')
  for (const token of ['__RUN_ID__', '__ATTEMPT_ID__', '__SOURCE_COMMIT__', '__WORKTREE__', '__REMOTE_DIR__', '__LOG_PATH__', '__DONE_PATH__', '__OWNER_PATH__', '__PID_PATH__']) {
    assert.match(FILLED, new RegExp(token), `must document fixed token ${token}`)
  }
  assert.match(FILLED, /processStartId/, 'must bind reattachment to OS process identity')
  assert.match(FILLED, /FIRST look up state\.results by attemptId/, 'finalize retry must look up saved result before active')
  assert.match(FILLED, /BASELINE SPECIAL CASE/, 'baseline must establish the first best')
  assert.match(FILLED, /equal to C\.crashMetric/, 'crash sentinel must be classified before ranking')
})

// --- Runtime dispatch via mocked Workflow globals --------------------------------------

// A harness that compiles the filled template as ESM-ish source and runs it inside a vm
// context with mocked agent/phase/log/budget/args. The template uses top-level await and
// `export const meta`, so we wrap it: replace `export const meta` with `globalThis.meta =`
// and evaluate as a script that returns the module's `result`.
async function runAction(action, { runId = 'demo-run', attemptId, taskId, cleanupScope, agent } = {}) {
  let src = FILLED
    .replace(/export const meta\s*=/, 'globalThis.__meta =')
  const agentFn = agent || (async (prompt, opts) => ({ phase: 'baseline_needed', revision: 1, status: 'ok', active: null, launch: null, result: null, nextAction: null, message: 'mock' }))
  const context = {
    globalThis: {},
    agent: agentFn,
    phase: () => {},
    log: () => {},
    parallel: async (xs) => Promise.all(xs.map((f) => f())),
    pipeline: async (item, ...stages) => {
      let v = item
      for (const s of stages) v = await s(v, item, 0)
      return v
    },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    args: { action, runId, attemptId, taskId, cleanupScope },
    assertOk: true,
  }
  context.globalThis = context
  vm.createContext(context)
  src = src.replace(/return result\s*\n\s*\/\* Template variables/, 'module.exports.__result = result\nreturn result\n\n/* Template variables')
  const wrapped = `(async () => {\n${src}\n})()`
  // Provide CommonJS module.exports shim.
  context.module = { exports: {} }
  const script = new vm.Script(wrapped, { filename: `wf-${action}.js` })
  await script.runInContext(context)
  return context.module.exports.__result
}

test('unknown action throws', async () => {
  await assert.rejects(() => runAction('bogus'), /Unknown action/)
})

test('invalid runId throws', async () => {
  await assert.rejects(() => runAction('init', { runId: '../escape' }), /runId must match/)
  await assert.rejects(() => runAction('init', { runId: '' }), /runId must match/)
})

test('init dispatches to a single agent and returns its result', async () => {
  let calls = 0
  const out = await runAction('init', {
    agent: async () => { calls++; return { action: 'init', runId: 'demo-run', phase: 'baseline_needed', revision: 1, status: 'ok', active: null, launch: null, result: null, nextAction: null, message: 'init ok' } },
  })
  assert.equal(calls, 1, 'init calls exactly one agent')
  assert.equal(out.phase, 'baseline_needed')
  assert.equal(out.launch, null, 'init must not return a launch contract')
})

test('mark_started requires attemptId', async () => {
  await assert.rejects(() => runAction('mark_started', { runId: 'demo-run' }), /attemptId/)
})

test('finalize requires attemptId', async () => {
  await assert.rejects(() => runAction('finalize', { runId: 'demo-run' }), /attemptId/)
})

test('prepare calls the inspect agent (dispatch entered, no throw)', async () => {
  // The mock inspect returns mode 'complete', so prepare takes the short finalize-style path.
  let agentCalls = 0
  const out = await runAction('prepare', {
    runId: 'demo-run',
    agent: async (prompt, opts) => {
      agentCalls++
      // First agent call is the inspect step.
      if (prompt.includes('Read and validate state.json only')) {
        return { mode: 'complete', phase: 'ready', revision: 2, context: {} }
      }
      return { action: 'prepare', runId: 'demo-run', phase: 'complete', revision: 2, status: 'complete', active: null, launch: null, result: null, nextAction: null, message: 'cap reached' }
    },
  })
  assert.ok(agentCalls >= 1)
  assert.equal(out.status, 'complete')
  assert.equal(out.launch, null, 'complete path returns no launch')
})

test('prepare experiment reserves state before planning side effects', async () => {
  const prompts = []
  const out = await runAction('prepare', {
    agent: async (prompt) => {
      prompts.push(prompt)
      if (prompt.includes('Read and validate state.json only')) {
        return {mode: 'experiment', phase: 'ready', revision: 2, context: {best: {commit: 'a'.repeat(40)}}}
      }
      if (prompt.includes('Atomically reserve exactly ONE experiment')) {
        return {experimentNumber: 1, parentCommit: 'a'.repeat(40), branch: 'autoresearch/demo-run/exp-0001', worktree: '/tmp/wt/exp-0001'}
      }
      if (prompt.includes('Plan and implement exactly ONE experiment')) {
        return {idea: 'lower lr', files: ['train.py'], branch: 'autoresearch/demo-run/exp-0001', worktree: '/tmp/wt/exp-0001', parentCommit: 'a'.repeat(40), candidateCommit: 'b'.repeat(40), analysis: 'test', substitutions: {}}
      }
      return {action: 'prepare', runId: 'demo-run', phase: 'experiment_prepared', revision: 4, status: 'waiting', active: {unitId: 'exp-0001', attemptId: 'demo-run-exp0001-bbbbbbbbbbbb-a1', lifecycle: 'prepared'}, launch: {command: 'run', cwd: '/tmp/wt/exp-0001', attemptId: 'demo-run-exp0001-bbbbbbbbbbbb-a1', logPath: '/tmp/log', donePath: '/tmp/done.json', maxTimeSeconds: 1800}, result: null, nextAction: 'launch_in_main_session', message: 'prepared'}
    },
  })
  const reserveIndex = prompts.findIndex((p) => p.includes('Atomically reserve exactly ONE experiment'))
  const planIndex = prompts.findIndex((p) => p.includes('Plan and implement exactly ONE experiment'))
  assert.ok(reserveIndex >= 0 && planIndex > reserveIndex, 'reservation must persist before planning')
  assert.equal(out.nextAction, 'launch_in_main_session')
})

test('status dispatch is read-only and returns no new launch in mock', async () => {
  let prompt = ''
  const out = await runAction('status', {
    agent: async (p) => {
      prompt = p
      return {action: 'status', runId: 'demo-run', phase: 'ready', revision: 2, status: 'ok', active: null, launch: null, result: null, nextAction: 'prepare', message: 'ready'}
    },
  })
  assert.match(prompt, /Read-only reconcile/)
  assert.equal(out.launch, null)
  assert.equal(out.nextAction, 'prepare')
})

test('valid cleanup dispatch forbids global prune and force removal', async () => {
  let prompt = ''
  await runAction('cleanup', {
    cleanupScope: 'discarded',
    agent: async (p) => {
      prompt = p
      return {action: 'cleanup', runId: 'demo-run', phase: 'ready', revision: 3, status: 'ok', active: null, launch: null, result: null, nextAction: 'prepare', message: 'clean'}
    },
  })
  assert.match(prompt, /Do NOT run repository-wide git worktree prune/)
  assert.doesNotMatch(prompt, /git worktree prune\s*$/m)
  assert.match(prompt, /Do not force/)
})

test('cleanup rejects invalid scope', async () => {
  await assert.rejects(() => runAction('cleanup', { runId: 'demo-run', cleanupScope: 'purge' }), /cleanupScope/)
})

test('real git worktree smoke: keep advances parent while discard remains isolated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-wt-'))
  const repo = path.join(root, 'repo')
  const wtRoot = path.join(root, '.autoresearch-worktrees', 'repo-demo-run')
  fs.mkdirSync(repo, {recursive: true})
  const git = (cwd, ...argv) => execFileSync('git', argv, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
  try {
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.invalid')
    fs.writeFileSync(path.join(repo, 'train.py'), 'loss = "baseline"\n')
    git(repo, 'add', 'train.py')
    git(repo, 'commit', '-q', '-m', 'baseline')
    const baseline = git(repo, 'rev-parse', 'HEAD')

    const exp1 = path.join(wtRoot, 'exp-0001')
    fs.mkdirSync(wtRoot, {recursive: true})
    git(repo, 'worktree', 'add', '-q', '-b', 'autoresearch/demo-run/exp-0001', exp1, baseline)
    fs.writeFileSync(path.join(exp1, 'train.py'), 'loss = "keep"\n')
    git(exp1, 'add', '--', 'train.py')
    git(exp1, 'commit', '-q', '-m', 'keep candidate')
    const best = git(exp1, 'rev-parse', 'HEAD')

    const exp2 = path.join(wtRoot, 'exp-0002')
    git(repo, 'worktree', 'add', '-q', '-b', 'autoresearch/demo-run/exp-0002', exp2, best)
    fs.writeFileSync(path.join(exp2, 'train.py'), 'loss = "discard"\n')
    git(exp2, 'add', '--', 'train.py')
    git(exp2, 'commit', '-q', '-m', 'discard candidate')
    const discarded = git(exp2, 'rev-parse', 'HEAD')

    const exp3 = path.join(wtRoot, 'exp-0003')
    git(repo, 'worktree', 'add', '-q', '-b', 'autoresearch/demo-run/exp-0003', exp3, best)
    assert.equal(git(exp3, 'rev-parse', 'HEAD'), best, 'next experiment starts from kept best')
    assert.notEqual(discarded, best)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), baseline, 'main checkout never moves')
    assert.equal(fs.readFileSync(path.join(exp2, 'train.py'), 'utf8'), 'loss = "discard"\n', 'discard worktree remains for audit')
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

test('static safety (documents): template must not instruct a Workflow agent to run_in_background or sleep-await training', () => {
  // The ONLY occurrences of run_in_background must be in prose describing the MAIN CONVERSATION,
  // never inside an agent task instruction as something the agent itself runs.
  const lines = FILLED.split('\n')
  for (const l of lines) {
    if (l.includes('run_in_background')) {
      assert.match(l, /MAIN CONVERSATION|main conversation|The completion notification/, `run_in_background must only describe main-conversation handoff, found: ${l.trim()}`)
    }
  }
  // No agent-instructed training-period poll/sleep loop.
  assert.doesNotMatch(FILLED, /until \[ -f .*done\.flag \]; do sleep/, 'no stale done.flag poll loop')
})
