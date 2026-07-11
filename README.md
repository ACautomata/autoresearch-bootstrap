# autoresearch-bootstrap

一个 Claude Code skill，用于为任意 ML 项目自动搭建自治研究环境（autonomous research setup）。遵循 [karpathy/autoresearch](https://github.com/karpathy/autoresearch) 模式：将代码分为「固定基础设施」和「可修改训练代码」两个作用域，然后**按本次意图现做现配一个 Claude Code workflow 并内联运行**（不往项目里写任何文件）。

## 它做了什么

给定你的 ML 项目，这个 skill 会：

1. **探索** — 读取项目的所有源码、配置、入口文件，理解数据流
2. **分类** — 将每个文件归入 `prepare.py`（只读，不可修改）或 `train.py`（可修改）作用域
3. **组装 workflow 并内联运行** — 根据本次意图（聚焦方向 / 实验上限 / 初始想法）组装一个 Claude Code workflow，给你过目后用 Workflow 工具**内联运行**：
   - 训练命令、预算、主指标及提取方式
   - 自动实验循环（提出想法 → 修改代码 → 训练 → 提取指标 → 保留/回退 → 记录 → 重复）
   - 每次实验自动写入 `results.tsv`
   - 5-10 条针对项目的研究思路
   - **不往你的项目里写任何文件**——脚本只存在 session 目录里（可 resume），不污染仓库、不需要 gitignore
4. **报告** — 输出分类统计、指标、命令摘要

组装完成后，skill 把 workflow 给你过目、确认后用 Workflow 工具**内联运行**（脚本只落在 session 目录、不进项目仓库），无需人工干预。

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

Skill 会自动开始探索你的项目，过程中会问你几个问题（噪声地板 / 复杂度阈值，以及**本次的研究聚焦方向和实验上限**），确认后把 workflow 组装出来给你过目。

确认后用 Workflow 工具内联启动自动实验循环（不落盘到项目）。

## 组装的 workflow 包含什么

| 阶段 | 内容 |
|---|---|
| **Setup** | 创建分支、验证环境、初始化 results.tsv |
| **Baseline** | 不修改代码跑一次训练，建立基准指标 |
| **Experiment** | 从研究思路中选取一个，修改 train.py 作用域代码 |
| **Evaluate** | 运行训练、提取指标、与最佳值比较、决定保留或回退 |
| **Record** | 追加一行到 results.tsv，记录实验发现 |

## 项目结构

```
autoresearch-bootstrap/
├── SKILL.md                          # Skill 主文件，定义 4 阶段工作流
└── references/
    ├── classification-guide.md       # prepare.py vs train.py 分类启发式规则
    └── workflow-template.js          # workflow 结构蓝图（占位符；组装后内联运行，不落盘到项目）
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
