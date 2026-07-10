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

Assemble a Claude Code workflow that enables autonomous ML research on any project, following the karpathy/autoresearch pattern: fixed infrastructure (prepare.py scope) + modifiable training code (train.py scope) + automated experiment loop. The workflow is built fresh for each invocation from the user's stated intent and run inline — it is never written into the target project.

## Workflow

### Phase 1: Explore

**Read every relevant file. Do not skim.**

1. **Structure**: Glob all Python files. Identify source root, entry points (train/eval scripts), config system (Hydra/argparse/dataclasses).
2. **Entry points**: Read training and eval entry points fully. Trace the import chain.
3. **Data flow**: From raw data → preprocessing → model → loss → metric. Read each link.
4. **Config system**: Read config files and understand how they feed into code.
5. **Docs**: Read README.md, CLAUDE.md, AGENTS.md, pyproject.toml for context.

### Phase 2: Classify

For every source directory/file, assign to one of two scopes.

**Read [classification-guide.md](references/classification-guide.md)** for heuristics.

Quick reference:

| Category | Scope |
|---|---|
| Data loading, transforms, tokenizers | prepare.py (fixed) |
| Evaluation metrics, test harness | prepare.py (fixed) |
| Callbacks, logging, checkpointing | prepare.py (fixed) |
| Type definitions, protocols, utilities | prepare.py (fixed) |
| Model architectures (encoders, decoders, transformers) | train.py (modifiable) |
| Training tasks/steps, training loop logic | train.py (modifiable) |
| Loss functions | train.py (modifiable) |
| Optimizer/LR scheduler construction | train.py (modifiable) |
| Model factories, runtime composition | train.py (modifiable) |
| Training entry point | train.py (modifiable) |

Identify:
- **Primary metric**: what number to optimize, which direction is better
- **Training command**: exact shell command to run training
- **Budget**: epochs, steps, or time limit
- **Output format**: what the training script prints when done

**Multi-metric discipline — must ask the user**: Before proceeding to Phase 3, you MUST:
1. Ask the user to declare **multiple metrics** available in the project's training output (e.g., val_loss, train_loss, grad_norm, epoch_time, memory, RankMe, FID, etc.)
2. Ask the user to designate **one** of them as the primary optimization target
3. Remind the user of this principle: **"When a metric becomes the optimization target, it loses objectivity."** A single metric can be hacked (e.g., lowering val_loss by overfitting, inflating RankMe by shrinking embedding dimension). Always cross-reference secondary metrics to confirm genuine improvement.
4. Record all declared metrics and include their extraction commands in the generated workflow

### Phase 3: Assemble the workflow (inline — never written to the project)

Phases 1–2 established project-level facts (the metric, the train command, what's in scope). This phase captures what the user wants **this run** and assembles a ready-to-run workflow from it. The assembled workflow is run inline via the Workflow tool and is **never written into the target project** — no `.claude/workflows/` file, no project file of any kind. The Workflow tool persists the script to the *session* directory (out of the repo) so it can be resumed; that is the only copy.

**Step 1 — Capture this run's intent (must ask the user).** This is what makes each invocation bespoke rather than a canned loop:
1. **Research focus** → `{research_focus}`: what should this run concentrate on? (e.g. "reduce peak memory", "push val_loss down", "architectural changes only", "sweep losses".) This steers the experiment agent's idea generation.
2. **Experiment cap** → `{max_experiments}`: how many experiments this run? Pick a number with the user (the loop hard-stops at this cap regardless of token budget).
3. **Seed ideas**: any specific ideas the user wants tried first? Prepend them to the auto-generated ideas so they run before invented ones (head of `{research_ideas_json}`).

**Step 2 — Fill the config object.** Read [workflow-template.js](references/workflow-template.js) — it is the *blueprint* for the workflow's structure (Setup → Baseline → Experiment loop), not a file to save. Fill every `{PLACEHOLDER}` in the `C` (config) object with values from Phases 1–2 plus Step 1.

**Config values to fill** (all are string literals unless noted):

| Placeholder | Type | Notes |
|---|---|---|
| `{PROJECT_NAME}` | string | From README or pyproject.toml |
| `{today_short_tag}` | string | e.g. `may29` |
| `{primary_metric}` | string | Main evaluation metric |
| `{best_direction}` | string | `"lowest"` or `"highest"` |
| `{noise_floor}` | **number** | No quotes — JS number literal |
| `{complex_code_lines}` | **number** | No quotes — JS number literal |
| `{simplicity_threshold_guidance}` | string | Prose explaining what noise_floor/maxLines mean for this project |
| `{train_command}` | string | Exact shell command |
| `{train_command_with_logging}` | string | Command with `> run.log 2>&1` |
| `{metric_extract_command}` | string | Shell command to extract metric |
| `{additional_metric_extract_commands}` | string | Extra grep commands |
| `{budget_description}` | string | e.g. `"5 epochs"` |
| `{max_duration}` | string | Max wall time (timeout) e.g. `"10 minutes"` |
| `{expected_duration}` | string | Normal run duration for anomaly detection e.g. `"5 minutes"` |
| `{data_verification_steps}` | string | How to verify data |
| `{crash_value}` | **number** | No quotes — sentinel metric for crashes (e.g. `999.0`) |
| `{research_ideas_json}` | **JSON array** | Replace `/* ... */ []` with `["idea1", ...]` |
| `{research_focus}` | string | What this run concentrates on (steers idea generation) |
| `{max_experiments}` | **number** | No quotes — hard cap on experiments this run (e.g. `20`) |
| `{train_scope_list_json}` | **JSON array** | Replace `/* ... */ []` with `["path/", ...]` |
| `{prepare_scope_list_json}` | **JSON array** | Replace `/* ... */ []` with `["path/", ...]` |
| `{secondary_metrics_json}` | **JSON object** | Replace `/* ... */ {}` with `{"metric":"stable"}`. Values: `"stable"`, `"decrease"`, `"increase"`, `"lower_better"`, or free-text |

**Simplicity threshold — must ask the user**: Before filling `{noise_floor}`, `{complex_code_lines}`, propose concrete values based on:
- Metric scale (e.g., val_loss ~1.0 → noise floor ~0.001; FID ~50 → noise floor ~0.5)
- Codebase size (small project → lower line threshold ~10; large project → ~20)
- Present your proposed values to the user and get confirmation before writing them

**Output format — must be concrete**: For the metric extract command, trace the training script's print/logging statements and construct a realistic grep command. Do NOT leave a vague description. Provide grep commands for all useful secondary metrics.

The generated workflow must contain:
1. **Setup phase**: branch creation, data verification, results.tsv init
2. **Baseline phase**: unmodified training run to establish reference
3. **Experiment loop**: propose → apply → train → evaluate → record → keep/revert
4. **Multi-metric discipline**: cross-reference secondary metrics before declaring improvement
5. **Memory notes**: every experiment logged to Claude memory
6. **results.tsv**: every experiment recorded

**Step 3 — Assemble the script string.** Produce the final workflow JavaScript by substituting every placeholder in the blueprint with its filled value — one JS string held in context. Sanity-check it parses: number placeholders are bare numbers (no quotes), and the `/* ... */ []` / `/* ... */ {}` sentinels are replaced with real JS arrays/objects. The trailing "Template Variable Reference" block at the end of the blueprint is a comment, so it's harmless to leave in.

**Do not write this script into the target project** — no `.claude/workflows/`, no project file. Carry the assembled string into Phase 4, which runs it inline via the Workflow tool.

### Phase 4: Review, then run inline

**Step 1 — Show the user what will run.** Before launching, present a concise recap and wait for the go-ahead — autonomous loops burn real compute, so a quick look first is worth it:
- Files classified: N prepare.py scope, M train.py scope
- Primary metric + direction, and the secondary metrics being cross-referenced
- Training command and budget
- **This run's intent**: focus, experiment cap, seeded ideas
- Where results land: `results.tsv` (untracked) + per-experiment memory notes

Offer to show the full assembled workflow script if the user wants to inspect it.

**Step 2 — Run it inline.** On the user's go, invoke the **Workflow tool** with `script` set to the assembled workflow string. Pass it inline — do **not** point `scriptPath` at a file in the project. The Workflow tool runs the script and persists it to the session directory (out of the repo), so it can be resumed; nothing is written into the target project.

**Step 3 — Report.** Confirm the workflow is running inline, restate the primary metric + direction and the experiment cap, and note that each experiment will append to `results.tsv` and write a memory note as the loop proceeds.

## Rules

- **Project-agnostic**: works on any ML project
- **Read before classifying**: never guess a file's role — read it
- **All placeholders must be filled**: no template boilerplate in the assembled workflow
- **Never write the workflow into the target project**: assemble it inline and run it via the Workflow tool (inline `script`). The only on-disk copy is the session-directory persistence the Workflow tool does itself — never `.claude/workflows/` in the repo
- **Tailor per invocation**: capture the run's focus, experiment cap, and seed ideas (Phase 3 Step 1) — the same project can be bootstrapped differently each time
- **Concrete shell commands**: the workflow must contain exact runnable commands
- **Metric must be unambiguous**: specify exact number, exact direction, exact extraction method
- **Valid JS output**: the assembled workflow must be valid JavaScript — number placeholders as bare numbers, JSON arrays/objects as JS literals
