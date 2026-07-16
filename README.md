# autoresearch-bootstrap

一个 Claude Code skill，用于为任意 ML 项目自动搭建**可分段、可恢复**的自治研究环境。遵循 [karpathy/autoresearch](https://github.com/karpathy/autoresearch) 模式：将代码分为「固定基础设施」和「可修改训练代码」两个作用域，然后**按本次意图现做现配一个 Claude Code workflow 并内联运行**。它不修改用户工作树、不把 workflow/control/results 加入项目的受跟踪路径；为恢复而需要的控制状态与结果单独保存在 Git common dir（任何 worktree/index 之外）。

## 它做了什么

给定你的 ML 项目，这个 skill 会：

1. **探索** — 读取项目的所有源码、配置、入口文件，理解数据流
2. **分类** — 将每个文件归入 `prepare.py`（只读，不可修改）或 `train.py`（可修改）作用域
3. **组装分段 workflow 并内联运行** — 根据本次意图（聚焦方向 / 实验上限 / 初始想法）组装一个**按 `args.action` 分发**的可重入 workflow：
   - 训练命令、预算、主指标及提取方式
   - 5-10 条针对项目的研究思路
   - **不修改你的工作树或受跟踪项目文件**——workflow 脚本只存在 session 目录；控制状态写在 Git common dir（任何 worktree/index 之外），不需要 gitignore，也不会被实验提交
4. **报告** — 输出分类统计、指标、命令摘要

## 为什么是分段状态机

训练通常需要几十分钟到数小时。早期版本把「启动训练 → 等待完成」放在一个长 Workflow agent 内，但 `Bash(run_in_background=true)` 会立即返回 task id、短生命周期 agent 没有跨轮 join，agent 只能提前返回「still running」，导致下一实验在 GPU 仍被占用时启动、发生 OOM 互杀；而 analyze 阶段的 `git reset --hard` 也会被安全护栏拦截。

因此控制面被拆成两层：

- **Workflow**：每次按 `args.action` 调用，只跑短 agent（plan / finalize / status / cleanup），**从不启动或等待训练**。
- **主会话**：用自己的 `Bash(command=launch.command, run_in_background=true)` 承担完整长训练生命周期；harness 的完成通知是唯一的 join 原语。
- **每个 baseline / 实验使用独立 git worktree**。keep/discard 通过选择下一轮的 `best` commit 表达——共享 checkout 永不移动，从不执行 `git reset --hard`。

## 安装

### 方法一：克隆到 skills 目录（推荐）

```bash
# 安装到用户级 skills（所有项目可用）
git clone https://github.com/ACAutomata/autoresearch-bootstrap.git ~/.claude/skills/autoresearch-bootstrap

# 或者安装到项目级（仅当前项目可用）
git clone https://github.com/ACAutomata/autoresearch-bootstrap.git .claude/skills/autoresearch-bootstrap
```

### 方法二：手动复制

下载运行必需的 `SKILL.md` 和 `references/` 目录即可。`README.md` 与 `tests/` 仅用于文档和开发验证，可选复制。

## 使用

在 Claude Code 中打开你的 ML 项目，输入：

```
/autoresearch-bootstrap
```

Skill 会自动探索你的项目，过程中会问你几个问题（噪声地板 / 复杂度阈值，以及**本次的研究聚焦方向和实验上限**），确认后把分段 workflow 组装出来给你过目。

## 组装的 workflow 如何运行

主会话按状态机驱动，**短 agent 在 Workflow 内、长训练在主会话后台**：

| action | 由谁执行 | 作用 |
|---|---|---|
| `init` | Workflow（短 agent） | 校验仓库/配置、初始化状态与 baseline worktree，记录配置指纹；不启动训练 |
| `prepare` | Workflow（短 agent） | baseline 或从 `bestCommit` 创建下一个实验的独立 worktree、提交候选 commit、返回完整幂等 `launch` contract |
| 主会话启动 | **主会话 Bash(run_in_background)** | 原样执行 `launch.command`，等待 identity-bound `done.json` 出现 |
| `mark_started` | Workflow（短 agent） | 记录后台任务 id 供审计（非正确性依赖） |
| `finalize` | Workflow（短 agent） | 读 `done.json`、提取指标、判定 keep/discard/crash、原子更新状态、重建 `results.tsv` |
| `status` | Workflow（短 agent） | 只读协调；恢复时用它决定下一步（finalize / 重附着等待 / prepare / 完成） |
| `cleanup` | Workflow（短 agent） | 仅在无在跑任务时，安全移除已 finalize 的干净 worktree |

### 状态与产物存放

- **控制状态 + 结果**：`$(git rev-parse --git-common-dir)/autoresearch/<runId>/{state.json, state.json.prev, results.tsv}`——位于任何 worktree/index 之外，不可能被实验提交。
- **worktree**：`<repo-parent>/.autoresearch-worktrees/<repo>-<runId>/{baseline, exp-0001, …}`——每个 baseline/实验独立隔离。

### keep / discard / 恢复

- **keep**：把 `best` 推进到候选 commit；下一实验从该 commit 创建新 worktree。不合并回你的分支。
- **discard / crash**：`best` 不变；候选 branch/worktree 默认保留供审计。**永不 `git reset --hard`、`git clean -fd` 或整树 `git add -A`**。
- **恢复**：重新组装同一指纹模板，先 `status`：`done.json` 已在则 `finalize`；claim 存在时只有完整 ownership tuple（runIdentity、sourceCommit、pid、processGroupId、OS processStartId）匹配才可重附着——PID 单独绝不是身份，所有权不匹配时记录 orphan/crash 且不 signal 该进程；仍是 prepared 则重放同一 launch；ready/baseline_needed 则 `prepare`。`state.json` 是唯一权威，不依赖 Workflow runtime 的 resume 缓存。

### 远程训练

控制完全内联，不在远端写 launcher/awaiter/extractor helper。每个 attempt 用唯一远程目录与 `claim/`、`pid`、`run.log`、`done.json` 数据标志；原子 `mkdir claim` 防止重复启动；`done.json.tmp → done.json` 发布终态并绑定 runIdentity/commit/exit code。训练自身用 `timeout`/进程组约束自终止。

## 项目结构

```
autoresearch-bootstrap/
├── SKILL.md                          # Skill 主文件：4 阶段 + 分段状态机协议
├── README.md
├── references/
│   ├── classification-guide.md       # prepare.py vs train.py 分类启发式规则
│   └── workflow-template.js          # args.action 状态机蓝图（占位符；组装后内联运行）
└── tests/
    └── workflow-template.test.mjs    # 无依赖 Node 测试（node:test）
```

## 适用项目

任何使用以下技术栈的 ML 项目均可：

- PyTorch / PyTorch Lightning
- Hydra / argparse 配置系统
- 训练脚本 + 评估脚本的标准结构
- WandB / TensorBoard 等日志系统

不限于特定框架——只要项目有「训练入口 → 模型 → 损失 → 指标」的标准流程即可。

## 前置条件

- [Claude Code](https://claude.ai/code) 已安装并登录
- 你的 ML 项目有可运行的训练命令
- 训练过程会输出可解析的指标（终端打印、日志文件、WandB 等）

## 开发与测试

```bash
node --test tests/workflow-template.test.mjs
```

测试仅依赖 Node 内置模块（`node:test`、`assert`、`fs`、`vm`），覆盖占位符填充/解析、action 分发、静态安全约束（无 `git reset --hard`/`git add -A`/agent 内后台等待）、状态机与 worktree 协议。
