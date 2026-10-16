"""变异测试：逐条破坏校验器，确认测试能抓到。

用途：验证 tests/*.test.mjs 不是"永远绿"的假测试。
做法：把每条校验的判定条件改成永假（等价于删掉那条校验），
     编译 → 跑对应测试 → 看是否变红 → **还原并重新编译**。

⚠️ 两个必须做对的细节（都踩过）：
   1. 还原源码必须用「写回内存里的原文」，**不能用 `git checkout`**——
      那样会连带撤掉其它尚未提交的改动（本项目重构过一次 RarityConfig 被误撤）。
   2. 还原 + 重新编译必须在**跑完测试之后**，否则测的是已还原的代码，
      结果永远是"通过"（本项目因此跑出过 0/19 的假数据）。

以后给配置表加了新校验，应该同步在 CASES 里加一条。
"""
import io, subprocess, sys

CASES = [
    # ---- RarityConfig.validateRarityTableData ----
    ('RarityConfig.ts', '品阶表长度应为',
     "if (table.length !== count) {", "if (false) {", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '品阶表索引不连续',
     "if (d.tier !== i) errors.push", "if (false) errors.push", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '品阶倍率必须为正',
     "if (d.powerMul <= 0) errors.push", "if (false) errors.push", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '镶嵌槽位不能为负',
     "if (d.sockets < 0) errors.push", "if (false) errors.push", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '品阶倍率必须严格递增',
     "if (i > 0 && d.powerMul <= table[i - 1].powerMul) {", "if (false) {", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '镶嵌槽位不允许减少',
     "if (i > 0 && d.sockets < table[i - 1].sockets) {", "if (false) {", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '低于钻石不该有自带属性',
     "if (d.innate && d.tier < INNATE_RARITY_MIN) {", "if (false) {", 'tests/rarity.test.mjs'),
    ('RarityConfig.ts', '抽奖上限不能是最高品阶',
     "if (gachaMax >= count - 1) {", "if (false) {", 'tests/rarity.test.mjs'),

    # ---- ElementConfig.validateElementGroups ----
    ('ElementConfig.ts', '属性组应有4种',
     "if (g.els.length !== perGroup) {", "if (false) {", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '组内重复',
     "if (new Set(g.els).size !== g.els.length) {", "if (false) {", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '组间重复',
     "if (flatSet.size !== flat.length) {", "if (false) {", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '属性未覆盖',
     "if (!flatSet.has(id)) errors.push", "if (false) errors.push", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '未知属性',
     "if (allIds.indexOf(id) < 0) errors.push", "if (false) errors.push", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '四属性关组里不够',
     "if (n > groups[g].els.length) {", "if (false) {", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '组内种类变化',
     "if (nThis !== nLast) {", "if (false) {", 'tests/element.test.mjs'),

    # ---- ElementConfig.validateElementInvariants ----
    ('ElementConfig.ts', '不变式1 同关内重复',
     "if (new Set(els).size !== els.length) {", "if (false) {", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '不变式2 同组不共享',
     "if (n >= 2 && shared.length === 0) {", "if (false) {", 'tests/element.test.mjs'),
    ('ElementConfig.ts', '不变式4 换组仍共享',
     "if (shared.length > 0) {", "if (false) {", 'tests/element.test.mjs'),

    # ---- TutorialConfig 文案约束（通过改文案制造违规）----
    ('TutorialConfig.ts', '标题长度<=12',
     None, None, 'tests/tutorial.test.mjs'),
    ('BalanceGuard.ts', '预算过低',
     "if (r.ratio < min) {", "if (false) {", 'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '预算过高',
     "if (r.ratio > max) {", "if (false) {", 'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '中位数',
     "if (med < medMin || med > medMax) {", "if (false) {", 'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '同层不该互相压制',
     "if (prevMax !== undefined && r.ratio < prevMax - 1e-9) {", "if (false) {",
     'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '预算完全相同',
     "if (Math.abs(rows[i].ratio - rows[j].ratio) < 1e-9) {", "if (false) {",
     'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '模型/实测偏离',
     "if (factor < tolMin || factor > tolMax) {", "if (false) {", 'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '实测 DPS 为 0',
     "if (actual <= 0) {", "if (false) {", 'tests/balance.test.mjs'),
    ('BalanceGuard.ts', 'pierce 同屏封顶',
     "return Math.max(1, Math.min(raw, targets));", "return raw;", 'tests/balance.test.mjs'),
    ('BalanceGuard.ts', '三连射衰减',
     "export const TRIPLE_SHOT_FALLOFF = 0.62;",
     "export const TRIPLE_SHOT_FALLOFF = 1.0;", 'tests/balance.test.mjs'),
]

BUILD = ['node', 'tools/build-tests.mjs']
caught, missed = [], []

for fname, name, frag, repl, test in CASES:
    path = 'assets/scripts/data/' + fname
    orig = io.open(path, encoding='utf-8').read()

    if frag is None:
        mutated = orig.replace("title: '三选一',", "title: '三选一 · 变强的主要来源',", 1)
    else:
        if frag not in orig:
            missed.append((name, '片段未找到 —— 代码可能已改，需同步更新本脚本'))
            continue
        mutated = orig.replace(frag, repl, 1)

    if mutated == orig:
        missed.append((name, '变异未生效'))
        continue

    # 1) 变异 + 编译
    io.open(path, 'w', encoding='utf-8').write(mutated)
    b = subprocess.run(BUILD, capture_output=True)
    if b.returncode != 0:
        missed.append((name, '变异后编译失败'))
        io.open(path, 'w', encoding='utf-8').write(orig)
        subprocess.run(BUILD, capture_output=True)
        continue

    # 2) ★ 必须在还原之前跑测试
    r = subprocess.run(['node', test], capture_output=True, text=True)

    # 3) 还原 + 重新编译
    io.open(path, 'w', encoding='utf-8').write(orig)
    subprocess.run(BUILD, capture_output=True)

    if r.returncode != 0:
        caught.append(name)
    else:
        missed.append((name, '测试仍然通过 → 该校验没被覆盖'))

# 收尾：确认所有源码已还原
dirty = []
for f in set(c[0] for c in CASES):
    pass

subprocess.run(BUILD, capture_output=True)
final = subprocess.run(['node', 'tests/run.mjs'], capture_output=True, text=True)

print()
print('=' * 62)
print('变异测试（变异 = 删掉一条校验，看测试能否发现）')
print('=' * 62)
print(f'杀死: {len(caught)}/{len(CASES)}')
for c in caught:
    print(f'  [OK]   {c}')
if missed:
    print()
    print(f'漏网 {len(missed)} 条:')
    for m, why in missed:
        print(f'  [MISS] {m} —— {why}')
print()
print('还原后全量测试:', '通过' if final.returncode == 0 else '失败（有问题！）')
sys.exit(0 if not missed else 1)