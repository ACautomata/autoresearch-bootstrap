---
name: autoresearch-bootstrap
description: >
  Bootstrap autonomous ML research on any project. Explores the codebase, classifies
  directories into "prepare.py scope" (fixed infrastructure — data, metrics, callbacks)
  vs "train.py scope" (modifiable — models, training, losses, optimizers), then assembles
  a Claude Code workflow tailored to the user's intent for THIS run and runs it inline via
  the Workflow tool — nothing is written into the target project (no .claude/workflows/
  file). Adapted from karpathy/autoresearch. Use when (1) user wants to set up autonomous
  research on an ML project, (2) user mentions "autoresearch" or "research workflow" in
  context of their project, (3) user wants to identify which code to modify vs keep fixed
  for experimentation. Works on any ML project regardless of framework.
---

# Autoresearch Bootstrap

Assemble a Claude Code workflow that runs autonomous ML research on any project, following the karpathy/autoresearch pattern: fixed infrastructure (prepare.py scope) + modifiable training code (train.py scope) + automated experiment loop. The workflow is built fresh for each run from the user's stated intent and run inline via the Workflow tool — it is never written into the target project.

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

## Phase 3 — Assemble the workflow (inline — never written to the project)

Phases 1–2 established project-level facts. This phase captures what the user wants **this run** and assembles a ready-to-run workflow from it. The assembled script runs inline via the Workflow tool and is never written into the target project — the only on-disk copy is the session-directory persistence the Workflow tool does itself (enables resume).

**Step 1 — Capture this run's intent (ask the user).** This is what makes each invocation bespoke:
1. **Research focus** → `{research_focus}`: what should this run concentrate on? (e.g. "reduce peak memory", "push val_loss down", "architectural changes only", "sweep losses".) Steers idea generation.
2. **Experiment cap** → `{max_experiments}`: how many experiments this run? Pick a number with the user — the loop hard-stops at this cap regardless of token budget.
3. **Seed ideas**: any specific ideas to try first? Prepend them to `{research_ideas_json}` so they run before invented ones.

**Step 2 — Fill the config.** Read [workflow-template.js](references/workflow-template.js) — it is the *blueprint* (Setup → Baseline → Experiment loop), not a file to save. Fill every `{PLACEHOLDER}` in the `C` object from Phases 1–2 + Step 1; the template's trailing "Template Variable Reference" comment documents each field. Three knobs need explicit user confirmation:

- **Simplicity threshold** (`{noise_floor}`, `{complex_code_lines}`): propose values from metric scale (val_loss ~1.0 → floor ~0.001; FID ~50 → floor ~0.5) and codebase size (small → ~10 lines; large → ~20), then confirm before writing.
- **Validation cadence** (`{train_command}`): per-epoch validation is usually the biggest wall-clock sink in the loop, because keep/revert needs only ONE ranking number per experiment — not a per-epoch curve. Surface this tradeoff and ask for a command that validates **only on the last epoch** (one val pass at the end). For fixed-epoch Lightning runs (`max_epochs = n_epochs`) this is typically `Trainer(check_val_every_n_epoch = n_epochs, num_sanity_val_steps = 0)`; for HF Trainer use `eval_strategy`; adapt for custom eval scripts. If the run can stop before the final epoch (max_steps / max_time / early stopping), the final validation won't fire — use an explicit post-training eval command instead. If the project has no knob to reduce val frequency, say so and leave `{train_command}` as the normal full-val command; don't invent a knob. Why last-epoch and not *no* validation: keep/revert needs a real metric to rank experiments, and one val pass at the end is the minimum that preserves it. Point `{metric_extract_command}` at the single end-of-run validation line so a run that never validated (early stop / crash) yields nothing and is treated as discard rather than a bogus low metric.
- **Crash sentinel** (`{crash_value}`): a metric value meaning "this run crashed" (e.g. `999.0` when direction is lowest).

**Remote-host training — keep control inline (no staged helpers).** If training runs over ssh (a remote GPU/DCU box), `{train_command_with_logging}` and `{metric_extract_command}` must be the *complete* inline ssh commands — not pointers to scripts staged on the remote. The launch command embeds its own kill-timer + completion flag so the run is self-terminating and survives ssh drops, e.g. `ssh <host> "nohup bash -c 'timeout <maxTime_seconds> <train_cmd> > run.log 2>&1; echo DONE_\$? > run.done' >/dev/null 2>&1 &"` (Run agent fires it via Bash `run_in_background`), then awaited by ONE inline loop `ssh <host> "until [ -f run.done ]; do sleep 60; done; cat run.done"` (also `run_in_background`, single completion notification). Metric extraction is likewise one inline `ssh <host> "awk ... run.log | metrics.csv"` command. Do NOT have `Setup` (or any agent) write launcher/awaiter/extractor helper scripts to the remote — the workflow script + the agents own all of it (see Rules: Inline control).

**Step 3 — Assemble the script string.** Substitute every placeholder with its filled value into one JS string held in context. Sanity-check it parses: number placeholders are bare numbers (no quotes), and the `/* ... */ []` / `/* ... */ {}` sentinels are real JS arrays/objects. Carry the string into Phase 4 — do **not** write it into the project.

## Phase 4 — Review, then run inline

1. **Recap before launching** — autonomous loops burn real compute, so a quick look is worth it: files classified (N prepare / M train), primary metric + direction, secondary metrics being cross-referenced, training command, budget, and the maxTime kill bound, this run's intent (focus / cap / seeded ideas), and that results land in `results.tsv` (untracked). Offer to show the full assembled script.
2. **Run inline** — on the user's go, invoke the **Workflow tool** with `script` set to the assembled string. Pass it inline; do **not** point `scriptPath` at a file in the project.
3. **Report** — confirm the workflow is running, restate the primary metric + direction and the experiment cap, and note that each experiment appends one row to `results.tsv`.

## Rules

- **Project-agnostic**: works on any ML project.
- **Read before classifying**: never guess a file's role — read it.
- **All placeholders filled**: no template boilerplate in the assembled workflow.
- **Never write the workflow into the target project**: assemble inline and run via the Workflow tool (inline `script`). The only on-disk copy is the Workflow tool's own session-directory persistence — never `.claude/workflows/` in the repo.
- **Inline control — no staged remote helpers**: when training runs on a remote host (ssh), ALL control — launch, kill-bound, await, metric extraction — lives INLINE in the workflow config: `{train_command_with_logging}` and `{metric_extract_command}` are the *complete* ssh commands, with the deadline (a `timeout` kill-timer) and a completion flag embedded in the command itself, executed directly by the Run/Evaluate agents. Do NOT stage helper scripts on the remote host — no `Setup` step (or any agent) that writes launcher / awaiter / extractor wrapper scripts there. Staged helpers duplicate the control logic out-of-band, drift from the workflow script, and become a second source of truth; the workflow script + the agents ARE the control (same principle as never writing the workflow into the project — nothing control-shaped gets written to the remote either).
- **Tailor per invocation**: capture the run's focus, cap, and seed ideas — the same project bootstraps differently each time.
- **Concrete commands + unambiguous metric**: exact number, exact direction, exact extraction command.
- **Experiment lifecycle ≠ agent lifecycle**: each training run is a self-terminating background process - launched kill-bounded by `maxTime` (a `timeout`/wall-time wrapper so the process dies at the deadline, NOT an agent watching a clock deciding to kill), awaited via ONE Bash `run_in_background` completion notification (never poll, never spawn check-agents), then a SEPARATE short agent extracts metrics and decides keep/discard. So a minimal launcher/awaiter agent owns the run's lifetime, and a different short agent does the ML reasoning afterward - no reasoning agent is held alive for the training duration, and `maxTime` is enforced by the process itself (killed-at-deadline -> crash). While the whole workflow runs in the background, the Workflow tool notifies you on completion - don't keep spawning check-agents; at most start ONE Monitor on `results.tsv` / the run log.
- **Valid JS output**: numbers bare, arrays/objects as JS literals.
