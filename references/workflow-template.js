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
    { title: 'Experiment' },
    { title: 'Run' },
    { title: 'Evaluate' },
    { title: 'Record' },
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
let best = bl.metric
let n = 0
const MAX = C.maxExperiments

while ((budget.total ? budget.remaining() > 50000 : n < MAX) && n < MAX) {
  n++

  // Snapshot git HEAD before experiment changes — used for rollback on discard/crash
  const preCommit = await agent('git rev-parse HEAD', {schema: {type: "object", properties: {head: {type: "string"}}, required: ["head"]}})

  phase('Experiment')
  const idea = await agent(`Experiment #${n} for ${C.project}.
Run focus: ${C.focus}
Best ${C.metric}=${best} (${C.direction} is better). Noise floor: ${C.noiseFloor}.
${C.simplicityGuide}

Research ideas:
${C.ideas.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Pick an untried idea or invent a new one based on patterns so far.
Only modify train.py scope files: ${JSON.stringify(C.trainScope)}
Do NOT touch prepare.py scope: ${JSON.stringify(C.prepareScope)}

Apply the change and report the idea and files modified.`, {
    label: `exp-${n}`,
    schema: {
      type: "object",
      properties: {
        idea:  { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["idea", "files"],
    },
  })

  log(`#${n}: ${idea.idea}`)
  const safeIdeaForCommit = (
    idea.idea
      .replace(/[^a-zA-Z0-9 _]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'experiment'
  )

  phase('Run')
  // Experiment lifecycle: commit the experiment, then launch it as a self-terminating background
  // process bounded by maxTime (KILL at deadline). This agent is a minimal launcher/awaiter -
  // no ML reasoning, no extraction - so no reasoning agent is held alive for the training duration.
  const run = await agent(`Run experiment #${n} training for ${C.project} (experiment lifecycle - bounded, self-terminating):
1. Commit the experiment: git add -A && printf '%s\n' "exp${n}: ${safeIdeaForCommit}" | git commit -F -
2. Launch ${C.trainLog} as a KILL-BOUNDED background process that dies at the ${C.maxTime} deadline. C.trainLog is ALREADY the complete, deadline-bounded command — for a remote host it includes the ssh + the kill-timer (e.g. timeout <seconds>) + a completion flag, all inline — so launch it VERBATIM via Bash run_in_background; do NOT wrap it further, improvise a separate timeout wrapper, or stage/invoke helper scripts on the remote host. The run must own its own deadline - do NOT watch a clock to decide whether to kill it (the process self-terminates at the deadline).
3. Start it via Bash run_in_background. For a local launch the task completing IS the process ending (finished or killed-at-deadline); for a remote fire-and-forget launch, start a single run_in_background until-loop (until <done-flag>; do sleep 60; done) that exits when the remote run finishes or is killed. You get exactly ONE completion notification - never poll, never spawn check-agents, never chunk the wait into foreground retries.
4. Report whether the run was killed at the ${C.maxTime} deadline (timed_out), the exit code, and the log path. Do NOT extract metrics or decide keep/discard - that is the next step's job.`, {
    label: `run-${n}`,
    schema: RUN_SCHEMA,
  })

  phase('Evaluate')
  // Agent lifecycle (short): the run is dead; now extract + reason + decide. This agent does not
  // span training, and maxTime was already enforced by the run process itself (killed-at-deadline
  // -> crash below). It does not launch or re-run training - one experiment = one bounded run.
  const res = await agent(`Evaluate the finished run for experiment #${n} ("${idea.idea}"):
Run outcome: ${run.timed_out ? 'killed at the ' + C.maxTime + ' deadline (timed out) - treat as crash' : 'finished'}. Log: ${run.log}.
1. Extract primary: ${C.extractCmd}
2. Extract secondary: ${C.extraExtract}
3. If the run was killed at the deadline (timed_out) or no metric is found, status=crash - a killed/incomplete run yields nothing, never a bogus low metric.
4. Compare with best=${best}. ${C.direction} is better.
5. Evaluate secondary metrics. The secondary metrics expectations are:
${Object.entries(C.secondary).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}
   Interpretation: "stable" = within ~10% of baseline; "decrease" = improved (same direction as primary); "increase" = higher is better even if primary goes down; "lower_better" = inverse of primary direction.
   If a critical secondary degrades significantly while primary improves, flag for human review instead of auto-keeping.
6. If discard/crash: DO NOT attempt git reset yourself - just report status=discard or status=crash and the metric value. The orchestrator will handle rollback.
Report metric, memory, and status.`, {
    label: `eval-${n}`,
    schema: RESULT_SCHEMA,
  })

  // Programmatic rollback if experiment was discarded or crashed
  // (belt-and-suspenders: protects against the Evaluate agent not self-resetting)
  if (res.status === 'discard' || res.status === 'crash') {
    await agent(`git reset --hard ${preCommit.head}`, {
      label: `reset-${n}`,
      schema: {type: "object", properties: {ok: {type: "boolean"}}, required: ["ok"]}
    })
  }

  phase('Record')
  await agent(`Record experiment #${n} results. Append one row to results.tsv (tab-separated):
   $(git rev-parse --short HEAD)\t${res.metric}\t${res.memory}\t${res.status}\t${idea.idea.slice(0, 80)}`, {
    label: `rec-${n}`,
  })

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