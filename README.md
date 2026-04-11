# autoresearch-bootstrap

一个 Claude Code skill，用于为任意 ML 项目自动生成自治研究环境（autonomous research setup）。遵循 [karpathy/autoresearch](https://github.com/karpathy/autoresearch) 模式：将代码分为「固定基础设施」和「可修改训练代码」两个作用域，然后生成一个 `program.md` 让 Claude 自主循环实验。

## 它做了什么

给定你的 ML 项目，这个 skill 会：

1. **探索** — 读取项目的所有源码、配置、入口文件，理解数据流
2. **分类** — 将每个文件归入 `prepare.py`（只读，不可修改）或 `train.py`（可修改）作用域
3. **生成 `docs/program.md`** — 一份完整的自治研究计划，包含：
   - 训练命令、预算、主指标及提取方式
   - 实验循环流程（修改 → 提交 → 训练 → 提取指标 → 保留/回退 → 记录 → 重复）
   - 每次实验自动写入 memory 和 `results.tsv`
   - 5-10 条针对项目的研究思路
4. **报告** — 输出分类统计、指标、命令摘要

生成完成后，Claude 会按照 `program.md` 中的流程自主迭代实验，无需人工干预。

## 安装

### 方法一：克隆到 skills 目录（推荐）

```bash
# 安装到用户级 skills（所有项目可用）
git clone https://github.com/ACautomata/autoresearch-bootstrap.git ~/.claude/skills/autoresearch-bootstrap

# 或者安装到项目级（仅当前项目可用）
git clone https://github.com/ACautomata/autoresearch-bootstrap.git .claude/skills/autoresearch-bootstrap
```

### 方法二：手动复制

下载 `SKILL.md` 和 `references/` 目录，放到上述任一位置即可。

## 使用

在 Claude Code 中打开你的 ML 项目，输入：

```
/autoresearch-bootstrap
```

Skill 会自动开始探索你的项目，过程中可能会问你几个问题（如噪声地板阈值、代码复杂度阈值），确认后会生成 `docs/program.md`。

之后 Claude 会按 `program.md` 的指引开始自主实验循环。

## 生成的 program.md 包含什么

| 章节 | 内容 |
|---|---|
| **Architecture** | prepare.py / train.py 两个作用域的说明 |
| **Setup** | 分支命名、文件清单、数据验证、results.tsv 和 memory 初始化 |
| **Experimentation** | 可改/不可改范围、主指标、简洁性判据 |
| **Output format** | 训练输出示例、指标提取命令 |
| **Documenting findings** | 每次实验写 memory note（Idea/Result/Verdict/Insight）+ results.tsv |
| **The experiment loop** | 10 步循环：修改 → 训练 → 提取 → 记录 → 写 memory → 判断保留/回退 |
| **Research Ideas** | 5-10 条项目特定的实验思路 |
| **File Scope Reference** | 每个文件的分类表格 |

## 项目结构

```
autoresearch-bootstrap/
├── SKILL.md                          # Skill 主文件，定义 4 阶段工作流
└── references/
    ├── classification-guide.md       # prepare.py vs train.py 分类启发式规则
    └── program-template.md           # program.md 模板（含所有占位符）
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
