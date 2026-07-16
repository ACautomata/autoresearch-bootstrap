---
name: autoresearch-bootstrap
description: >
  Bootstrap autonomous ML research on any project. Explores the codebase, classifies
  directories into "prepare.py scope" (fixed infrastructure — data, metrics, callbacks)
  vs "train.py scope" (modifiable — models, training, losses, optimizers), then assembles
  a SEGMENTED, RESUMABLE Claude Code workflow tailored to the user's intent for THIS run
  and drives it inline via the Workflow tool — no workflow/control/results files are
  written into the target project's tracked paths (no .claude/workflows/ file); The Workflow runs only short agents; long training is
  launched and awaited by the MAIN CONVERSATION via Bash(run_in_background=true); each
  baseline/experiment uses its own git worktree and no git reset --hard is ever issued.
  Adapted from karpathy/autoresearch. Use when (1) user wants to set up autonomous
  research on an ML project, (2) user mentions "autoresearch" or "research workflow" in
  context of their project, (3) user wants to identify which code to modify vs keep fixed
  for experimentation. Works on any ML project regardless of framework.
---

# Autoresearch Bootstrap

Assemble a **segmented, resumable** Claude Code research loop on any ML project, following the karpathy/autoresearch pattern: fixed infrastructure (prepare.py scope) + modifiable training code (train.py scope) + automated experiment loop. The workflow is built fresh for each run from the user's stated intent and run inline via the Workflow tool — it is never written into the target project.

## Why segmented

A single long-running Workflow that launches a 90–150 minute training run inside a `Run` agent does **not** work: `Bash(run_in_background=true)` returns a task id immediately, a short-lived agent has no cross-turn join/barrier to await that task, and the agent is forced to return "still running", which makes the loop advance into the next experiment while the previous one still holds the GPUs. The Analyze-time `git reset --hard` is also blocked by safety classifiers.

So the control plane is split:

- **The Workflow** is invoked repeatedly with `args.action`. Each invocation runs only SHORT agents (plan / finalize / status / cleanup) and **never** launches or awaits training.
- **The main conversation** owns the long training lifetime via its own `Bash(command=launch.command, run_in_background=true)`. The harness completion notification is the only join primitive.
- **Each baseline / experiment uses its own git worktree.** keep/discard are expressed by choosing the next `best` commit — the shared checkout is never moved and no `git reset --hard` is ever issued.

## Phase 1 — Explore

**Read every relevant file. Do not skim.**

1. **Structure**: Glob all Python files. Identify source root, entry points (train/eval), config system (Hydra/argparse/dataclasses).
2. **Entry points**: Read training and eval entry points fully. Trace the import chain.
3. **Data flow**: raw data → preprocessing → model → loss → metric. Read each link.
4. **Config system**: Read config files and how they feed into code.
5. **Docs**: Read README.md, CLAUDE.md, AGENTS.md, pyproject.toml for context.

## Phase 2 — Classify

Assign every source directory/file to one of two scopes. **Read [classification-guide.md](references/classification-guide.md)** for heuristics. Quick reference:

| Category | Scope |
|---|---|
| Data loading, transforms, tokenizers | prepare.py (fixed) |
| Evaluation metrics, test harness | prepare.py (fixed) |
| Callbacks, logging, checkpointing | prepare.py (fixed) |
| Type definitions, protocols, utilities | prepare.py (fixed) |
| Model architectures (encoders, decoders, transformers) | train.py (modifiable) |
| Training tasks/steps, training-loop logic | train.py (modifiable) |
| Loss functions | train.py (modifiable) |
| Optimizer/LR scheduler construction | train.py (modifiable) |
| Model factories, runtime composition | train.py (modifiable) |
| Training entry point | train.py (modifiable) |

Then identify, for the generated workflow:
- **Primary metric** — what number to optimize, which direction is better
- **Training command** — exact shell command to run training
- **Validation cadence** — how often it validates today and roughly what one pass costs (drives the last-epoch tradeoff in Phase 3)
- **Budget** — epochs / steps / time limit
- **Output format** — what the script prints at end-of-run, and a concrete grep that extracts the primary metric (trace the print/log statements — no vague descriptions), plus a grep per secondary metric

**Multi-metric discipline — ask the user.** Before Phase 3:
1. Have the user declare the **metrics** available in the training output (e.g. val_loss, train_loss, grad_norm, epoch_time, peak VRAM, FID) and designate **one** as the primary target.
2. State the principle: **"when a metric becomes the optimization target, it loses objectivity."** A single metric can be hacked (lower val_loss by overfitting, inflate RankMe by shrinking dimension). Cross-reference secondary metrics to confirm a gain is genuine.
3. Record all declared metrics; secondary ones become `{secondary_metrics_json}` with an expectation each (`stable` / `decrease` / `increase` / `lower_better`).

## Phase 3 — Assemble the action template (inline — never written to the project)

Phases 1–2 established project-level facts. This phase captures what the user wants **this run** and assembles a ready-to-run, **re-entrant action template** from it. The assembled workflow **script** is never written into the target project's tracked paths — its only script copy is the Workflow tool's session-directory persistence. Research control state and results are deliberately persisted under the repository's Git common dir (outside every worktree/index) so the run can resume safely.

**Step 1 — Capture this run's intent (ask the user).** This is what makes each invocation bespoke:
1. **Research focus** → `{research_focus}`: what should this run concentrate on?
2. **Experiment cap** → `{max_experiments}`: how many experiments this run?
3. **Seed ideas**: any specific ideas to try first? Prepend them to `{research_ideas_json}`.

**Step 2 — Fill the config.** Read [workflow-template.js](references/workflow-template.js) — it is the *blueprint* (an `args.action`-dispatched state machine: `init`/`prepare`/`mark_started`/`finalize`/`status`/`cleanup`), not a file to save. Fill every `{PLACEHOLDER}` in the `C` object from Phases 1–2 + Step 1. The template's trailing "Template variables" comment documents each field. Knobs needing explicit user confirmation:

- **Simplicity threshold** (`{noise_floor}`, `{complex_code_lines}`): propose values from metric scale and codebase size, then confirm.
- **Validation cadence** (`{train_command}`): per-epoch validation is usually the biggest wall-clock sink, because keep/discard needs only ONE ranking number per experiment. Surface this tradeoff and ask for a command that validates **only on the last epoch**. Point `{metric_extract_command}` at the single end-of-run validation line so a run that never validated yields nothing and is treated as discard rather than a bogus metric.
- **Crash sentinel** (`{crash_value}`): a metric value meaning "this run crashed".
- **maxTime** (`{max_duration_seconds}`): a bare integer of seconds. It must be enforced by the training process itself (embedded `timeout`/scheduler wall-time) — NOT by a Workflow agent watching a clock.

**Remote-host training — keep control inline (no staged helpers).** `{train_command_with_logging}` and `{metric_extract_command}` must be the *complete* inline ssh commands — not pointers to scripts staged on the remote. They use the fixed per-attempt tokens `__RUN_ID__`, `__ATTEMPT_ID__`, `__SOURCE_COMMIT__`, `__WORKTREE__`, `__REMOTE_DIR__`, `__LOG_PATH__`, `__DONE_PATH__`, `__OWNER_PATH__`, and `__PID_PATH__`; the template rejects a launch contract missing any token or ownership marker. The launch command embeds its own kill-timer + identity-bound `done.json` so the run is self-terminating, idempotent (atomic `claim/` elects one launcher; reattachment requires an exact ownership tuple: runIdentity, sourceCommit, pid, processGroupId and OS processStartId — PID alone is never identity) and survives ssh drops. On ownership mismatch, record orphan/crash without signaling that process. Do NOT have any agent write launcher/awaiter/extractor helper scripts to the remote — the workflow script + the main conversation own all of it (see Rules: Inline control).

**Step 3 — Assemble the script string.** Substitute every placeholder with its filled value into one JS string held in context. Sanity-check it parses: number placeholders are bare numbers (no quotes), and the `/* ... */ []` / `/* ... */ {}` sentinels are real JS arrays/objects. Carry the string into Phase 4 — do **not** write it into the project.

## Phase 4 — Drive the segmented loop

The assembled template is invoked repeatedly. The main conversation drives it; a Workflow agent never launches or awaits training.

1. **`init`** — `Workflow({script, args:{action:"init", runId}})`. Creates/validates state, baseline worktree, and config fingerprint. No launch.
2. **`prepare`** — returns a deterministic `launch` contract (`command`, `cwd`, `attemptId`, `logPath`, `donePath`, `maxTimeSeconds`) and `nextAction="launch_in_main_session"`. Repeated `prepare` returns the **same** contract idempotently.
3. **Launch in the main conversation** — execute `Bash(command=launch.command, run_in_background=true)`. The harness sends ONE completion notification when the identity-bound `done.json` appears. No Workflow agent polls.
4. **`mark_started`** — `Workflow({script, args:{action:"mark_started", runId, attemptId, taskId}})` right after launching, to record the background task id for audit (not for correctness).
5. **`finalize`** — on the completion notification. A SHORT agent reads `done.json`, extracts metrics, decides keep/discard/crash, atomically updates state + rebuilds `results.tsv`, and returns `nextAction="prepare"` (or `complete`/`failed`). A repeated `finalize` for the same attempt returns its saved result.
6. **Loop** back to `prepare` until `complete`.

**Resume after the main conversation exits.** Re-assemble the template (config fingerprint must match) and call `status` first:
- matching `done.json` exists → `finalize`;
- claim/pid still alive → re-attach the SAME persisted await contract via a fresh `run_in_background`;
- still `prepared` → re-run the SAME launch contract;
- `ready`/`baseline_needed` → `prepare`;
- `complete`/`failed` → report.
Do not rely on Workflow runtime `resumeFromRunId` as research state — the authority is `state.json` + the remote attempt identity.

Where state lives (all under the project's Git common dir, never inside a worktree):

```
$(git rev-parse --git-common-dir)/autoresearch/<runId>/{state.json,state.json.prev,results.tsv}
```

Worktrees live beside the repo:

```
<repo-parent>/.autoresearch-worktrees/<repo>-<runId>/{baseline,exp-0001,…}
```

## Rules

- **Project-agnostic**: works on any ML project.
- **Read before classifying**: never guess a file's role — read it.
- **All placeholders filled**: no template boilerplate in the assembled workflow.
- **Never write the workflow into the target project**: assemble inline and run via the Workflow tool (inline `script`). The only on-disk copy is the Workflow tool's own session-directory persistence — never `.claude/workflows/` in the repo.
- **Segmented control plane**: the Workflow is invoked per `args.action` and runs only SHORT agents. Workflow agents NEVER launch training, call background Bash, sleep through training, poll for completion, or wait for `done`. `prepare` returns a launch contract; the MAIN CONVERSATION runs `Bash(run_in_background=true)`; the completion notification drives `finalize`.
- **Per-experiment worktrees**: baseline and each experiment get an isolated git worktree/branch. The user's main checkout is never moved. keep advances `best` to the candidate commit; discard/crash leaves `best` unchanged and the candidate branch/worktree retained for audit. **Never** issue `git reset --hard`, `git clean -fd`, or whole-tree `git add -A` from a Workflow agent — stage only the explicit validated train-scope path list.
- **Resumable + idempotent**: `state.json` (schemaVersion=1) in the Git common dir is the sole authority; updates are atomic (tmp + rename, `state.json.prev` retained); `results.tsv` is rebuilt from `state.results` after each finalized result. A repeated action for the same attempt returns the same identity/launch/result and creates no duplicate training or result rows. Config fingerprint mismatch ⇒ fail rather than overwrite.
- **Inline control — no staged remote helpers**: when training runs on a remote host (ssh), all control (launch, kill-bound, await, extraction) lives INLINE in the workflow config as complete ssh commands with the kill-timer and an identity-bound `done.json` embedded. Do NOT stage helper scripts on the remote.
- **Tailor per invocation**: capture the run's focus, cap, and seed ideas.
- **Concrete commands + unambiguous metric**: exact number, exact direction, exact extraction command.
- **Valid JS output**: numbers bare, arrays/objects as JS literals.
