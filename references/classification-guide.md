# Classification Guide: prepare.py scope vs train.py scope

## Core Principle

In karpathy/autoresearch, `prepare.py` is fixed infrastructure the agent cannot touch, and `train.py` is the modifiable training code. This guide maps that split to multi-file ML projects.

## Classification Heuristics

### prepare.py scope (FIXED — agent MUST NOT modify)

Files that provide **infrastructure the evaluation depends on**. Changing these would make experiments incomparable or break the evaluation harness.

**Data layer:**
- Datasets, datamodules, dataloaders, transforms, collators
- Data download/preprocessing scripts
- Tokenizers, feature extractors

**Evaluation layer:**
- Metric implementations (FID, SSIM, accuracy, BLEU, etc.)
- Evaluation harnesses and test scripts
- Ground truth comparison logic

**Training infrastructure:**
- Callbacks (logging, checkpointing, early stopping)
- Distributed training setup
- Training loop frameworks (if the loop itself is not the experiment target)

**Supporting code:**
- Type definitions, protocols, abstract base classes
- Utility functions (geometry, file I/O, etc.)
- Configuration schemas and validation
- Inference/post-processing utilities

### train.py scope (MODIFIABLE — agent CAN edit)

Files where **model behavior is defined**. These are the research surface — changing them changes what the model learns.

**Model architectures:**
- Encoders, decoders, transformers, CNNs, RNNs
- Attention mechanisms, normalization layers, custom modules
- Quantizers, bottlenecks, skip connections

**Training orchestration:**
- Training tasks / LightningModules
- Training step logic (forward pass, loss computation, backward pass)
- GAN strategies, multi-optimizer coordination

**Loss functions:**
- All loss implementations
- Loss weighting and scheduling

**Optimization:**
- Optimizer construction, LR scheduling
- Gradient clipping, gradient accumulation strategies

**Composition:**
- Model factories, builder/composition code
- Code that wires components from config

## Edge Cases

| Component | Default scope | Reason |
|-----------|--------------|--------|
| Config YAML files | prepare.py | Hyperparameters live in train.py scope code; configs are the interface |
| Training entry point | train.py | How training is launched may change |
| Eval entry point | prepare.py | Evaluation is fixed |
| Data transforms that are model-specific | train.py | If transforms encode architectural choices (e.g., patch size) |
| Callbacks that compute metrics | prepare.py | Metric computation must be fixed |
| Callbacks that only log | prepare.py | Logging is infrastructure |

## Verification Checklist

After classification, verify:
1. Every Python source file is assigned to exactly one scope
2. No file in prepare.py scope imports a file in train.py scope for runtime logic
3. The evaluation harness is entirely in prepare.py scope
4. The primary metric can be extracted without any train.py scope code running
5. Data loading works without any train.py scope code
