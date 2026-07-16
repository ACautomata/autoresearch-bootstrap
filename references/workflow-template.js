// Autoresearch segmented state-machine blueprint
//
// This template is assembled inline for one research configuration, then invoked
// repeatedly with args.action. Each invocation is SHORT. Long training is never
// launched or awaited by a workflow agent: `prepare` returns a launch contract to
// the main conversation, whose Bash(run_in_background=true) owns the full process
// lifetime. After the completion notification, the main conversation invokes
// `finalize`.

export const meta = {
  name: '{PROJECT_NAME}-autoresearch-state-machine',
  description: 'Resumable segmented autoresearch with main-session training handoff and per-experiment worktrees',
  phases: [
    { title: 'Initialize' },
    { title: 'Prepare' },
    { title: 'Finalize' },
    { title: 'Status' },
    { title: 'Cleanup' },
  ],
}

const C = {
  project:         '{PROJECT_NAME}',
  focus:           '{research_focus}',
  maxExperiments:  {max_experiments},
  metric:          '{primary_metric}',
  direction:       '{best_direction}',
  noiseFloor:      {noise_floor},
  maxLines:        {complex_code_lines},
  simplicityGuide: '{simplicity_threshold_guidance}',
  trainCommand:    '{train_command}',
  launchTemplate:  '{train_command_with_logging}',
  extractCommand:  '{metric_extract_command}',
  extraExtract:    '{additional_metric_extract_commands}',
  budget:          '{budget_description}',
  maxTimeSeconds:  {max_duration_seconds},
  verifyData:      '{data_verification_steps}',
  crashMetric:     {crash_value},
  baselineRetries: {baseline_retry_cap},
  remoteRunRoot:   '{remote_run_root}',
  ideas:           /* {research_ideas_json} */[],
  trainScope:      /* {train_scope_list_json} */[],
  prepareScope:    /* {prepare_scope_list_json} */[],
  secondary:       /* {secondary_metrics_json} */{},
}

const ACTIONS = ['init', 'prepare', 'mark_started', 'finalize', 'status', 'cleanup']
const INPUT = typeof args === 'string' ? JSON.parse(args) : (args || {})
const action = INPUT.action
const runId = INPUT.runId

if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`)
if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
  throw new Error('runId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
}

const REQUIRED_ATTEMPT_TOKENS = ['__RUN_ID__', '__ATTEMPT_ID__', '__SOURCE_COMMIT__', '__WORKTREE__', '__REMOTE_DIR__', '__LOG_PATH__', '__DONE_PATH__', '__OWNER_PATH__', '__PID_PATH__']
function requireExactlyOnce(text, token, field) {
  const count = text.split(token).length - 1
  if (count !== 1) throw new Error(`${field} must contain ${token} exactly once (found ${count})`)
}
function validateConfiguredContracts() {
  for (const token of REQUIRED_ATTEMPT_TOKENS) requireExactlyOnce(C.launchTemplate, token, 'launchTemplate')
  for (const token of REQUIRED_ATTEMPT_TOKENS) {
    if (!C.extractCommand.includes(token) && !C.extraExtract.includes(token)) {
      throw new Error(`resolved extraction templates must reference ${token}`)
    }
  }
  for (const marker of ['runIdentity', 'sourceCommit', 'pid', 'processGroupId', 'processStartId', 'done.json.tmp']) {
    if (!C.launchTemplate.includes(marker)) throw new Error(`launchTemplate must implement ownership marker ${marker}`)
  }
}
validateConfiguredContracts()

const PHASES = ['baseline_needed', 'baseline_planning', 'baseline_prepared', 'baseline_in_flight', 'ready', 'experiment_planning', 'experiment_prepared', 'experiment_in_flight', 'complete', 'failed', 'aborted']
const NEXT_ACTIONS = ['prepare', 'launch_in_main_session', 'finalize', 'cleanup']

const ACTION_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {type: 'string', enum: [action]},
    runId: {type: 'string', enum: [runId]},
    phase: {type: 'string', enum: PHASES},
    revision: {type: 'number'},
    status: {type: 'string', enum: ['ok', 'waiting', 'complete', 'failed']},
    active: {
      anyOf: [
        {type: 'null'},
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            unitId: {type: 'string'},
            attemptId: {type: 'string'},
            lifecycle: {type: 'string', enum: ['planning', 'prepared', 'in_flight', 'finalized']},
          },
          required: ['unitId', 'attemptId', 'lifecycle'],
        },
      ],
    },
    launch: {
      anyOf: [
        {type: 'null'},
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: {type: 'string'},
            cwd: {type: 'string'},
            attemptId: {type: 'string'},
            logPath: {type: 'string'},
            donePath: {type: 'string'},
            maxTimeSeconds: {type: 'number'},
          },
          required: ['command', 'cwd', 'attemptId', 'logPath', 'donePath', 'maxTimeSeconds'],
        },
      ],
    },
    result: {anyOf: [{type: 'object'}, {type: 'null'}]},
    nextAction: {anyOf: [{type: 'string', enum: NEXT_ACTIONS}, {type: 'null'}]},
    message: {type: 'string'},
  },
  required: ['action', 'runId', 'phase', 'revision', 'status', 'active', 'launch', 'result', 'nextAction', 'message'],
}

const stateProtocol = `
STATE PROTOCOL (mandatory):
- Resolve projectRoot with git rev-parse --show-toplevel and gitCommonDir with git rev-parse --git-common-dir; make gitCommonDir absolute.
- State directory: <gitCommonDir>/autoresearch/${runId}; files: state.json, state.json.prev, results.tsv.
- Worktree root: <project-parent>/.autoresearch-worktrees/<repo-name>-${runId}. Every normalized worktree path MUST remain below that root.
- state.json schemaVersion=1 is the sole authority. It records revision, configFingerprint, initialCommit, phase, baseline, best, nextExperimentNumber, experiments, active, results, storage and failure.
- Update state atomically: validate runId/schema/revision, write state.json.tmp in the same directory, preserve the prior valid state as state.json.prev, then rename tmp to state.json.
- Rebuild results.tsv from state.results after every finalized result; never append blindly. Sanitize tabs/newlines in free text. The file lives in gitCommonDir, outside every worktree/index.
- A retry of the same action is idempotent. Existing active prepared/in-flight attempt => return the SAME attemptId and launch contract. Existing finalized attempt => return its saved result. Never create a second attempt merely because a response was lost.
- Config fingerprint is a stable digest of the fully resolved C object. Existing run + different fingerprint => fail; do not overwrite.
- Never move or clean the user's main checkout. Never destructively rewrite a candidate worktree. Discard means best remains unchanged.
`

const worktreeProtocol = `
WORKTREE PROTOCOL (mandatory):
- Baseline: git worktree add --detach <worktreeRoot>/baseline <initialCommit>.
- Experiment N: branch autoresearch/${runId}/exp-<NNNN>, worktree <worktreeRoot>/exp-<NNNN>, created from state.best.commit.
- If a path already exists, verify it in git worktree list --porcelain and verify expected branch/commit before reuse; otherwise fail.
- Plan only inside that experiment worktree. Validate every changed/untracked path against C.trainScope and reject any C.prepareScope/control/results/training-artifact path.
- Stage only the explicit validated path list. Do not stage the whole tree.
- Keep advances state.best to candidateCommit. Discard/crash leaves state.best unchanged. Candidate branch/worktree stays for audit.
- Cleanup only finalized, clean worktrees owned by this run, using normal git worktree remove. Dirty/in-flight worktrees are skipped and reported. Branches, state and results are retained.
`

const launchProtocol = `
LAUNCH CONTRACT PROTOCOL (mandatory):
- Workflow agents NEVER launch training, call background Bash, sleep through training, poll for completion, or wait for done. They only PREPARE a complete command for the main conversation.
- Each attempt has a deterministic identity: baseline or exp number + candidate commit + attempt number.
- Each attempt uses a unique directory below C.remoteRunRoot/${runId}/<attemptId> containing claim/, pid, run.log and done.json. These are run data, not helper scripts.
- The complete inline launch/extraction templates use these fixed tokens exactly: __RUN_ID__, __ATTEMPT_ID__, __SOURCE_COMMIT__, __WORKTREE__, __REMOTE_DIR__, __LOG_PATH__, __DONE_PATH__. Validate every required token is present before preparing; substitute deterministically, reject leftovers, and persist BOTH fully resolved launch and extraction commands in the attempt.
- The complete inline launch command must be idempotent: atomic mkdir claim elects one launcher; existing matching done returns immediately; existing process may be reattached ONLY when ownership metadata exactly matches runIdentity, sourceCommit, pid, processGroupId, and OS processStartId (for Linux, /proc/<pid>/stat start time). A PID alone is never identity. On mismatch, publish orphan/crash without signaling that process.
- Training must enforce C.maxTimeSeconds itself (timeout/scheduler wall-time) and terminate its verified process group. Publish terminal metadata atomically via done.json.tmp -> done.json, including schemaVersion, runIdentity, sourceCommit, exitCode, timedOut, outcome, timestamps and logPath.
- The command returned to the main conversation covers sync/claim/start-or-attach/wait-for-this-identity-done and exits only after done.json exists. Remote control stays inline; do not create launcher/awaiter/extractor helper scripts.
- Only the MAIN CONVERSATION executes launch.command using Bash(run_in_background=true). The completion notification then causes a separate finalize invocation.
`

function promptHeader() {
  return `Autoresearch segmented state machine for ${C.project}, action=${action}, runId=${runId}.\n${stateProtocol}\n${worktreeProtocol}\n${launchProtocol}`
}

async function runInit() {
  phase('Initialize')
  return agent(`${promptHeader()}
Initialize or idempotently reopen this run.
1. Verify the repository, environment/data (${C.verifyData}), and resolved configuration.
2. Refuse a bare repository. Record the current committed HEAD as initialCommit; do not copy uncommitted main-worktree changes.
3. Create/validate the state directory and worktree root. Initialize schemaVersion=1 state with phase="baseline_needed", revision=1, baseline retry cap=${C.baselineRetries}, maxExperiments=${C.maxExperiments}, and a canonical fingerprint of the resolved C object.
4. Create or validate the detached baseline worktree. Create results.tsv as a materialized view header in the state directory.
5. If this run already exists with the same fingerprint, return its current state without side effects. If fingerprint differs, return failed.
Return the action result. init never returns a launch contract.`, {schema: ACTION_RESULT_SCHEMA})
}

async function inspectForPrepare() {
  return agent(`${promptHeader()}
Read and validate state.json only; do not modify code, worktrees, state, or remote jobs.
Determine whether prepare should: (a) return an existing active prepared/in-flight launch contract idempotently, (b) prepare baseline, (c) reserve/resume the next experiment (including an existing phase="experiment_planning" reservation), or (d) mark complete at the experiment cap.
Return JSON with mode (existing|baseline|experiment|complete|failed), phase, revision, and active/current best/history details needed by the next short agent.`, {
    schema: {
      type: 'object',
      properties: {
        mode: {type: 'string', enum: ['existing', 'baseline', 'experiment', 'complete', 'failed']},
        phase: {type: 'string'},
        revision: {type: 'number'},
        context: {type: 'object'},
      },
      required: ['mode', 'phase', 'revision', 'context'],
    },
  })
}

async function runPrepare() {
  phase('Prepare')
  const inspect = await inspectForPrepare()
  if (!inspect) throw new Error('prepare inspection agent returned no result')

  if (inspect.mode === 'complete') {
    return agent(`${promptHeader()}\nState is at the experiment cap. Atomically set phase="complete" if needed and return status=complete, nextAction=null.`, {schema: ACTION_RESULT_SCHEMA})
  }
  if (inspect.mode === 'failed') {
    return agent(`${promptHeader()}\nReturn the validated failure from state without destructive recovery or a launch contract.`, {schema: ACTION_RESULT_SCHEMA})
  }
  if (inspect.mode === 'existing') {
    return agent(`${promptHeader()}
Return the SAME persisted active attempt and launch contract from state. Do not create a worktree, attempt, commit or remote job. nextAction="launch_in_main_session".`, {schema: ACTION_RESULT_SCHEMA})
  }
  if (inspect.mode === 'baseline') {
    return agent(`${promptHeader()}
Prepare baseline only; DO NOT launch or await it.
1. Validate/create the detached baseline worktree from initialCommit.
2. Generate the next deterministic baseline attempt identity and unique remote attempt directory.
3. Deterministically substitute the fixed tokens in C.launchTemplate, C.extractCommand and C.extraExtract for that exact identity/initialCommit/worktree/remote paths. Reject missing/duplicate required tokens and all leftovers. The launch command must satisfy the launch protocol and run the unmodified baseline command: ${C.trainCommand}
4. Atomically persist active lifecycle="prepared", phase="baseline_prepared", and the fully resolved launch + extraction contracts.
5. Return status=waiting, nextAction="launch_in_main_session", and launch.`, {schema: ACTION_RESULT_SCHEMA})
  }

  const reservation = await agent(`${promptHeader()}
Atomically reserve exactly ONE experiment BEFORE any branch/worktree/edit/commit side effect.
Validated state context: ${JSON.stringify(inspect.context)}
1. If state already contains an unfinished planning reservation, validate and return that SAME {experimentNumber, parentCommit, branch, worktree}; do not allocate another number.
2. Otherwise reserve state.nextExperimentNumber, parentCommit=state.best.commit, the deterministic branch/worktree paths, lifecycle="planning", phase="experiment_planning"; atomically persist and increment revision. Do NOT create the worktree or modify code in this step.
3. Return the persisted reservation.`, {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        experimentNumber: {type: 'number'},
        parentCommit: {type: 'string'},
        branch: {type: 'string'},
        worktree: {type: 'string'},
      },
      required: ['experimentNumber', 'parentCommit', 'branch', 'worktree'],
    },
  })
  if (!reservation) throw new Error('experiment reservation returned no result; retry prepare to recover it from state')

  const plan = await agent(`${promptHeader()}
Plan and implement exactly ONE experiment in the PERSISTED reservation; DO NOT launch or await training.
Reservation (authoritative; retry MUST reuse it): ${JSON.stringify(reservation)}
Current validated state context: ${JSON.stringify(inspect.context)}
Focus: ${C.focus}
Metric: ${C.metric} (${C.direction} is better), noise floor=${C.noiseFloor}.
Simplicity: ${C.simplicityGuide}; max changed lines guidance=${C.maxLines}.
All prior results are in state.results; read them before choosing. Seed ideas: ${JSON.stringify(C.ideas)}.
1. Create or validate the RESERVED branch/worktree from reservation.parentCommit. On retry, inspect the reserved worktree first: if it already has exactly one valid candidate commit descended from parentCommit, recover and return it instead of planning/committing again.
2. Pick an untried idea using the full history only when the reservation has no recoverable candidate. Modify ONLY ${JSON.stringify(C.trainScope)}; never modify ${JSON.stringify(C.prepareScope)}.
3. Validate changed paths and simplicity. Stage ONLY the explicit validated paths and commit the candidate.
4. Return idea, files, branch, worktree, parentCommit, candidateCommit, analysis and any experiment-specific command substitutions needed by C.launchTemplate.`, {
    schema: {
      type: 'object',
      properties: {
        idea: {type: 'string'},
        files: {type: 'array', items: {type: 'string'}},
        branch: {type: 'string'},
        worktree: {type: 'string'},
        parentCommit: {type: 'string'},
        candidateCommit: {type: 'string'},
        analysis: {type: 'string'},
        substitutions: {type: 'object'},
      },
      required: ['idea', 'files', 'branch', 'worktree', 'parentCommit', 'candidateCommit', 'analysis', 'substitutions'],
    },
  })
  if (!plan) throw new Error('plan agent returned no result; retry prepare to reconcile the reserved worktree')

  return agent(`${promptHeader()}
Persist and hand off the already-created candidate; DO NOT launch or await training.
Validated persisted reservation: ${JSON.stringify(reservation)}
Plan result: ${JSON.stringify(plan)}
1. Re-verify candidateCommit belongs to the RESERVED run worktree/branch, descends from reservation.parentCommit, and its changed paths exactly match the validated allowlist.
2. Generate a deterministic attemptId bound to reservation.experimentNumber + candidateCommit + attempt number.
3. Deterministically substitute the fixed launch/extraction tokens with the exact worktree, candidate commit, attempt identity, unique remote directory and validated experiment substitutions. Reject missing/duplicate required tokens and all leftovers. Launch template: ${C.launchTemplate}; extraction: ${C.extractCommand}; secondary extraction: ${C.extraExtract}.
4. Atomically transition the RESERVED experiment to active lifecycle="prepared", phase="experiment_prepared", advance nextExperimentNumber exactly once if not already advanced, and save both fully resolved launch + extraction contracts.
5. Return status=waiting, nextAction="launch_in_main_session", and launch. A retry must return this same contract.`, {schema: ACTION_RESULT_SCHEMA})
}

async function runMarkStarted() {
  phase('Status')
  const attemptId = INPUT.attemptId
  const taskId = INPUT.taskId || null
  if (typeof attemptId !== 'string' || !attemptId) throw new Error('mark_started requires attemptId')
  return agent(`${promptHeader()}
Idempotently mark attemptId=${attemptId} as in_flight and record main-session background task id=${taskId} for audit. Exact transitions: matching active prepared -> in_flight; matching active in_flight -> return unchanged; matching already-finalized attempt -> return its saved state/result; any other attempt mismatch -> failed without mutation. Never use taskId as the run identity. Do not launch, wait, poll or alter worktrees. Return nextAction="finalize".`, {schema: ACTION_RESULT_SCHEMA})
}

async function runFinalize() {
  phase('Finalize')
  const attemptId = INPUT.attemptId
  if (typeof attemptId !== 'string' || !attemptId) throw new Error('finalize requires attemptId')
  return agent(`${promptHeader()}
Finalize active attemptId=${attemptId}; this is a SHORT post-training action. Do not wait, poll, launch or retry training.
1. FIRST look up state.results by attemptId. If already finalized, return its saved result idempotently even though state.active is now null. Only if no saved result exists, require attemptId === state.active.attemptId.
2. Read the identity-bound done.json once. If absent, return status=waiting, nextAction="finalize", without changing state. Reject mismatched runIdentity/sourceCommit/process ownership metadata.
3. Nonzero exit, timeout or orphan => crash/discard without extraction. For a nominally successful run, execute the PERSISTED resolved extraction contracts for this attempt (never re-substitute current config); extraction failure, missing/non-numeric metric, or numeric metric equal to C.crashMetric (${C.crashMetric}) => crash/discard before any ranking.
4. BASELINE SPECIAL CASE: a successful baseline unconditionally establishes best={commit: state.initialCommit, metric, attemptId, memoryGb}; it does not need to improve over a prior best. Only baseline crashes use baseline retry-cap transitions.
5. EXPERIMENT CASE ONLY: compare against state.best using direction=${C.direction}, noiseFloor=${C.noiseFloor}, and secondary expectations=${JSON.stringify(C.secondary)}. Keep only a meaningful primary improvement without critical secondary degradation; otherwise discard. Recommend human review in analysis text when secondary evidence is concerning, but do not block the state machine.
6. Experiment keep advances best to candidateCommit/metric. Discard/crash leaves best unchanged. Do not rewrite candidate branch/worktree.
7. Insert exactly one result keyed by attemptId, clear active, set phase to ready/complete (or baseline_needed after retryable baseline crash, failed after retry cap), atomically write state, and rebuild results.tsv from state.results.
8. Return the saved result and nextAction="prepare" unless complete/failed.`, {schema: ACTION_RESULT_SCHEMA})
}

async function runStatus() {
  phase('Status')
  return agent(`${promptHeader()}
Read-only reconcile this run. Validate state and inspect the active attempt's identity-bound claim/pid/done once; do not wait, poll, launch, kill, modify code or change state except to report an already-published terminal done record.
Return: finalize if matching done exists; launch_in_main_session with the SAME persisted launch contract if prepared or a live claim needs reattachment; prepare if ready/baseline_needed; null if complete/failed.`, {schema: ACTION_RESULT_SCHEMA})
}

async function runCleanup() {
  phase('Cleanup')
  const scope = INPUT.cleanupScope || 'discarded'
  if (!['discarded', 'all_finalized'].includes(scope)) throw new Error('cleanupScope must be discarded or all_finalized')
  return agent(`${promptHeader()}
Perform safe cleanup scope=${scope}.
1. Refuse cleanup when state.active exists or any owned attempt is in flight.
2. Enumerate only worktrees recorded in this run's state and verify ownership with git worktree list --porcelain.
3. Remove only finalized CLEAN worktrees allowed by scope using normal git worktree remove. Skip and report dirty/mismatched paths. Do not force.
4. Do NOT run repository-wide git worktree prune: it can mutate unrelated sessions' metadata. Retain all branches, state.json, results.tsv and remote artifacts.
5. Record cleanup audit atomically and return the unchanged research phase/nextAction.`, {schema: ACTION_RESULT_SCHEMA})
}

let result
if (action === 'init') result = await runInit()
else if (action === 'prepare') result = await runPrepare()
else if (action === 'mark_started') result = await runMarkStarted()
else if (action === 'finalize') result = await runFinalize()
else if (action === 'status') result = await runStatus()
else result = await runCleanup()

if (!result) throw new Error(`${action} agent returned no result; state was not assumed to advance`)
return result

/* Template variables
{PROJECT_NAME}: string
{research_focus}: string
{max_experiments}: bare number
{primary_metric}: string
{best_direction}: lowest | highest
{noise_floor}: bare number
{complex_code_lines}: bare number
{simplicity_threshold_guidance}: escaped string
{train_command}: escaped string
{train_command_with_logging}: escaped complete idempotent inline launch/attach/wait command template
{metric_extract_command}: escaped string
{additional_metric_extract_commands}: escaped string
{budget_description}: escaped string
{max_duration_seconds}: bare integer
{data_verification_steps}: escaped string
{crash_value}: bare number
{baseline_retry_cap}: bare integer
{remote_run_root}: escaped persistent path (or local run root)
{research_ideas_json}: JS array
{train_scope_list_json}: JS array
{prepare_scope_list_json}: JS array
{secondary_metrics_json}: JS object
*/
