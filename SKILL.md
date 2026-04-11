---
name: autoresearch-bootstrap
description: >
  Bootstrap autonomous ML research on any project. Explores the codebase, classifies
  directories into "prepare.py scope" (fixed infrastructure — data, metrics, callbacks)
  vs "train.py scope" (modifiable — models, training, losses, optimizers), then generates
  a program.md research guide adapted from karpathy/autoresearch. Use when (1) user wants
  to set up autonomous research on an ML project, (2) user mentions "autoresearch" or
  "program.md" in context of their project, (3) user wants to identify which code to
  modify vs keep fixed for experimentation. Works on any ML project regardless of framework.
---

# Autoresearch Bootstrap

Generate a `program.md` that enables autonomous ML research on any project, following the karpathy/autoresearch pattern: fixed infrastructure (prepare.py scope) + modifiable training code (train.py scope) + experiment loop.

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
4. Record all declared metrics and include their extraction commands in the generated program.md

### Phase 3: Generate program.md

**Read [program-template.md](references/program-template.md)** for the full template with all placeholders.

Fill every `{PLACEHOLDER}` with project-specific information from Phase 1-2.

**Simplicity threshold — must ask the user**: Before filling `{noise_floor}`, `{complex_code_lines}`, and `{simplicity_threshold_guidance}`, propose concrete values based on:
- Metric scale (e.g., val_loss ~1.0 → noise floor ~0.001; FID ~50 → noise floor ~0.5)
- Codebase size (small project → lower line threshold ~10; large project → ~20)
- Present your proposed values to the user and get confirmation before writing them into program.md

**Output format — must be concrete**: For `{output_example_block}`, trace the training script's print/logging statements and construct a realistic output example. Do NOT leave a vague description — show the exact `key: value` format the script prints. For `{additional_metric_extract_commands}`, provide grep commands for all useful secondary metrics (memory, steps, throughput, etc.)

The program.md must contain:
1. **Setup**: branch naming, file reading checklist, data verification
2. **Experimentation**: what can/cannot be modified, goal metric, simplicity criterion
3. **Output format**: how to extract the metric from logs
4. **Results logging**: TSV format with commit, metric, memory, status, description
5. **Experiment loop**: modify → commit → train → extract → keep/discard → repeat
6. **Research ideas**: 5-10 project-specific ideas
7. **Scope reference tables**: every directory/file classified

Save to `docs/program.md`.

### Phase 4: Report

Print summary:
- Files classified: N prepare.py scope, M train.py scope
- Primary metric and direction
- Training command
- Research ideas generated

## Rules

- **Project-agnostic**: works on any ML project
- **Read before classifying**: never guess a file's role — read it
- **All placeholders must be filled**: no template boilerplate in output
- **Concrete shell commands**: the program.md must contain exact runnable commands
- **Metric must be unambiguous**: specify exact number, exact direction, exact extraction method
