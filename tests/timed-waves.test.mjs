import assert from 'node:assert/strict';
import { BattleWorld } from '../.test-build/battle/BattleWorld.js';
import { buildEnemySpawnSpec, getLevelConfig } from '../.test-build/data/LevelConfig.js';

const enemy = buildEnemySpawnSpec(getLevelConfig(1));
const setup = { playerHp: 1000000, weapons: [], enemy };
const advance = (world, seconds) => { for (let i = 0; i < Math.round(seconds * 30); i++) world.update(1 / 30); };

// 多只怪同帧接触只扣一次；保护到期后可再次受伤。
{
  const w = new BattleWorld(); w.setup(setup);
  const hp = w.player.hp;
  for (let i = 0; i < 50; i++) w.damagePlayer(1);
  assert.equal(w.player.hp, hp - 1);
  advance(w, .4);
  w.damagePlayer(1);
  assert.equal(w.player.hp, hp - 2);
}

// 无击杀也持续推进三波，受同屏限流后不补发积压数量；90 秒后才进入清场。
{
  const w = new BattleWorld();
  w.setup(setup);
  advance(w, 29);
  assert.equal(w.aliveEnemies.length, 240);
  assert.equal(w.waveStatus.index, 1);
  assert.equal(w.result, 'ongoing');
  const p = w.waveProgress;
  const restored = new BattleWorld();
  restored.setup({ ...setup, waveProgress: JSON.parse(JSON.stringify(p)) });
  assert.ok(Math.abs(restored.waveProgress.spawnTimer - p.spawnTimer) < 1e-6);
  assert.deepEqual({ ...restored.waveProgress, spawnTimer: 0 }, { ...p, spawnTimer: 0 });
  assert.deepEqual(restored.enemies.map(e => [e.id, e.kind, e.maxHp, e.atk]), w.enemies.map(e => [e.id, e.kind, e.maxHp, e.atk]));
  advance(restored, 1);
  assert.equal(restored.waveStatus.index, 2);
  const corruptRefs = new BattleWorld();
  corruptRefs.setup({ ...setup, waveProgress: { ...p, alive: [null, {}, ...p.alive] } });
  assert.equal(corruptRefs.aliveEnemies.length, p.alive.length, '坏存活引用应跳过，保留有效进度');
  for (const e of restored.enemies) restored.damageEnemy(e, 99999);
  restored.update(1 / 30);
  assert.equal(restored.result, 'ongoing', '清掉当前场上敌人不得提前通关');
  advance(restored, 1);
  assert.equal(restored.enemies.length, 16, '第二波仍持续补怪，无积压爆发');
  assert.equal(restored.enemies[0].maxHp, Math.round(enemy.hp * 1.25));
  assert.equal(restored.enemies[0].atk, Math.round(enemy.atk * 1.15));
  advance(restored, 60);
  assert.equal(restored.waveStatus.clearing, true);
  assert.equal(restored.result, 'ongoing', '必须清理最后一批');
  for (const e of restored.enemies) restored.damageEnemy(e, 99999);
  let settlements = 0;
  restored.cb.onCleared = () => settlements++;
  restored.update(1 / 30);
  advance(restored, 1);
  assert.equal(restored.result, 'won');
  assert.equal(settlements, 1);
}

// 90 秒全速击杀：持续投放共 1440 只，波内攻防一致，ID 和经验有效。
{
  const w = new BattleWorld();
  w.setup({ ...setup, enemy: { ...enemy, rangedRatio: .4, swiftRatio: .2, chargerRatio: .1 } });
  const seen = new Set();
  const stats = new Map();
  let exp = 0;
  w.cb.onEnemyKilled = e => {
    assert.ok(!seen.has(e.id)); seen.add(e.id); exp += e.expValue;
  };
  for (let frame = 0; frame <= 2701 && w.result === 'ongoing'; frame++) {
    for (const e of [...w.aliveEnemies]) {
      const idx = w.waveProgress.alive.find(r => r.id === e.id).waveIndex;
      const tuple = [e.maxHp, e.atk, e.shotAtk, e.chargeDmg, e.maxShield];
      if (stats.has(idx)) assert.deepEqual(tuple, stats.get(idx));
      else stats.set(idx, tuple);
      w.damageEnemy(e, 99999);
    }
    w.update(1 / 30);
  }
  assert.equal(seen.size, 1440);
  assert.equal(exp, 1440 * 2);
  assert.equal(stats.size, 3);
  assert.equal(w.enemies.length, 0, '死亡实体不能持续累积');
  assert.equal(w.result, 'won');
}

// 边界及损坏恢复：29.9 秒续玩准确换波；坏进度回退开局并跳过已结算 ID。
{
  const w = new BattleWorld(); w.setup(setup); advance(w, 29.9);
  const p = w.waveProgress;
  const restored = new BattleWorld(); restored.setup({ ...setup, waveProgress: p });
  advance(restored, .1);
  assert.equal(restored.waveStatus.index, 2);
  const bad = new BattleWorld();
  bad.setup({ ...setup, waveProgress: { ...p, waveIndex: -5 }, killedEnemyIds: [1, 2] });
  assert.equal(bad.time, 0);
  assert.equal(bad.waveStatus.index, 1);
  assert.ok(bad.aliveEnemies.every(e => e.id > 2));
}
console.log('✅ 定时波次：90 秒持续投放、千只击杀、同屏限流、波内攻防、换波、清场与续玩边界通过');
