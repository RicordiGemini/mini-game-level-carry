import assert from 'node:assert/strict';
import { LevelFlow } from '../.test-build/core/LevelFlow.js';
import { SaveManager } from '../.test-build/core/SaveManager.js';
import { EquipmentManager } from '../.test-build/core/EquipmentManager.js';
import { createRunLoadout, emptyLoadout, gainExp } from '../.test-build/core/RunLoadout.js';
import { getLevelConfig, buildEnemySpawnSpec } from '../.test-build/data/LevelConfig.js';
import { MAX_RUN_LEVEL } from '../.test-build/data/RunConfig.js';
import { TALENT_TABLE } from '../.test-build/data/TalentConfig.js';
import { BattleWorld } from '../.test-build/battle/BattleWorld.js';
import { PLAYER_SPEED } from '../.test-build/battle/BattleTypes.js';
import { GameEntry } from '../.test-build/GameEntry.js';
import { sys } from '../.test-build/cc-stub.mjs';

function reset(levelId = 200) {
  sys.__storage.clear();
  SaveManager.profileCache = null;
  EquipmentManager.syncProfile();
  const flow = new LevelFlow();
  flow._state = {
    levelId, difficulty: 1, runId: 'growth-test', resources: { coin: 0 },
    stats: { hp: 100, atk: 0 }, loadout: createRunLoadout(['blade']),
    replay: { enabled: false, percent: 0 }, score: 0, elapsed: 5,
    kills: 0, cleared: false, carried: false, carrySource: 'none', updatedAt: 0,
  };
  flow._phase = 'PLAYING';
  return flow;
}
const talent = id => ({ kind: 'talent', talentId: id, slotIndex: -1, title: id, desc: '', subtitle: '', rarity: 0 });
function drain(flow) {
  let choices = 0;
  while (flow.phase === 'REWARD') {
    assert.ok(++choices < 100, '奖励队列必须结束');
    assert.equal(flow.chooseReward(0)?.ok, true);
  }
  return choices;
}

// 首关初始铁剑的真实伤害与成长联动：经历三波，首波升级并保留充足战斗时间。
{
  const f = reset(1); LevelFlow._inst = f;
  const world = new BattleWorld({ onEnemyKilled: e => f.onEnemyKilled(e.id, e.expValue, e.formExpValue) });
  const entry = { battle: { world, syncWeapons: weapons => world.syncWeapons(weapons) }, updateCounterPanel() {}, refreshHud() {} };
  f.onLoadoutChanged(() => GameEntry.prototype.syncCombatLoadout.call(entry));
  world.setup({ playerHp: 100, weapons: EquipmentManager.buildWeapons(f.current.loadout, f.current.stats, f.getModifier(), f.getAffinityMul()), enemy: buildEnemySpawnSpec(getLevelConfig(1)) });
  const choices = [];
  let weaponEvolutions = 0;
  for (let frame = 0; frame < 180 * 30 && world.result === 'ongoing'; frame++) {
    if (world.time > 25) {
      const near = world.aliveEnemies.sort((a, b) => Math.hypot(a.pos.x - world.player.pos.x, a.pos.y - world.player.pos.y) - Math.hypot(b.pos.x - world.player.pos.x, b.pos.y - world.player.pos.y))[0];
      if (near) {
        const dx = near.pos.x - world.player.pos.x, dy = near.pos.y - world.player.pos.y, distance = Math.hypot(dx, dy) || 1;
        world.setMoveInput({ x: dx / distance, y: dy / distance }, Math.min(1, distance / 20));
      }
    }
    world.update(1 / 30); f.addElapsed(1 / 30); f.flushBattleRewards();
    while (f.phase === 'REWARD') {
      choices.push(world.time);
      const options = f.getPendingRewards();
      let index = options.findIndex(o => o.kind === 'weapon_evolve');
      if (index >= 0) weaponEvolutions++;
      else index = options.findIndex(o => o.kind === 'weapon_upgrade');
      if (index < 0) index = options.findIndex(o => o.kind === 'aux_new' && o.formId === 'aux_blood');
      assert.equal(f.chooseReward(Math.max(0, index))?.ok, true);
    }
  }
  assert.equal(world.result, 'won', '初始铁剑配合选卡和移动可完成整局');
  assert.ok(world.time >= 90 - 1e-6, '不能在三波结束前通关');
  assert.ok(choices[0] < 20, '第一波内应能及时体验升级');
  assert.ok(choices.length >= 3, '整局体验多次升级');
  assert.ok(choices.length <= 18, '怪海不能再次造成三十余次频繁选卡');
  assert.ok(weaponEvolutions >= 1, '正常首局能通过强化与配套辅助体验进化');
  LevelFlow._inst = null;
}

// 小额经验加成跨击杀累积，续玩保留小数，达到门槛只入队一次。
{
  const f = reset(1);
  f.current.loadout.auxes = [{ id: 'aux_tome', formId: 'aux_tome', kind: 'aux', stage: 0, exp: 0 }];
  for (let id = 1; id <= 31; id++) f.onEnemyKilled(id);
  assert.equal(f.current.loadout.pendingExp, 69.44);
  const restored = new LevelFlow(); restored.boot();
  assert.equal(restored.current.loadout.pendingExp, 69.44);
  assert.equal(restored.current.loadout.weapons[0].exp, 104.16);
  restored.onEnemyKilled(32);
  assert.equal(restored.current.loadout.level, 2);
  assert.equal(Number(restored.current.loadout.pendingExp.toFixed(6)), 1.68);
  restored.onEnemyKilled(32);
  assert.deepEqual(restored.current.loadout.pendingLevelUps, [2]);
}

// 同帧三只怪死亡：每次经验/金币/属性仅结算一次，帧末才弹卡。
{
  const f = reset();
  const panels = [];
  f.onReward(p => panels.push(p.level));
  f.onEnemyKilled(1, 300);
  f.onEnemyKilled(2, 300);
  f.onEnemyKilled(3, 300);
  f.onEnemyKilled(1, 300);
  assert.equal(f.current.kills, 3);
  assert.equal(f.current.score, 3 * 420);
  const cfg = getLevelConfig(200);
  assert.equal(f.current.resources.coin, Math.floor(3 * cfg.reward.coin / cfg.enemies));
  assert.equal(f.current.stats.atk, Math.floor(3 * 48 / cfg.enemies));
  assert.equal(f.current.stats.hp, 100 + Math.floor(3 * 96 / cfg.enemies));
  assert.equal(f.current.loadout.weapons[0].exp, 900);
  assert.equal(f.phase, 'PLAYING');
  assert.equal(panels.length, 0);
  const queue = [...f.current.loadout.pendingLevelUps];
  f.flushBattleRewards();
  assert.equal(drain(f), queue.length);
  assert.deepEqual(panels, queue);
  assert.deepEqual(f.current.loadout.pendingLevelUps, []);
  assert.equal(f.chooseReward(0), null, '没有面板时重复点击不发奖');
}

// 单杀跨三级、暂停不推进战斗；现有面板和后续随机序列原样续玩。
{
  const f = reset();
  f.onEnemyKilled(1, 300);
  f.flushBattleRewards();
  assert.equal(f.current.loadout.level, 4);
  assert.deepEqual(f.current.loadout.pendingLevelUps, [2, 3, 4]);
  const state = JSON.stringify(f.current);
  const restored = new LevelFlow();
  let received;
  restored.onReward(p => received = p.options);
  restored.boot();
  assert.equal(restored.phase, 'REWARD');
  assert.deepEqual(received, JSON.parse(state).loadout.pending);
  assert.deepEqual(restored.current.loadout.pendingLevelUps, [2, 3, 4]);
  assert.equal(restored.chooseReward(0)?.ok, true);
  assert.equal(f.chooseReward(0)?.ok, true);
  assert.deepEqual(restored.getPendingRewards(), f.getPendingRewards(), '续玩后的下一轮卡片相同');
  assert.equal(restored.current.loadout.rewardSequence, 2);
  assert.equal(drain(restored), 2);
}

// 击杀保存与帧末生成卡片之间退出，也能从队列恢复，且失败选择不消费机会。
{
  const f = reset();
  f.onEnemyKilled(1, 300);
  assert.equal(SaveManager.loadLevel().loadout.pending.length, 0);
  const restored = new LevelFlow();
  restored.boot();
  assert.equal(restored.phase, 'REWARD');
  assert.deepEqual(restored.current.loadout.pendingLevelUps, [2, 3, 4]);
  const before = JSON.stringify(restored.current.loadout);
  assert.equal(restored.chooseReward(99), null);
  assert.equal(JSON.stringify(restored.current.loadout), before);
  restored.current.loadout.pending = [talent('missing-talent')];
  assert.equal(restored.chooseReward(0)?.ok, false);
  assert.deepEqual(restored.current.loadout.pendingLevelUps, [2, 3, 4]);
}

// 最后一只怪升级：选择、关闭程序、恢复、选完，最终仅结算一次。
{
  const f = reset(1);
  f.onEnemyKilled(1, 300);
  assert.equal(f.onLevelClear(), null);
  assert.equal(f.current.cleared, false);
  assert.equal(f.phase, 'REWARD');
  const restored = new LevelFlow();
  let settlements = 0;
  restored.onSettle(() => settlements++);
  restored.boot();
  assert.equal(drain(restored), 3);
  assert.equal(restored.phase, 'SETTLE');
  assert.equal(restored.current.cleared, true);
  const gold = SaveManager.getProfile().gold;
  restored.onLevelClear();
  assert.equal(SaveManager.getProfile().gold, gold);
  assert.equal(settlements, 1);
}

// 兼容只有 pending 的旧档，不追补无法推断的历史已领取次数。
{
  const f = reset();
  f.current.kills = 1;
  f.current.loadout.level = 4;
  delete f.current.loadout.pendingLevelUps;
  delete f.current.loadout.rewardSequence;
  f.current.loadout.pending = [talent('t_power')];
  SaveManager.saveLevel(f.current);
  const restored = new LevelFlow();
  restored.boot();
  assert.equal(restored.phase, 'REWARD');
  assert.deepEqual(restored.current.loadout.pendingLevelUps, [4]);
  assert.equal(drain(restored), 1);
}

// 续玩跳过已发过奖励的敌人；同一 ID 重复回调不再加经验。
{
  const f = reset(1);
  const cfg = getLevelConfig(1);
  const enemy = { ...buildEnemySpawnSpec(cfg), waves: undefined, batchSize: cfg.enemies };
  const world = new BattleWorld({ onEnemyKilled: e => f.onEnemyKilled(e.id, e.expValue, e.formExpValue) });
  world.setup({ playerHp: 100, weapons: [], enemy });
  world.damageEnemy(world.enemies[0], 9999);
  world.damageEnemy(world.enemies[0], 9999);
  assert.equal(f.current.kills, 1);
  const resumed = new BattleWorld();
  resumed.setup({ playerHp: 100, weapons: [], enemy, killedEnemyIds: f.current.killedEnemyIds });
  assert.equal(resumed.enemies.length, cfg.enemies - 1);
  assert.equal(resumed.enemies.some(e => e.id === 1), false);
  f.retryLevel();
  assert.deepEqual(f.current.killedEnemyIds, [], '战败重试是新战斗，保留成长且重置敌人去重表');
  const beforeRetryRewards = { kills: f.current.kills, exp: f.current.loadout.weapons[0].exp, coin: f.current.resources.coin };
  const retryWorld = new BattleWorld({ onEnemyKilled: e => f.onEnemyKilled(e.id, e.expValue, e.formExpValue) });
  retryWorld.setup({ playerHp: 100, weapons: [], enemy, killedEnemyIds: f.current.killedEnemyIds });
  retryWorld.damageEnemy(retryWorld.enemies[0], 9999);
  assert.deepEqual(
    { kills: f.current.kills, exp: f.current.loadout.weapons[0].exp, coin: f.current.resources.coin },
    beforeRetryRewards,
    '战败重试不得重复发放同一敌人的经验、金币和击杀成长'
  );
}

// 合成补选与升级队列独立；补选回退天赋也能结束。
{
  const f = reset();
  f.current.kills = 1;
  f.current.loadout.weapons = [
    { id: 'blade', formId: 'blade_rift', kind: 'weapon', stage: 2, exp: 1000, upgrades: 5 },
    { id: 'bow', formId: 'bow_rain', kind: 'weapon', stage: 3, exp: 1000, upgrades: 5 },
  ];
  f.current.loadout.auxes = ['aux_blood', 'aux_scope'].map(id => ({ id, formId: id, kind: 'aux', stage: 0, exp: 0 }));
  f.current.loadout.pendingLevelUps = [2, 3];
  f.current.loadout.pending = [{ kind: 'weapon_fusion', formId: 'fus_swordstorm', needFormId: 'bow_rain', slotIndex: 0 }];
  f._phase = 'REWARD';
  assert.equal(f.chooseReward(0)?.ok, true);
  assert.equal(f.current.loadout.pendingPicks, 1);
  assert.deepEqual(f.current.loadout.pendingLevelUps, [3]);
  f.current.loadout.pending = [talent('t_power')];
  assert.equal(f.chooseReward(0)?.ok, true);
  assert.equal(f.current.loadout.pendingPicks, 0);
  assert.deepEqual(f.current.loadout.pendingLevelUps, [3]);
  assert.equal(drain(f), 1);
}

// 战败停在选择面板：重启可恢复；重新挑战不丢成长且不重复发放旧敌人奖励；放弃会清理单局档。
{
  const f = reset(1);
  f.onEnemyKilled(1, 40, 100);
  const before = { kills: f.current.kills, exp: f.current.loadout.weapons[0].exp };
  f.markDefeat();
  assert.equal(f.phase, 'DEFEAT');
  assert.equal(SaveManager.loadLevel().defeatPending, true);

  const restored = new LevelFlow();
  let defeatPayload;
  restored.onDefeat(p => defeatPayload = p);
  restored.boot();
  assert.equal(restored.phase, 'DEFEAT');
  assert.equal(defeatPayload.kills, before.kills);
  restored.retryDefeated();
  assert.equal(restored.phase, 'PLAYING');
  assert.equal(restored.current.defeatPending, false);
  assert.deepEqual({ kills: restored.current.kills, exp: restored.current.loadout.weapons[0].exp }, before);
  restored.onEnemyKilled(1, 40, 100);
  assert.deepEqual({ kills: restored.current.kills, exp: restored.current.loadout.weapons[0].exp }, before,
    '重新挑战不得重复结算战败前已经领取过的敌人奖励');

  restored.markDefeat();
  restored.abandonDefeated();
  assert.equal(restored.phase, 'SELECT');
  assert.equal(SaveManager.loadLevel(), null);
}

// 编辑器 mock 广告可复活：清除战败标记并恢复 PLAYING，广告失败则仍停在 DEFEAT。
{
  const f = reset(1);
  f.markDefeat();
  assert.equal(await f.reviveDefeated(), true);
  assert.equal(f.phase, 'PLAYING');
  assert.equal(f.current.defeatPending, false);
}

// 没有任何可选内容时跳过空池，允许最终通关；满级不积累无限队列。
{
  const f = reset(1);
  f.current.kills = 1;
  f.current.loadout.weapons = Array.from({ length: 6 }, () => ({ id: 'blade', formId: 'blade_genesis', kind: 'weapon', stage: 4, exp: 0, upgrades: 5 }));
  f.current.loadout.auxes = Array.from({ length: 6 }, () => ({ id: 'aux_tome', formId: 'aux_tome_omniscient', kind: 'aux', stage: 2, exp: 0 }));
  f.current.loadout.talents = Object.fromEntries(TALENT_TABLE.map(t => [t.id, t.maxStacks]));
  f.current.loadout.pendingLevelUps = [2, 3];
  f.onLevelClear();
  assert.equal(f.phase, 'SETTLE');
  const lo = emptyLoadout();
  lo.level = MAX_RUN_LEVEL;
  assert.equal(gainExp(lo, 9999), 0);
  assert.deepEqual(lo.pendingLevelUps, []);
  assert.equal(gainExp(lo, Infinity), 0);
}

// 真实入口的同步调用：新武器、辅助、攻速、经验、生命、移速、反伤和护盾立即生效。
{
  const f = reset();
  LevelFlow._inst = f;
  const world = new BattleWorld();
  world.setup({ playerHp: 100, shield: 0, weapons: [], enemy: buildEnemySpawnSpec(getLevelConfig(1)) });
  const entry = {
    battle: { world, syncWeapons: weapons => world.syncWeapons(weapons) },
    updateCounterPanel() {}, refreshHud() {},
  };
  f.onLoadoutChanged(() => GameEntry.prototype.syncCombatLoadout.call(entry));
  function choose(opt) {
    f.current.kills = 1;
    f.current.loadout.pending = [opt];
    f.current.loadout.pendingLevelUps = [2];
    f._phase = 'REWARD';
    assert.equal(f.chooseReward(0)?.ok, true);
  }
  choose({ kind: 'weapon_new', formId: 'bow', slotIndex: -1 });
  assert.equal(world.weapons.length, 2);
  world.weapons[0].cd = 0.25;
  world.player.hp = 65;
  choose(talent('t_vital'));
  assert.equal(world.player.maxHp, 140);
  assert.equal(world.player.hp, 105, '保持已损失 35 生命');
  assert.equal(world.weapons[0].cd, 0.25, '同步保留冷却');
  choose(talent('t_stride'));
  assert.equal(world.player.speed, PLAYER_SPEED * 1.05);
  choose(talent('t_ward'));
  assert.equal(world.player.shield, 30);
  world.damagePlayer(12);
  choose(talent('t_thorn'));
  assert.equal(world.player.shield, 18, '选别的卡不会补满护盾');
  const target = world.enemies[0];
  const hp = target.hp;
  world._hurtCooldown = 0; // 此处单独验证荆棘同步，不受上一次护盾受击保护影响。
  world.damagePlayer(1, true, target);
  assert.equal(target.hp, hp - 8);
  const interval = world.weapons[0].interval;
  choose(talent('t_swift'));
  assert.ok(world.weapons[0].interval < interval);
  const damage = world.weapons[0].damage;
  // 低等级整数伤害会吞掉单层 6% 的显示变化，验证叠满后的实际输出。
  for (let i = 0; i < 6; i++) choose(talent('t_power'));
  assert.ok(world.weapons[0].damage > damage);
  choose({ kind: 'aux_new', formId: 'aux_tome', slotIndex: -1 });
  const expBefore = f.current.loadout.weapons[0].exp;
  f.onEnemyKilled(99, 100);
  assert.equal(f.current.loadout.weapons[0].exp - expBefore, 112, '智慧书加成作用于下一次击杀');
  const smallBefore = f.current.loadout.pendingExp;
  const smallFormBefore = f.current.loadout.weapons[0].exp;
  f.onEnemyKilled(10000, 2, 3);
  assert.equal(Number((f.current.loadout.pendingExp - smallBefore).toFixed(6)), 2.24, '低单杀经验保留智慧书加成');
  assert.equal(Number((f.current.loadout.weapons[0].exp - smallFormBefore).toFixed(6)), 3.36);
  for (let i = 0; i < 5; i++) choose({ kind: 'weapon_upgrade', formId: 'blade', slotIndex: 0 });
  choose({ kind: 'aux_new', formId: 'aux_blood', slotIndex: -1 });
  choose({ kind: 'weapon_evolve', formId: 'blade_edge', slotIndex: 0 });
  assert.equal(world.weapons[0].formId, 'blade_edge', '武器进化当场生效');
  choose({ kind: 'aux_evolve', formId: 'aux_tome_scholar', slotIndex: 0 });
  const evolvedExp = f.current.loadout.weapons[0].exp;
  f.onEnemyKilled(100, 100);
  assert.equal(f.current.loadout.weapons[0].exp - evolvedExp, 128, '辅助进化立即更新经验加成');
  LevelFlow._inst = null;
}

// 通过实际主循环驱动一帧群杀；奖励阶段不会继续推进世界或关卡计时。
{
  const f = reset(1);
  LevelFlow._inst = f;
  const cfg = getLevelConfig(1);
  const world = new BattleWorld({
    onEnemyKilled: e => f.onEnemyKilled(e.id, e.expValue, e.formExpValue),
    onCleared: () => f.onLevelClear(),
  });
  world.setup({ playerHp: 100, weapons: [], enemy: { ...buildEnemySpawnSpec(cfg), waves: undefined, batchSize: cfg.enemies } });
  world.updateProjectiles = () => {
    for (const e of world.enemies) world.damageEnemy(e, 99999);
  };
  let ticks = 0;
  const entry = {
    syncLayerByPhase() {}, refreshHud() {}, _retryTimer: 0,
    battle: { tick(dt) { ticks++; world.update(dt); } },
  };
  GameEntry.prototype.update.call(entry, 1 / 60);
  assert.equal(f.current.kills, cfg.enemies);
  assert.equal(f.current.loadout.weapons[0].exp, cfg.experience.totalFormExp);
  assert.equal(f.phase, 'REWARD');
  const elapsed = f.current.elapsed;
  GameEntry.prototype.update.call(entry, 1);
  assert.equal(ticks, 1);
  assert.equal(f.current.elapsed, elapsed);
  assert.equal(drain(f), cfg.experience.targetLevelUps);
  assert.equal(f.phase, 'SETTLE');
  LevelFlow._inst = null;
}

// 首关按真实批次推进：清掉当前批不会提前通关，每次选卡后仍有战斗。
{
  const f = reset(1);
  const cfg = getLevelConfig(1);
  let cleared = false;
  const world = new BattleWorld({
    onEnemyKilled: e => f.onEnemyKilled(e.id, e.expValue, e.formExpValue),
    onCleared: () => { cleared = true; f.onLevelClear(); },
  });
  world.setup({ playerHp: 100, weapons: [], enemy: buildEnemySpawnSpec(cfg) });
  assert.equal(cfg.enemies, 1440);
  assert.equal(cfg.batchSize, 12);
  assert.equal(cfg.batchInterval, 1);
  assert.equal(cfg.rangedRatio, 0, '普通首关先体验成长，不投放后退远程怪');
  assert.equal(getLevelConfig(2).rangedRatio, 0);
  assert.ok(getLevelConfig(3).rangedRatio > 0);
  assert.ok(getLevelConfig(1, 2).rangedRatio > 0, '困难仍保留远程压力');
  let choices = 0;
  const choiceKills = [];
  for (let frame = 0; frame < 90 * 30 + 2 && !cleared; frame++) {
    for (const e of [...world.aliveEnemies]) {
      world.damageEnemy(e, 99999);
      f.flushBattleRewards();
      if (f.phase === 'REWARD') {
        choiceKills.push(f.current.kills);
        choices += drain(f);
      }
    }
    world.update(1 / 30);
    if (world.time < 90 - .001) assert.equal(cleared, false, '波次时间未结束不能通关');
    f.noteWaveProgress(world.waveProgress);
  }
  assert.equal(choiceKills[0], 35);
  assert.ok(choices >= cfg.experience.targetLevelUps, '经验卡加成可增加选卡次数');
  assert.equal(f.current.kills, 1440);
  assert.ok(world.time >= 90 - .001);
  assert.equal(cleared, true);
  assert.equal(f.phase, 'SETTLE');
}

// 单局波次进度与升级队列一同恢复；未选卡期间不推进，重试回首波并保留奖励去重。
{
  const f = reset(1);
  const w = new BattleWorld();
  w.setup({ playerHp: 100000, weapons: [], enemy: buildEnemySpawnSpec(getLevelConfig(1)) });
  for (let i = 0; i < 31 * 30; i++) w.update(1 / 30);
  f.onEnemyKilled(1, 80, 120);
  f.noteWaveProgress(w.waveProgress);
  f.flushBattleRewards();
  const restored = new LevelFlow();
  restored.boot();
  assert.equal(restored.phase, 'REWARD');
  assert.equal(restored.current.waveProgress.waveIndex, 1);
  assert.deepEqual(restored.current.waveProgress, f.current.waveProgress);
  drain(restored);
  restored.markDefeat();
  assert.equal(await restored.reviveDefeated(), true);
  assert.equal(restored.current.waveProgress.waveIndex, 1, '复活保留波次');
  restored.markDefeat();
  restored.retryDefeated();
  assert.equal(restored.current.waveProgress, undefined, '重新挑战回首波');
  assert.deepEqual(restored.current.rewardedEnemyIds, [1]);
}

console.log('✅ 局内成长：群杀结算、逐级选卡、续玩、通关等待、合成补选与真实入口属性同步通过');
