// Autoresearch Workflow Blueprint
//
// This is the structural blueprint for the workflow. The autoresearch-bootstrap skill
// fills the {PLACEHOLDER} values (discovered in Phase 1-2 + the run's intent in Phase 3)
// and assembles the result into a single JS string, then runs it INLINE via the Workflow
// tool. It is NEVER written into the target project — no .claude/workflows/ file. The
// Workflow tool persists the script to the session directory (out of the repo); that is
// the only on-disk copy, and it enables resume.

export const meta = {
  name: '{PROJECT_NAME}-autoresearch',
  description: 'Autonomous ML research loop for {PROJECT_NAME}',
  phases: [
    { title: 'Setup' },
    { title: 'Baseline' },
    { title: 'Plan' },
    { title: 'Run' },
    { title: 'Analyze' },
  ],
}

/* ═══════════════════════════════════════════════════════════════
   Project configuration — filled by autoresearch-bootstrap skill
   ═══════════════════════════════════════════════════════════════ */
const C = {
  project:         '{PROJECT_NAME}',
  tag:             '{today_short_tag}',
  focus:           '{research_focus}',      // what this run concentrates on
  maxExperiments:  {max_experiments},       // number — hard cap on experiments this run
  metric:          '{primary_metric}',
  direction:       '{best_direction}',      // "lowest" or "highest"
  noiseFloor:      {noise_floor},           // number — smallest meaningful improvement
  maxLines:        {complex_code_lines},    // number — simplicity threshold in LoC
  simplicityGuide: '{simplicity_threshold_guidance}',  // prose context for thresholds
  trainCmd:        '{train_command}',
  trainLog:        '{train_command_with_logging}',
  extractCmd:      '{metric_extract_command}',
  extraExtract:    '{additional_metric_extract_commands}',
  budget:          '{budget_description}',
  maxTime:         '{max_duration}',   // hard kill bound - the run process is killed at this deadline
  verifyData:      '{data_verification_steps}',
  crashMetric:     {crash_value},           // number — metric sentinel for crashed runs
  ideas:           /* {research_ideas_json} */[],
  trainScope:      /* {train_scope_list_json} */[],
  prepareScope:    /* {prepare_scope_list_json} */[],
  secondary:       /* {secondary_metrics_json} */{},
}

const BETTER = (cur, best) =>
  C.direction === 'lowest' ? cur < best : cur > best

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    metric:   { type: "number" },
    memory:   { type: "number" },
    status:   { type: "string", enum: ["keep", "discard", "crash"] },
  },
  required: ["metric", "memory", "status"],
}

// What a Run agent reports: the experiment process ended (finished or killed at the maxTime
// deadline). No metric, no keep/discard - that is the Evaluate agent's job. This split keeps
// the experiment lifecycle (a bounded background process) decoupled from the agent lifecycle
// (short launch/wait + short evaluate), so no reasoning agent is held alive for the training.
const RUN_SCHEMA = {
  type: "object",
  properties: {
    exit_code: { type: "number" },
    timed_out: { type: "boolean" },
    log:       { type: "string" },
  },
  required: ["timed_out", "log"],
}

// What the Analyze agent reports: metrics + keep/discard decision + a short analysis text that gets
// stacked into `history` and fed to the next loop's Plan agent. This agent also owns git maintenance
// (rollback on discard/crash) and the results.tsv append - folding the old reset/record steps in, so
// the experiment loop is exactly three agents: Plan, Run, Analyze.
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    metric:   { type: "number" },
    memory:   { type: "number" },
    status:   { type: "string", enum: ["keep", "discard", "crash"] },
    analysis: { type: "string" },
  },
  required: ["metric", "memory", "status", "analysis"],
}

/* ── Setup ──────────────────────────────────────────────────── */
phase('Setup')
await agent(`Set up autonomous research for ${C.project}:
1. Create branch: git checkout -b autoresearch/${C.tag}
2. Verify data: ${C.verifyData}
3. Create results.tsv with header: commit\t${C.metric}\tmemory_gb\tstatus\tdescription
Report ready status.`)

/* ── Baseline ───────────────────────────────────────────────── */
phase('Baseline')
// Experiment lifecycle: launch baseline as a self-terminating background process, await ONE
// completion notification, then hand off. maxTime is a KILL bound (the process dies at the
// deadline) - not a "keep waiting and flag" threshold. The launcher/awaiter carries no ML
// reasoning; extraction is the next agent's job, so no reasoning agent spans the training.
const blRun = await agent(`Run baseline training for ${C.project} (experiment lifecycle - bounded, self-terminating):
1. Launch ${C.trainLog} as a KILL-BOUNDED background process that dies at the ${C.maxTime} deadline. C.trainLog is ALREADY the complete, deadline-bounded command — for a remote host it includes the ssh + the kill-timer (e.g. timeout <seconds>) + a completion flag, all inline — so launch it VERBATIM via Bash run_in_background; do NOT wrap it further, improvise a separate timeout wrapper, or stage/invoke helper scripts on the remote host. The run must own its own deadline - do NOT watch a clock to decide whether to kill it (the process self-terminates at the deadline).
2. Start it via Bash run_in_background. For a local launch the task completing IS the process ending (finished or killed-at-deadline); for a remote fire-and-forget launch, start a single run_in_background until-loop (until <done-flag>; do sleep 60; done) that exits when the remote run finishes or is killed. You get exactly ONE completion notification - never poll, never spawn check-agents, never chunk the wait into foreground retries.
3. Report whether the run was killed at the ${C.maxTime} deadline (timed_out), the exit code, and the log path. Do NOT extract metrics or decide keep/discard - that is the next step's job.`, {schema: RUN_SCHEMA})

// Agent lifecycle (short): the run is dead; now extract + reason. This agent does not span training,
// and maxTime was already enforced by the run process itself (killed-at-deadline -> crash below).
const bl = await agent(`Evaluate the finished baseline run for ${C.project}:
Run outcome: ${blRun.timed_out ? 'killed at the ' + C.maxTime + ' deadline (timed out) - treat as crash' : 'finished'}. Log: ${blRun.log}.
1. Extract primary: ${C.extractCmd}
2. Extract secondary: ${C.extraExtract}
3. If the run was killed at the deadline (timed_out) or no metric is found, status=crash - a killed/incomplete run yields nothing, never a bogus low metric.
Report metric, memory, and status.`, {schema: RESULT_SCHEMA})

log(`Baseline ${C.metric}=${bl.metric}, memory=${bl.memory}GB`)

/* ── Experiment Loop ────────────────────────────────────────── */
// Three agents per iteration:
//   Plan   - stacks ALL prior results (history) -> picks/invents the next idea, modifies train.py-scope
//            code, snapshots pre-experiment HEAD for rollback.
//   Run    - commits the experiment, launches the self-terminating training (kill-bounded by maxTime via
//            the timeout embedded in C.trainLog), awaits ONE completion notification, safety-net kills
//            anything still alive past the deadline. No ML reasoning, no extraction.
//   Analyze- extracts metrics, decides keep/discard, MAINTAINS GIT (rollback on discard/crash), appends
//            results.tsv, writes a short analysis stacked into the next Plan prompt.
// `history` accumulates every experiment's outcome so each Plan agent sees the full set of prior results,
// not just the static seed-idea list. Seeded with the baseline (experiment #0).
let best = bl.metric
let n = 0
const MAX = C.maxExperiments
const history = [{
  n: 0,
  idea: 'baseline',
  metric: bl.metric,
  status: bl.status,
  analysis: `Baseline ${C.metric}=${bl.metric}, memory=${bl.memory}GB. Reference point to beat.`,
}]

while ((budget.total ? budget.remaining() > 50000 : n < MAX) && n < MAX) {
  n++

  /* ── Agent 1: exp plan agent ── */
  phase('Plan')
  const plan = await agent(`Plan experiment #${n} for ${C.project}.
Run focus: ${C.focus}
Best ${C.metric}=${best} (${C.direction} is better). Noise floor: ${C.noiseFloor}.
${C.simplicityGuide}

ALL previous experiment results (stacked - decide the next direction from this full history, not just the seed ideas):
${history.map(h => `  #${h.n} [${h.status}] ${C.metric}=${h.metric}  idea="${h.idea}"  -> ${h.analysis}`).join('\n')}

Seed ideas (run the early ones first if still untried):
${C.ideas.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Your job:
1. Snapshot current HEAD for rollback: run git rev-parse HEAD and record the hash as preCommit.
2. Decide the next direction from the full history above (and the seed ideas). Pick an untried idea or invent a new one from patterns so far - do not repeat a discarded idea unchanged.
3. Modify ONLY train.py scope files: ${JSON.stringify(C.trainScope)}. Do NOT touch prepare.py scope: ${JSON.stringify(C.prepareScope)}.
Report the idea, the files you modified, and the preCommit hash.`, {
    label: `plan-${n}`,
    schema: {
      type: "object",
      properties: {
        idea:      { type: "string" },
        files:     { type: "array", items: { type: "string" } },
        preCommit: { type: "string" },
      },
      required: ["idea", "files", "preCommit"],
    },
  })

  log(`#${n} plan: ${plan.idea}`)
  const safeIdeaForCommit = (
    plan.idea
      .replace(/[^a-zA-Z0-9 _]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'experiment'
  )

  /* ── Agent 2: exp run/watcher agent ── */
  phase('Run')
  // Experiment lifecycle: commit, then launch the self-terminating training (kill-bounded by maxTime via
  // the timeout embedded in C.trainLog), await ONE completion notification, safety-net kill anything still
  // alive past the deadline. Minimal launcher/awaiter - no ML reasoning, no extraction - so no reasoning
  // agent is held alive for the training duration.
  const run = await agent(`Run + watch experiment #${n} training for ${C.project} (experiment lifecycle - bounded, self-terminating):
1. Commit the experiment: git add -A && printf '%s\n' "exp${n}: ${safeIdeaForCommit}" | git commit -F -
2. Launch ${C.trainLog} as a KILL-BOUNDED background process that dies at the ${C.maxTime} deadline. C.trainLog is ALREADY the complete, deadline-bounded command - for a remote host it includes the ssh + the kill-timer (e.g. timeout <seconds>) + a completion flag, all inline - so launch it VERBATIM via Bash run_in_background; do NOT wrap it further, improvise a separate timeout wrapper, or stage/invoke helper scripts on the remote host. The run must own its own deadline - it self-terminates at the deadline (killed-at-deadline), so do NOT watch a clock to decide whether to kill it.
3. Await exactly ONE completion notification: for a local launch the Bash run_in_background task ending IS the process ending (finished or killed-at-deadline); for a remote fire-and-forget launch, start a single run_in_background until-loop (until <done-flag>; do sleep 60; done) that exits when the remote run finishes or is killed. Never poll, never spawn check-agents, never chunk the wait into foreground retries.
4. Safety-net: if the process is somehow still alive past the ${C.maxTime} deadline (the embedded timeout failed to reap it), kill it directly now.
5. Report whether the run was killed at the ${C.maxTime} deadline (timed_out), the exit code, and the log path. Do NOT extract metrics or decide keep/discard - that is the Analyze agent's job.`, {
    label: `run-${n}`,
    schema: RUN_SCHEMA,
  })

  /* ── Agent 3: experiment result analysis agent ── */
  phase('Analyze')
  // Agent lifecycle (short): the run is dead; now extract + reason + decide + maintain git + record.
  // Does not span training, and maxTime was already enforced by the run process itself (killed-at-deadline
  // -> crash below). Does not launch or re-run training - one experiment = one bounded run.
  const res = await agent(`Analyze the finished run for experiment #${n} ("${plan.idea}") for ${C.project}:
Run outcome: ${run.timed_out ? 'killed at the ' + C.maxTime + ' deadline (timed out) - treat as crash' : 'finished'}. Log: ${run.log}.
1. Extract primary: ${C.extractCmd}
2. Extract secondary: ${C.extraExtract}
3. If the run was killed at the deadline (timed_out) or no metric is found, status=crash - a killed/incomplete run yields nothing, never a bogus low metric.
4. Compare with best=${best}. ${C.direction} is better.
5. Evaluate secondary metrics. The secondary metrics expectations are:
${Object.entries(C.secondary).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}
   Interpretation: "stable" = within ~10% of baseline; "decrease" = improved (same direction as primary); "increase" = higher is better even if primary goes down; "lower_better" = inverse of primary direction.
   If a critical secondary degrades significantly while primary improves, flag for human review instead of auto-keeping.
6. MAINTAIN GIT: if status=keep, leave the experiment commit in place. If status=discard or crash, roll back: git reset --hard ${plan.preCommit} (restores the pre-experiment state the Plan agent snapshotted).
7. Record: append ONE row to results.tsv (tab-separated) with these columns in order, using YOUR extracted/decided values: short HEAD hash, primary metric, memory in GB, status, idea. Example: printf '%s\t%s\t%s\t%s\t%s\n' "$(git rev-parse --short HEAD)" "<metric>" "<memory>" "<status>" "${plan.idea.slice(0, 80)}" >> results.tsv
8. Write a 1-2 sentence analysis for the NEXT loop's Plan agent: what worked / what didn't / what to try next. This is stacked into the next Plan prompt, so be concrete.
Report metric, memory, status, and the analysis text.`, {
    label: `analyze-${n}`,
    schema: ANALYSIS_SCHEMA,
  })

  // Stack this experiment into history so the next Plan agent sees the full set of prior results
  history.push({ n, idea: plan.idea, metric: res.metric, status: res.status, analysis: res.analysis })

  if (res.status === 'keep' && BETTER(res.metric, best)) {
    best = res.metric
    log(`KEPT: ${C.metric}=${best}`)
  } else {
    log(`${res.status.toUpperCase()}: ${C.metric}=${res.metric} (best=${best})`)
  }
}

log(`Done. ${n} experiments, best ${C.metric}=${best}`)
return { experiments: n, best, baseline: bl.metric }

/* ═══════════════════════════════════════════════════════════════
   Template Variable Reference
   ═══════════════════════════════════════════════════════════════

   | Placeholder                   | Type     | Source                         | Example                      |
   |-------------------------------|----------|--------------------------------|------------------------------|
   | {PROJECT_NAME}                | string   | Project name                   | maskgit-3d                   |
   | {today_short_tag}             | string   | Current date                   | may29                        |
   | {primary_metric}              | string   | Main evaluation metric          | val_loss, fid                |
   | {best_direction}              | string   | "lowest" or "highest"          | lowest                       |
   | {noise_floor}                 | number   | Smallest meaningful delta      | 0.001                        |
   | {complex_code_lines}          | number   | LoC simplicity threshold        | 20                           |
   | {simplicity_threshold_guidance} | string | Prose guidance for thresholds   | "For this project, typical run-to-run variance is ~0.001. A 0.001 improvement that adds 20 lines of hacky code is probably not worth it." |
   | {train_command}               | string   | How to launch training           | uv run train.py              |
   | {train_command_with_logging}  | string   | Training with log capture        | uv run train.py > run.log 2>&1 |
   | {metric_extract_command}      | string   | Shell command to extract metric  | grep "^val_loss:" run.log    |
   | {additional_metric_extract_commands} | string | Extra grep commands         | grep "^peak_vram_mb:" run.log|
   | {budget_description}          | string   | Training budget                  | 5 epochs                     |
   | {max_duration}                | string   | Hard kill bound per experiment (run is killed at this deadline) | 10 minutes        |
   | {data_verification_steps}     | string   | How to verify data is ready       | Check data shards exist      |
   | {crash_value}                 | number   | Metric sentinel for crashes      | 999.0                        |
   | {research_ideas_json}         | JSON[]   | Array of idea strings            | ["Increase LR", "Add dropout"]|
   | {research_focus}              | string   | This run's concentration          | "reduce peak memory"          |
   | {max_experiments}             | number   | Hard cap on experiments this run  | 20                            |
   | {train_scope_list_json}       | JSON[]   | Array of modifiable paths         | ["models/", "train.py"]      |
   | {prepare_scope_list_json}     | JSON[]   | Array of fixed paths             | ["data/", "metrics/"]        |
   | {secondary_metrics_json}      | JSON{}   | Object of metric → expectation   | {"grad_norm":"stable", "train_loss":"decrease"} |

   Secondary metric expectation values:
   - "stable"       = within ~10% of baseline
   - "decrease"     = lower is better (same direction as primary)
   - "increase"     = higher is better
   - "lower_better"  = inverse of primary direction
   - Any other string = use as-is as instruction text
*/