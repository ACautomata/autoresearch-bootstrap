---
name: autoresearch-bootstrap
description: >
  Bootstrap autonomous ML research on any project. Explores the codebase, classifies
  directories into "prepare.py scope" (fixed infrastructure — data, metrics, callbacks)
  vs "train.py scope" (modifiable — models, training, losses, optimizers), then generates
  a Claude Code workflow for autonomous experimentation adapted from karpathy/autoresearch.
  Use when (1) user wants to set up autonomous research on an ML project, (2) user mentions
  "autoresearch" or "research workflow" in context of their project, (3) user wants to
  identify which code to modify vs keep fixed for experimentation. Works on any ML project
  regardless of framework.
---

# Autoresearch Bootstrap

Generate a Claude Code workflow that enables autonomous ML research on any project, following the karpathy/autoresearch pattern: fixed infrastructure (prepare.py scope) + modifiable training code (train.py scope) + automated experiment loop.

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

### Phase 3: Generate workflow

**Read [workflow-template.js](references/workflow-template.js)** for the full template with all placeholders.

Fill every `{PLACEHOLDER}` in the `C` (config) object with project-specific information from Phase 1-2.

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

Save to `.claude/workflows/{project}-autoresearch.js` in the target project.

### Phase 4: Report

Print summary:
- Files classified: N prepare.py scope, M train.py scope
- Primary metric and direction
- Training command
- Research ideas generated
- Workflow saved to: `.claude/workflows/{project}-autoresearch.js`
- To start: run the workflow with the Workflow tool

## Rules

- **Project-agnostic**: works on any ML project
- **Read before classifying**: never guess a file's role — read it
- **All placeholders must be filled**: no template boilerplate in output
- **Concrete shell commands**: the workflow must contain exact runnable commands
- **Metric must be unambiguous**: specify exact number, exact direction, exact extraction method
- **Valid JS output**: the generated workflow must be valid JavaScript — number placeholders as bare numbers, JSON arrays/objects as JS literals
