#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 直接编译无依赖的运行时规则表，避免策划表复制一套经验公式后漂移。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runConfig = fs.readFileSync(path.join(projectRoot, 'assets/scripts/data/RunConfig.ts'), 'utf8');
const compiled = ts.transpileModule(runConfig, { compilerOptions: { module: ts.ModuleKind.ES2020 } }).outputText;
const { experienceBudgetFor, experienceShare, levelExpFor } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const encounterSource = fs.readFileSync(path.join(projectRoot, 'assets/scripts/data/EncounterConfig.ts'), 'utf8');
const encounterCompiled = ts.transpileModule(encounterSource, { compilerOptions: { module: ts.ModuleKind.ES2020 } }).outputText;
const { encounterFor } = await import(`data:text/javascript;base64,${Buffer.from(encounterCompiled).toString('base64')}`);

const LEVEL_MAX = 200;
const LEVEL_GROWTH = 0.10;
const DIFFICULTY_EASE = 1.0;
const RANGED_RATIO_MAX = 0.45;
const DIFFICULTIES = [
  { tier: 1, id: 'normal', name: '普通', hpMul: 1.0, atkMul: 1.0, speedMul: 1.0, countMul: 1.0, rangedRatio: 0.10 },
  { tier: 2, id: 'hard', name: '困难', hpMul: 1.9, atkMul: 1.45, speedMul: 1.10, countMul: 1.3, rangedRatio: 0.24 },
  { tier: 3, id: 'nightmare', name: '噩梦', hpMul: 3.3, atkMul: 2.05, speedMul: 1.20, countMul: 1.6, rangedRatio: 0.42 },
];
const FORMATIONS = ['scatter', 'line', 'cluster', 'swarm'];
const TYPES = ['melee', 'ranged', 'elite', 'swift', 'charger'];

function round(value) {
  return Math.round(value);
}

function parseArgs(argv) {
  const options = { maxLevel: LEVEL_MAX, boost: 0, out: 'configs/levels/roguelike-wave-plan.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-level') options.maxLevel = Math.max(1, Math.min(LEVEL_MAX, Number(argv[++i])));
    else if (arg === '--boost') options.boost = Math.max(0, Number(argv[++i]));
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/generate-wave-plan.mjs [--max-level 200] [--boost 0] [--out path]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!Number.isFinite(options.maxLevel) || !Number.isFinite(options.boost)) {
    throw new Error('--max-level 和 --boost 必须是数字');
  }
  return options;
}

function levelRangedBonus(levelId) {
  if (levelId <= 2) return 0;
  return Math.min(0.03, (levelId - 2) * 0.0025);
}

function formationForLevel(levelId) {
  return FORMATIONS[(levelId - 1) % FORMATIONS.length];
}

function allocateWithCapacity(total, waveSizes, remainingCapacity, ensureOne = false) {
  const result = Array(waveSizes.length).fill(0);
  if (total <= 0) return result;

  if (ensureOne && total >= waveSizes.length) {
    for (let waveIndex = 0; waveIndex < waveSizes.length; waveIndex += 1) {
      if (remainingCapacity[waveIndex] <= 0) {
        throw new Error(`波次 ${waveIndex + 1} 没有足够容量保证每波至少一个该类型`);
      }
      result[waveIndex] += 1;
      remainingCapacity[waveIndex] -= 1;
    }
    total -= waveSizes.length;
  }

  let cursor = 0;
  while (total > 0) {
    let assigned = false;
    for (let offset = 0; offset < waveSizes.length; offset += 1) {
      const waveIndex = (cursor + offset) % waveSizes.length;
      if (remainingCapacity[waveIndex] <= 0) continue;
      result[waveIndex] += 1;
      remainingCapacity[waveIndex] -= 1;
      total -= 1;
      cursor = (waveIndex + 1) % waveSizes.length;
      assigned = true;
      break;
    }
    if (!assigned) throw new Error('波次容量不足，无法分配敌人类型');
  }
  return result;
}

function countByRuntimeRule(total, ratio, maxFrac) {
  return Math.min(round(total * Math.max(0, Math.min(1, ratio))), Math.floor(total * maxFrac));
}

function buildPlan(levelId, difficulty, replayBoost) {
  const boost = Math.max(0, replayBoost);
  const boostMul = 1 + boost;
  const levelScale = Math.pow(1 + LEVEL_GROWTH, levelId - 1) * DIFFICULTY_EASE;
  const encounter = encounterFor(levelId, difficulty.countMul, boost);
  const { enemies, batchSize } = encounter;
  const experience = experienceBudgetFor(enemies, difficulty.tier, true);
  let runLevel = 1, progress = 0;
  const upgradeKills = [];
  for (let index = 0; index < enemies; index++) {
    progress += experienceShare(experience.totalExp, enemies, index);
    while (runLevel < 60 && progress >= levelExpFor(runLevel)) {
      progress -= levelExpFor(runLevel++);
      upgradeKills.push(index + 1);
    }
  }
  const rangedRatio = levelId <= 2 && difficulty.tier === 1 ? 0 : Math.min(RANGED_RATIO_MAX, difficulty.rangedRatio + levelRangedBonus(levelId) + boost * 0.06);
  const isNightmare = difficulty.tier === 3;
  const ranged = countByRuntimeRule(enemies, rangedRatio, 0.6);
  const elite = 0;
  const swift = countByRuntimeRule(enemies, isNightmare ? 0.12 : 0, 1);
  const charger = countByRuntimeRule(enemies, isNightmare ? 0.05 : 0, 1);
  const melee = enemies - ranged - elite - swift - charger;
  if (melee < 0) throw new Error(`关卡 ${levelId}/${difficulty.id} 的类型数量超出总数`);

  const waveCount = encounter.waves.length;
  const waveSizes = encounter.waves.map(w => Math.ceil(w.duration / w.spawnInterval) * w.spawnCount);
  const typeCounts = { melee, ranged, elite, swift, charger };
  const remainingCapacity = [...waveSizes];
  const perWave = {};
  for (const type of ['ranged', 'elite', 'swift', 'charger', 'melee']) {
    perWave[type] = allocateWithCapacity(
      typeCounts[type],
      waveSizes,
      remainingCapacity,
      type === 'ranged',
    );
  }
  const baseEnemyAtk = levelScale;
  const shotAtk = Math.max(2, round(baseEnemyAtk * difficulty.atkMul * 0.72 * boostMul));
  const typeSpec = {
    melee: { hpMul: 1, atkMul: 1, speedMul: 1, ranged: false, warningSec: 0, special: '近战接触' },
    ranged: { hpMul: 0.72, atkMul: Number((shotAtk / Math.max(1, round(baseEnemyAtk * difficulty.atkMul * boostMul))).toFixed(4)), speedMul: 1.15, ranged: true, warningSec: 0.5, special: '远程压制' },
    elite: { hpMul: 1, atkMul: 1, speedMul: 0.7, ranged: false, warningSec: 0.6, special: '定时波次不生成精英护盾单位' },
    swift: { hpMul: 0.7, atkMul: 1, speedMul: 1.7, ranged: false, warningSec: 0.25, special: '高速突进' },
    charger: { hpMul: 1.2, atkMul: 1, speedMul: 1, ranged: false, warningSec: 0.8, special: '冲锋预警（命中伤害 ×2）' },
  };
  const waves = waveSizes.map((_, waveIndex) => ({
    waveId: waveIndex + 1,
    startSec: encounter.waves.slice(0, waveIndex).reduce((n, w) => n + w.duration, 0),
    durationSec: encounter.waves[waveIndex].duration,
    spawnIntervalSec: encounter.waves[waveIndex].spawnInterval,
    spawnCount: encounter.waves[waveIndex].spawnCount,
    maxAlive: encounter.maxAlive,
    continuous: true,
    hpMul: encounter.waves[waveIndex].hpMul,
    atkMul: encounter.waves[waveIndex].atkMul,
    formation: formationForLevel(levelId),
    entries: TYPES.filter((type) => perWave[type][waveIndex] > 0).map((type) => ({
      enemyType: type,
      count: perWave[type][waveIndex],
      ...typeSpec[type],
      hpMul: encounter.waves[waveIndex].hpMul,
      atkMul: encounter.waves[waveIndex].atkMul,
    })),
  }));

  const summary = {
    totalEnemies: enemies,
    batchSize,
    waveCount,
    lastWaveStartSec: encounter.waves.slice(0, -1).reduce((n, w) => n + w.duration, 0),
    durationSec: encounter.waves.reduce((n, w) => n + w.duration, 0),
    maxAlive: encounter.maxAlive,
    rangedCount: ranged,
    configuredRangedRatio: Number(rangedRatio.toFixed(4)),
    rangedRatio: Number((ranged / enemies).toFixed(4)),
    eliteCount: elite,
    swiftCount: swift,
    chargerCount: charger,
    meleeCount: melee,
    note: '数量与类型为未触发同屏限流时的估算；实际持续生成，同屏满时跳过该次投放，击杀奖励按实际敌人发放。',
  };

  return {
    levelId,
    difficulty: difficulty.tier,
    difficultyId: difficulty.id,
    difficultyName: difficulty.name,
    replayBoost: boost,
    source: 'LevelConfig.ts + DifficultyConfig.ts + BattleWorld.ts',
    summary,
    experience: {
      ...experience,
      averageExpPerEnemy: Number((experience.totalExp / enemies).toFixed(4)),
      averageFormExpPerEnemy: Number((experience.totalFormExp / enemies).toFixed(4)),
      firstUpgradeKill: upgradeKills[0],
      lastUpgradeKill: upgradeKills.at(-1),
      upgradeKills,
      finalLevel: runLevel,
      finalLevelExp: progress,
      assumptions: `新局 Lv.1、每杀角色经验 ${experience.totalExp / enemies}、装备经验 ${experience.totalFormExp / enemies}、无经验加成；按未限流的预计数量全部击杀估算。`,
    },
    waves,
  };
}

function validatePlan(plan) {
  const waveTotal = plan.waves.reduce((sum, wave) => sum + wave.entries.reduce((n, entry) => n + entry.count, 0), 0);
  if (waveTotal !== plan.summary.totalEnemies) throw new Error(`关卡 ${plan.levelId}/${plan.difficultyId} 波次总数不守恒`);
  if (plan.waves.length !== plan.summary.waveCount) throw new Error(`关卡 ${plan.levelId}/${plan.difficultyId} 波次数不匹配`);
  let lastStart = -Infinity;
  const typeTotals = Object.fromEntries(TYPES.map((type) => [type, 0]));
  for (const [waveIndex, wave] of plan.waves.entries()) {
    if (wave.startSec < lastStart) throw new Error(`关卡 ${plan.levelId}/${plan.difficultyId} 波次时间倒退`);
    lastStart = wave.startSec;
    const waveTotalForIndex = wave.entries.reduce((sum, entry) => sum + entry.count, 0);
    const expectedWaveSize = Math.ceil(wave.durationSec / wave.spawnIntervalSec) * wave.spawnCount;
    if (waveTotalForIndex !== expectedWaveSize) {
      throw new Error(`关卡 ${plan.levelId}/${plan.difficultyId} 第 ${wave.waveId} 波容量不匹配`);
    }
    for (const entry of wave.entries) typeTotals[entry.enemyType] += entry.count;
  }
  for (const type of TYPES) {
    if (typeTotals[type] !== plan.summary[`${type}Count`]) throw new Error(`关卡 ${plan.levelId}/${plan.difficultyId} ${type} 数量不守恒`);
  }
  if (plan.summary.configuredRangedRatio > RANGED_RATIO_MAX + 1e-9) throw new Error(`关卡 ${plan.levelId}/${plan.difficultyId} 远程配置比例越界`);
  if (plan.experience.upgradeKills.length !== plan.experience.targetLevelUps) throw new Error('升级次数与经验预算不符');
  if (plan.experience.firstUpgradeKill <= 1 || plan.experience.lastUpgradeKill > plan.summary.totalEnemies) throw new Error('基础升级节奏越界');
}

const options = parseArgs(process.argv.slice(2));
const levels = [];
for (let levelId = 1; levelId <= options.maxLevel; levelId += 1) {
  for (const difficulty of DIFFICULTIES) {
    const plan = buildPlan(levelId, difficulty, options.boost);
    validatePlan(plan);
    levels.push(plan);
  }
}
const output = {
  schemaVersion: 3,
  generatedBy: 'tools/generate-wave-plan.mjs',
  rules: {
    levelCount: options.maxLevel,
    replayBoost: options.boost,
    waveDurationSec: 30,
    waveCountFormula: '3 timed waves, continuously replenished',
    rangedRatioMax: RANGED_RATIO_MAX,
    runtimeBoundary: 'LevelConfig 与生成器共用 EncounterConfig；BattleWorld 通过 EnemySpawnSpec.waves 接收定时波次。数量为估算，不是清场门槛。',
  },
  levels,
};
const outputPath = path.resolve(process.cwd(), options.out);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const csvPath = outputPath.replace(/\.json$/i, '') + '-experience.csv';
const rows = [['levelId', 'difficulty', 'enemies', 'targetLevelUps', 'totalExp', 'totalFormExp', 'averageExpPerEnemy', 'firstUpgradeKill', 'lastUpgradeKill', 'upgradeKills']];
for (const p of levels) rows.push([
  p.levelId, p.difficultyId, p.summary.totalEnemies, p.experience.targetLevelUps,
  p.experience.totalExp, p.experience.totalFormExp, p.experience.averageExpPerEnemy,
  p.experience.firstUpgradeKill, p.experience.lastUpgradeKill, p.experience.upgradeKills.join('/'),
]);
fs.writeFileSync(csvPath, '\ufeff' + rows.map(row => row.join(',')).join('\n') + '\n', 'utf8');
console.log(`已生成 ${levels.length} 份关卡波次规划: ${outputPath}`);
console.log(`经验预算与升级节点表: ${csvPath}`);
