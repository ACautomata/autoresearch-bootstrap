# program.md Template

This is the template for generating `docs/program.md`. All `{PLACEHOLDER}` values must be filled with project-specific information discovered during codebase exploration.

---

```markdown
# {PROJECT_NAME} — Autonomous Research

This is an autonomous ML research setup for {PROJECT_NAME}: {one-line project description}.

## Architecture

Two scopes of code, inspired by karpathy/autoresearch:

- **prepare.py scope** (read-only): data loading, evaluation metrics, callbacks, utilities
- **train.py scope** (modifiable): model architectures, training logic, losses, optimizers

## Setup

To set up a new experiment, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date (e.g. `{today_short_tag}`). The branch `autoresearch/<tag>` must not already exist — this is a fresh run.
2. **Create the branch**: `git checkout -b autoresearch/<tag>` from current main/master.
3. **Read the in-scope files**: Read these for full context:
   - Project docs (`README.md`, `CLAUDE.md`, `AGENTS.md`) — project context and architecture
   - **prepare.py scope** (read-only, do NOT modify):
{prepare_scope_file_list}
   - **train.py scope** (modifiable):
{train_scope_file_list}
4. **Verify data/environment**: {data_verification_steps}
5. **Initialize results.tsv**: Create `results.tsv` with the header row:
   ```
   commit	{primary_metric}	memory_gb	status	description
   ```
6. **Initialize memory index**: Ensure the memory directory exists at `~/.claude/projects/<project-path>/memory/` and add an entry to `MEMORY.md` indexing the autoresearch run:
   ```
   - [Autoresearch {tag}](exp_{tag}_overview.md) — experiment run on {date}, optimizing {primary_metric}
   ```
7. **Confirm and go**: Confirm setup looks good.

Once you get confirmation, kick off the experimentation.

## Experimentation

Each experiment runs via:
```bash
{train_command}
```
Training runs for {budget_description}.

**What you CAN do:**
- Modify files in train.py scope:
{train_scope_permissions}

**What you CANNOT do:**
- Modify files in prepare.py scope. They are read-only.
- Install new packages. Use only existing dependencies.
- Modify the evaluation harness. The metric code is ground truth.

**The goal: get the {best_direction} {primary_metric}.**
{metric_explanation}

**Memory** is a soft constraint. Some increase is acceptable for meaningful gains.

**Simplicity criterion**: All else being equal, simpler is better. {simplicity_threshold_guidance} A {noise_floor} {primary_metric} improvement that adds {complex_code_lines} lines of hacky code is probably not worth it. A {noise_floor} {primary_metric} improvement from deleting code is definitely worth keeping. An improvement of ~0 but much simpler code is also worth keeping. When evaluating whether to keep a change, weigh the complexity cost against the improvement magnitude.

**The first run**: Always establish the baseline first — run training as-is with no modifications.

## Output format

When training finishes, the script prints a summary like this:
```
---
{output_example_block}
```

You can extract the key metric from the log file:
```bash
{metric_extract_command}
```

{additional_metric_extract_commands}

## Logging results

Log each experiment to `results.tsv` (tab-separated, NOT comma-separated).

Columns:
```
commit	{primary_metric}	memory_gb	status	description
```

1. git commit hash (short, 7 chars)
2. {primary_metric} achieved — use {crash_value} for crashes
3. peak memory in GB, round to .1f — use 0.0 for crashes
4. status: `keep`, `discard`, or `crash`
5. short description of the experiment

Example:
```
commit	{primary_metric}	memory_gb	status	description
a1b2c3d	{baseline_value}	{baseline_memory}	keep	baseline
b2c3d4e	{improved_value}	{improved_memory}	keep	{example_improvement}
```

## Documenting findings

After **every** experiment (keep, discard, or crash), you MUST write a memory note and append to results.tsv. This ensures no knowledge is lost across the loop.

### Memory notes

Write each experiment's key takeaway to memory (`~/.claude/projects/<project>/memory/`) as a markdown file. Use the `project` memory type. File naming: `exp_<tag>_<short_description>.md`.

Frontmatter format:
```yaml
---
name: exp_<tag>_<short_description>
description: <one-line summary of the experiment and its outcome>
type: project
---
```

Body must include:
- **Idea**: what was tried and why
- **Result**: {primary_metric} value, comparison to baseline
- **Verdict**: keep/discard/crash — and why
- **Insight**: what was learned (e.g. "X doesn't help because Y", "Z is promising but needs tuning")

Keep each note concise (5-10 lines of body). The goal is to build a cumulative research log that prevents repeating failed ideas and surfaces patterns.

Example:
```markdown
---
name: exp_apr11_wider_predictor
description: Wider predictor (256→512 hidden dim) improved val_loss by 2.3%
type: project
---

**Idea**: Double predictor hidden dimension to test capacity bottleneck.
**Result**: val_loss 0.9741 (baseline 0.9972), memory 44.8→46.2 GB
**Verdict**: keep — significant improvement, modest memory increase
**Insight**: Predictor was capacity-limited. Wider layers help more than deeper.
```

### results.tsv

Every experiment must have a row in `results.tsv`. Do not skip crashed or discarded experiments — they are valuable negative results.

## The experiment loop

The experiment runs on a dedicated branch (e.g. `autoresearch/{today_short_tag}`).

LOOP FOREVER:
1. Look at the git state: the current branch/commit
2. Modify files in **train.py scope** with an experimental idea
3. git commit
4. Run the experiment: `{train_command_with_logging}` (redirect everything — do NOT use tee or let output flood your context)
5. Read out the results: `{metric_extract_command}`
6. If results can't be found, the run crashed. Check logs and attempt a fix. If you can't fix after a few attempts, give up.
7. Record the results in `results.tsv` (do NOT commit results.tsv — leave it untracked)
8. **Write a memory note** — save key findings to `memory/exp_<tag>_<description>.md` as documented in "Documenting findings" above. Every experiment gets a note.
9. If {primary_metric} improved ({improvement_direction}), advance the branch
10. If {primary_metric} is equal or worse, git reset back to where you started

**Timeout**: Each experiment should take ~{expected_duration}. If a run exceeds {max_duration}, kill it and treat it as failure.

**Crashes**: If a run crashes (OOM, bug), fix simple issues and re-run. If the idea is fundamentally broken, log "crash" and move on.

**NEVER STOP**: Once the experiment loop begins, do NOT pause to ask the human. The human might be asleep. You are autonomous. If you run out of ideas, think harder — re-read the code, try combining previous near-misses, try radical changes. The loop runs until the human interrupts you.

## Research Ideas

{research_ideas}

## File Scope Reference

### prepare.py scope (DO NOT MODIFY)
| Directory/File | Role |
|---|---|
{prepare_scope_table}

### train.py scope (MODIFIABLE)
| Directory/File | Role |
|---|---|
{train_scope_table}
```

---

## Template Variable Reference

| Placeholder | Source | Example |
|---|---|---|
| `{PROJECT_NAME}` | Project name from README or pyproject.toml | `maskgit-3d` |
| `{one-line project description}` | From README | `3D medical image generation with VQVAE + MaskGIT` |
| `{today_short_tag}` | Current date | `mar27` |
| `{prepare_scope_file_list}` | Discovered prepare.py scope files | `- data/ — datasets, transforms, datamodules` |
| `{train_scope_file_list}` | Discovered train.py scope files | `- models/ — VQVAE, MaskGIT architectures` |
| `{data_verification_steps}` | How to verify data is ready | `Check ~/.cache/autoresearch/ contains data shards` |
| `{primary_metric}` | Main evaluation metric | `val_bpb`, `fid`, `val_loss` |
| `{best_direction}` | Optimization direction | `lowest`, `highest` |
| `{metric_explanation}` | What the metric measures | `val_bpb (validation bits per byte) — lower is better` |
| `{train_command}` | How to launch training | `uv run train.py`, `maskgit3d-train` |
| `{train_command_with_logging}` | Training with log capture | `uv run train.py > run.log 2>&1` |
| `{budget_description}` | Training budget | `fixed 5 minutes wall clock`, `10 epochs` |
| `{metric_extract_command}` | Shell command to extract metric | `grep "^val_bpb:" run.log` |
| `{output_example_block}` | Concrete example of training output | Multi-line block from actual training run or code analysis |
| `{additional_metric_extract_commands}` | Extra grep/parse commands for secondary metrics | `grep "^peak_vram_mb:" run.log` |
| `{crash_value}` | Metric value for crashes | `0.000000`, `999.0` |
| `{expected_duration}` | Normal experiment duration | `5 minutes`, `30 minutes` |
| `{max_duration}` | Maximum allowed duration | `10 minutes`, `60 minutes` |
| `{improvement_direction}` | What "improved" means | `lower is better`, `higher is better` |
| `{simplicity_threshold_guidance}` | Project-specific noise floor guidance (derived from metric scale, ask user to confirm) | `For this project, typical run-to-run variance is ~0.001.` |
| `{noise_floor}` | Smallest meaningful improvement (metric-specific) | `0.001`, `0.5` |
| `{complex_code_lines}` | Lines-of-code threshold for "hacky" changes | `20`, `10` |
| `{baseline_value}` | Example baseline metric value for TSV example | `0.997900`, `50.3` |
| `{baseline_memory}` | Example baseline memory for TSV example | `44.0`, `12.3` |
| `{improved_value}` | Example improved metric value for TSV example | `0.993200`, `48.1` |
| `{improved_memory}` | Example improved memory for TSV example | `44.2`, `12.5` |
| `{example_improvement}` | Example improvement description for TSV example | `increase LR to 0.04` |
| `{research_ideas}` | Project-specific ideas | Numbered list of 5-10 ideas |
| `{prepare_scope_table}` | Table of prepare.py scope files | Markdown table rows |
| `{train_scope_table}` | Table of train.py scope files | Markdown table rows |
