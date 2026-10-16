"""变异测试：逐条破坏校验器，确认测试能抓到。

用途：验证 tests/*.test.mjs 不是"永远绿"的假测试。
做法：把每条校验的判定条件改成永假（等价于删掉这条校验），
     然后跑测试看是否变红。抓不到 = 该测试用例没覆盖到这条校验。

这个脚本本身也是回归工具 —— 以后给 FormConfig 加新校验，
应该同步在MUTATIONS 里加一条，确认新校验有被测到。
"""
import io, subprocess, sys

SRC = 'assets/scripts/data/FormConfig.ts'
TEST = 'tests/form_graph.test.mjs'
orig = io.open(SRC, encoding='utf-8').read()

# (说明, 用于定位的原始代码片段, 变异后的替换片段)
MUTATIONS = [
    ('武器形态缺少 sources',      "if (f.sources.length === 0 && f.kind === 'weapon') {",  "if (false) {"),
    ('武器 equipType 不能是 aux', "if (f.kind === 'weapon' && f.equipType === 'aux') {", "if (false) {"),
    ('辅助 equipType 必须是 aux', "if (f.kind === 'aux' && f.equipType !== 'aux') {",    "if (false) {"),
    ('进化边指向不存在',    "if (!target) {",      "if (false) {"),
    ('进化边跨越槽位种类',       "if (target.kind !== f.kind) {",     "if (false) {"),
    ('边上的 fusion 层级检查',   "if (target.depth < f.depth) {",     "if (false) {"),
    ('边上的 upgrade 层级检查',  "} else if (target.depth <= f.depth) {", "} else if (false) {"),
    ('fusion 边缺 need',    "if (!e.need) {",      "if (false) {"),
    ('fusion 边材料不存在',      "} else if (!map[e.need]) {",       "} else if (false) {"),
    ('辅助不允许合成进化',   "if (f.kind !== 'weapon') {",          "if (false) {"),
    ('advanced 出现在 depth<2',  "if (e.advanced && f.depth < 2) {",  "if (false) {"),
    ('辅助只能走 upgrade',       "if (e.type !== 'upgrade') {",       "if (false) {"),
    ('配方材料 A 不存在',        "if (!map[r.a]) errors.push",        "if (false) errors.push"),
    ('配方材料 B 不存在',        "if (!map[r.b]) errors.push",        "if (false) errors.push"),
    ('配方产物不存在',           "if (!t) {",           "if (false) {"),
    ('产物必须是武器',   "if (t.kind !== 'weapon') errors.push", "if (false) errors.push"),
    ('配方两件材料重复',         "if (r.a === r.b) errors.push",       "if (false) errors.push"),
    ('产物无 sources',           "if (t.sources.length === 0) errors.push", "if (false) errors.push"),
    ('配方层产物层级检查',       "if (t.depth < Math.max(fa.depth, fb.depth)) {", "if (false) {"),
    ('产物 atkPct 不高于材料',   "if (t.atkPct <= Math.max(fa.atkPct, fb.atkPct)) {", "if (false) {"),
    ('武器根形态缺失',           "if (!f) {\n            errors.push('武器根形态缺失", "if (false) {\n            errors.push('武器根形态缺失"),
    ('根形态 depth 必须为 0',    "if (f.depth !== 0) errors.push",    "if (false) errors.push"),
    ('辅助根形态缺失',           "if (!f) errors.push('辅助根形态缺失", "if (false) errors.push('辅助根形态缺失"),
]

caught, missed = [], []

for name, frag, repl in MUTATIONS:
    if frag not in orig:
        missed.append((name, '片段未找到 —— 代码可能已改，需同步更新本脚本'))
        continue

    io.open(SRC, 'w', encoding='utf-8').write(orig.replace(frag, repl, 1))

    b = subprocess.run(['node', 'tools/build-tests.mjs'], capture_output=True)
    if b.returncode != 0:
        missed.append((name, '变异后编译失败'))
        io.open(SRC, 'w', encoding='utf-8').write(orig)
        continue

    t = subprocess.run(['node', TEST], capture_output=True, text=True)
    io.open(SRC, 'w', encoding='utf-8').write(orig)

    if t.returncode != 0:
        caught.append(name)
    else:
        missed.append((name, '测试仍然通过 → 覆盖不足'))

io.open(SRC, 'w', encoding='utf-8').write(orig)
subprocess.run(['node', 'tools/build-tests.mjs'], capture_output=True)

print()
print('=' * 60)
print('变异测试（变异 = 删掉一条校验，看测试能否发现）')
print('=' * 60)
print(f'杀死的校验: {len(caught)}/{len(MUTATIONS)}')
for c in caught:
    print(f'  [OK]   {c}')
if missed:
    print()
    print(f'漏网 {len(missed)} 条:')
    for m, r in missed:
        print(f'  [MISS] {m} —— {r}')

print()
print('源码已还原:', '是' if io.open(SRC, encoding='utf-8').read() == orig else '否！')
sys.exit(0 if not missed else 1)