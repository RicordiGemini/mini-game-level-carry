import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getLevelConfig, buildEnemySpawnSpec } from '../.test-build/data/LevelConfig.js';
import { levelExpFor, experienceShare } from '../.test-build/data/RunConfig.js';
import { emptyLoadout, gainExp, migrateExpCurve } from '../.test-build/core/RunLoadout.js';
import { BattleWorld } from '../.test-build/battle/BattleWorld.js';
import { isReadyToEvolve } from '../.test-build/core/FormGraph.js';

let checked = 0;
const report = JSON.parse(readFileSync(new URL('../configs/levels/roguelike-wave-plan.json', import.meta.url), 'utf8'));
for (let id = 1; id <= 200; id++) {
  for (let tier = 1; tier <= 3; tier++) {
    for (const boost of [0, 0.3, 0.6, 0.9, 1.2]) {
      const cfg = getLevelConfig(id, tier, boost);
      const budget = cfg.experience;
      const world = new BattleWorld();
      world.setup({ playerHp: 100, weapons: [], enemy: { ...buildEnemySpawnSpec(cfg), waves: undefined, batchSize: cfg.enemies } });
      assert.equal(world.enemies.length, cfg.enemies);
      assert.equal(world.enemies.reduce((n, e) => n + e.expValue, 0), budget.totalExp);
      assert.equal(world.enemies.reduce((n, e) => n + e.formExpValue, 0), budget.totalFormExp);
      assert.ok(budget.targetLevelUps <= 59);
      let baseline;
      for (const order of [world.enemies, [...world.enemies].reverse()]) {
        const lo = emptyLoadout();
        lo.weapons = [{ id: 'blade', formId: 'blade', kind: 'weapon', stage: 0, exp: 0 }];
        const milestones = [];
        for (const [i, e] of order.entries()) {
          const ups = gainExp(lo, e.expValue, e.formExpValue);
          assert.ok(ups <= 1, `第 ${id}/${tier}/+${boost} 关单杀不得连升`);
          if (ups) milestones.push(i + 1);
        }
        assert.equal(lo.level - 1, budget.targetLevelUps);
        assert.equal(lo.weapons[0].exp, budget.totalFormExp);
        assert.ok(milestones[0] >= 2);
        assert.ok(milestones.at(-1) <= cfg.enemies);
        const gapLimit = Math.ceil(levelExpFor(lo.level - 1) / cfg.expPerEnemy);
        const nodes = [0, ...milestones];
        assert.ok(nodes.slice(1).every((n, i) => n - nodes[i] <= gapLimit), '升级间隔不超过平均间隔的约 1.6 倍');
        if (!baseline) baseline = milestones;
      }
      // 经验流仍能提前升级并得到额外升级机会，不被预算硬封顶。
      const bonus = emptyLoadout();
      for (const e of world.enemies) gainExp(bonus, Math.round(e.expValue * 1.6), Math.round(e.formExpValue * 1.6));
      assert.ok(bonus.level - 1 > budget.targetLevelUps || bonus.level === 60);
      if (boost === 0) {
        const plan = report.levels.find(p => p.levelId === id && p.difficulty === tier);
        assert.deepEqual(plan.experience.upgradeKills, baseline);
        assert.equal(plan.experience.totalExp, budget.totalExp);
        assert.equal(plan.experience.totalFormExp, budget.totalFormExp);
      }
      checked++;
    }
  }
}

// 新手第一张卡仅培养经验达标，不能绕过五次强化与配套辅助的进化条件。
{
  const cfg = getLevelConfig(1);
  const lo = emptyLoadout();
  lo.weapons = [{ id: 'blade', formId: 'blade', kind: 'weapon', stage: 0, exp: 0 }];
  let first = 0;
  for (let i = 0; i < cfg.enemies; i++) {
    if (gainExp(lo, experienceShare(cfg.experience.totalExp, cfg.enemies, i), experienceShare(cfg.experience.totalFormExp, cfg.enemies, i))) {
      first = i + 1;
      break;
    }
  }
  assert.equal(first, 35);
  assert.equal(cfg.experience.targetLevelUps, 14, '普通首关基础选卡次数由 31 降至 14');
  assert.equal(isReadyToEvolve(lo.weapons[0], lo), false);
}

// 旧曲线迁移保留等级、进度比例和已有奖励；再次加载不重复转换。
{
  const lo = emptyLoadout();
  delete lo.expCurveVersion;
  lo.level = 10;
  const oldNeed = Math.round(70 * 1.3 ** 9);
  lo.pendingExp = Math.floor(oldNeed / 2);
  lo.pendingLevelUps = [9, 10];
  const expected = Math.floor(lo.pendingExp / oldNeed * levelExpFor(10));
  migrateExpCurve(lo);
  assert.equal(lo.level, 10);
  assert.equal(lo.pendingExp, expected);
  assert.deepEqual(lo.pendingLevelUps, [9, 10]);
  const before = JSON.stringify(lo);
  migrateExpCurve(lo);
  assert.equal(JSON.stringify(lo), before);
}
console.log(`✅ 经验节奏：${checked} 组关卡/难度/加难预算守恒、单杀至多升一级、升级节点、经验流加成与旧曲线迁移通过`);
