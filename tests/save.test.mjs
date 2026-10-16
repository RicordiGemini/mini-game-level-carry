/**
 * 存档与迁移链测试。
 *
 * 【为什么这一套最重要】
 *   存档是**唯一不能出错**的地方 —— 数值错了玩家少拿一点奖励，
 *   存档错了玩家 centuries 的积累全没了。而且迁移链一旦断了，
 *   后果是不可逆的（玩家回不去旧版本）。
 *
 * 【本套件能成立的前提】
 *   `SaveManager` 的全部持久化都走 `sys.localStorage` 这一个出口，
 *   而 `tools/build-tests.mjs` 里的 cc 桩提供了内存版实现。
 *   所以整套存档逻辑可以在 Node 里跑 —— 这是当初
 *   "战斗层不认识属性表" 那条架构约束带来的红利。
 */

import {
  SaveManager, SAVE_VERSION,
} from '../.test-build/core/SaveManager.js';
import { stableStringify, sign, verify } from '../.test-build/core/HashUtil.js';
import { sys } from '../.test-build/cc-stub.mjs';
import { REPLAY_BOOST_STEPS, REPLAY_BOOST_MAX } from '../.test-build/data/GameTypes.js';

import { createSuite } from './assert.mjs';

const t = createSuite('存档与迁移链测试');
const { section, ok, eq, expectClean } = t;

/**
 * 每次用例前重置：**存储 + 静态缓存**。
 *
 * ⚠️ 缓存这一项不能漏 —— `SaveManager` 用 `private static profileCache`
 * 缓存当前档案。清空 localStorage 而不清缓存的话，
 * 后续所有用例拿到的都是第一次的旧档案，测试会"莫名其妙地全绿"。
 * TS 的 private 只是编译期约束，运行时可以直接改。
 */
function reset() {
  sys.__storage.clear();
  SaveManager.profileCache = null;
}

// ==================================================================
section('1 · 签名机制');

{
  // 1.1 key 顺序不影响签名 —— 这是 stableStringify 存在的全部理由
  const a = { x: 1, y: 2, z: 3 };
  const b = { z: 3, y: 2, x: 1 };
  eq(sign(a), sign(b), '1.1 key 顺序不影响签名');
  eq(stableStringify(a), stableStringify(b), '1.2 序列化结果一致');
}

{
  // 1.2 嵌套对象的 key 顺序同样无关
  const a = { outer: { p: 1, q: 2 }, list: [{ m: 1, n: 2 }] };
  const b = { list: [{ n: 2, m: 1 }], outer: { q: 2, p: 1 } };
  eq(sign(a), sign(b), '1.3 嵌套 key 顺序不影响签名');
}

{
  // 1.3 改一个字节签名就变
  eq(sign({ gold: 100 }) === sign({ gold: 101 }), false, '1.4 数值改动签名变化');
  eq(sign({ a: 1 }) === sign({ a: 1, b: 0 }), false, '1.5 多一个键签名变化');
}

{
  // 1.4 verify 的正反例
  const data = { gold: 500, crystals: 10 };
  const s = sign(data);
  eq(verify(data, s), true, '1.6 正确签名通过');
  eq(verify({ gold: 501 }, s), false, '1.7 数据被改 → 拒绝');
  eq(verify(data, ''), false, '1.8 空签名拒绝');
  eq(verify(data, null), false, '1.9 null 签名拒绝');
  eq(verify(data, 123), false, '1.10 非字符串签名拒绝');
}

{
  // 1.5 浮点精度：统一保留 6 位，避免 0.1+0.2 类误差导致签名漂移
  eq(stableStringify(0.5), '0.500000', '1.11 浮点保留 6 位');
  eq(stableStringify(10), '10', '1.12 整数不补小数');
  eq(sign({ v: 1 / 3 }), sign({ v: 0.333333333 }), '1.13 第 6 位之后的不同不影响签名');
}

// ==================================================================
section('2 · 建档与读写');

{
  reset();
  const p = SaveManager.getProfile();
  eq(p.version, SAVE_VERSION, '2.1 新号档案版本正确');
  eq(p.gold, 0, '2.2 新号金币 0');
  eq(p.crystals, 0, '2.3 新号水晶 0');
  eq(p.equipment.length, 0, '2.4 新号无装备');
  eq(p.globalMaxTier, 1, '2.5 新号全局最高难度 1');
  eq(p.totalAdViews, 0, '2.6 新号广告计数 0');
  ok(p.tutorials && typeof p.tutorials === 'object', '2.7 新号有 tutorials 字段');
}

{
  reset();
  SaveManager.getProfile();   // 触发建档
  const keys = Object.keys(sys.__storage.__dump());
  eq(keys, ['mg_profile'], '2.8 只写入 mg_profile');
  const payload = JSON.parse(sys.__storage.__dump().mg_profile);
  ok(typeof payload.sig === 'string' && payload.sig.length > 0, '2.9 存档带签名');
  ok(typeof payload.ts === 'number', '2.10 存档带时间戳');
}

{
  reset();
  SaveManager.addGold(1000);
  eq(SaveManager.getProfile().gold, 1000, '2.11 addGold 生效');
  // addGold 明确拒绝 amount <= 0（它是"发放"入口，扣费走别处）
  SaveManager.addGold(-400);
  eq(SaveManager.getProfile().gold, 1000, '2.12 负数 addGold 被忽略');
  SaveManager.addGold(0);
  eq(SaveManager.getProfile().gold, 1000, '2.13 零 addGold 被忽略');
}

{
  reset();
  SaveManager.getProfile();
  SaveManager.bumpAdView();
  SaveManager.bumpAdView();
  eq(SaveManager.getProfile().totalAdViews, 2, '2.13 广告计数累加');
}

{
  reset();
  SaveManager.getProfile();
  SaveManager.bumpRestart();
  eq(SaveManager.getProfile().totalRestarts, 1, '2.14 重启计数累加');
}

{
  reset();
  SaveManager.getProfile();
  SaveManager.addCounters(10, 2, 3);
  const p = SaveManager.getProfile();
  eq(p.totalKills, 10, '2.15 击杀累计');
  eq(p.fusionCount, 2, '2.16 合成累计');
  eq(p.affinityClearCount, 3, '2.17 推荐通关累计');
}

// ==================================================================
section('3 · 签名失败会删档（已知风险）');

{
  reset();
  SaveManager.getProfile();
  SaveManager.addGold(999);
  eq(SaveManager.getProfile().gold, 999, '3.1 写档成功');

  // 篡改底层数据（模拟玩家用工具改档）
  const raw = JSON.parse(sys.__storage.__dump().mg_profile);
  const data = Object.assign({}, raw.data, { gold: 999999 });
  sys.__storage.setItem('mg_profile', JSON.stringify({
    data, sig: raw.sig, ts: raw.ts,
  }));
  SaveManager.profileCache = null;   // 必须清缓存，否则读的还是上一次的对象

  eq(SaveManager.getProfile().gold, 0, '3.2 签名不符 → 降级为新号');
  eq(sys.__storage.getItem('mg_profile') === null, false,
    '3.3 记录仍在存储里（会重建一份干净的）');
}

// ==================================================================
section('4 · 难度解锁');

{
  reset();
  SaveManager.getProfile();
  eq(SaveManager.getMaxTier(1), 1, '4.1 新号第 1 关只解锁普通');
  eq(SaveManager.isTierUnlocked(1, 2), false, '4.2 困难未解锁');
  eq(SaveManager.isTierUnlocked(1, 3), false, '4.3 噩梦未解锁');
}

{
  reset();
  SaveManager.getProfile();
  eq(SaveManager.unlockTier(1, 2), true, '4.4 解锁困难返回 true');
  eq(SaveManager.unlockTier(1, 2), false, '4.5 重复解锁返回 false');
  eq(SaveManager.isTierUnlocked(1, 2), true, '4.6 困难已解锁');
  eq(SaveManager.isTierUnlocked(1, 3), false, '4.7 噩梦仍锁着');
}

{
  // 每关独立难度轴：第 1 关打到噩梦，不影响第 2 关
  reset();
  SaveManager.getProfile();
  SaveManager.unlockTier(1, 2);
  SaveManager.unlockTier(1, 3);
  eq(SaveManager.getMaxTier(1), 3, '4.8 第 1 关解锁到噩梦');
  eq(SaveManager.getMaxTier(2), 1, '4.9 第 2 关仍是普通（每关独立）');
  eq(SaveManager.getGlobalMaxTier(), 3, '4.10 全局最高难度取各关最大值');
}

{
  // 越界要收敛，不能写入非法 tier
  reset();
  SaveManager.getProfile();
  SaveManager.unlockTier(1, 99);
  eq(SaveManager.getMaxTier(1), 3, '4.11 越界 tier 收敛到 3');
}

// ==================================================================
section('5 · 关卡解锁');

{
  reset();
  SaveManager.getProfile();
  eq(SaveManager.getProfile().unlockedLevel, 1, '5.1 新号只解锁第 1 关');
  SaveManager.unlockLevel(3);
  eq(SaveManager.getProfile().unlockedLevel, 3, '5.2 解锁到第 3 关');
  SaveManager.unlockLevel(2);   // 倒退
  eq(SaveManager.getProfile().unlockedLevel, 3, '5.3 倒退解锁不生效');
}

// ==================================================================
section('6 · 档案键位');

{
  reset();
  SaveManager.getProfile();
  eq(SaveManager.archiveKey(3, 2), 'mg_archive_3_2', '6.1 关卡×难度双主键');
  eq(SaveManager.statKey(3, 2), '3_2', '6.2 统计键格式');
}

{
  // 同关不同难度必须是不同的键 —— 否则纪录会互相覆盖
  const keys = [1, 2, 3].map((tier) => SaveManager.archiveKey(3, tier));
  eq(new Set(keys).size, 3, '6.3 同关三档难度键互不相同');
}

{
  reset();
  SaveManager.getProfile();
  eq(SaveManager.hasArchive(3, 1), false, '6.4 无档案');
  const archive = {
    levelId: 3, tier: 1,
    loadout: { resources: { coin: 100 }, stats: { atk: 10, hp: 100 }, equipment: [], talents: {} },
    bestScore: 1234, bestTime: 45.6, clearCount: 1,
  };
  SaveManager.saveArchive(archive);
  eq(SaveManager.hasArchive(3, 1), true, '6.5 写档后可查到');
  eq(SaveManager.hasArchive(3, 2), false, '6.6 另一难度不受影响');

  const loaded = SaveManager.loadArchive(3, 1);
  eq(loaded.bestScore, 1234, '6.7 最高分往返');
  eq(loaded.bestTime, 45.6, '6.8 最快时间往返');
  eq(loaded.clearCount, 1, '6.9 通关次数往返');
}

{
  reset();
  SaveManager.getProfile();
  SaveManager.saveArchive({
    levelId: 3, tier: 1,
    loadout: { resources: {}, stats: {}, equipment: [], talents: {} },
    bestScore: 100, bestTime: 60, clearCount: 1,
  });
  SaveManager.dropArchive(3, 1);
  eq(SaveManager.hasArchive(3, 1), false, '6.10 删档生效');
}

// ==================================================================
section('7 · 复玩计数与加难');

{
  reset();
  SaveManager.getProfile();
  eq(SaveManager.getReplayCount(3, 1), 0, '7.1 新号复玩次数 0');
  eq(SaveManager.bumpReplay(3, 1), 1, '7.2 bumpReplay 返回新值');
  eq(SaveManager.getReplayCount(3, 1), 1, '7.3 复玩次数已持久化');
  eq(SaveManager.hasReplayed(3, 1), true, '7.4 hasReplayed 正确');
}

{
  // 复玩统计必须按关卡×难度分开
  reset();
  SaveManager.getProfile();
  SaveManager.bumpReplay(3, 1);
  SaveManager.bumpReplay(3, 1);
  eq(SaveManager.getReplayCount(3, 1), 2, '7.5 第 3 关普通 2 次');
  eq(SaveManager.getReplayCount(3, 2), 0, '7.6 第 3 关困难仍是 0');
  eq(SaveManager.getReplayCount(7, 1), 0, '7.7 第 7 关普通仍是 0');
}

{
  reset();
  SaveManager.getProfile();
  SaveManager.setReplayBoost(3, 1, 0.3);
  eq(SaveManager.getReplayBoost(3, 1), 0.3, '7.8 加难档位往返');
  eq(SaveManager.getReplayBoost(3, 2), 0, '7.9 另一难度不受影响');
}

{
  // UI 刻度与存档兜底的关系（见 GameTypes 里REPLAY_BOOST_MAX 的注释）
  eq(REPLAY_BOOST_STEPS, [0, 0.15, 0.3, 0.5, 0.8, 1.2], '7.9a UI 档位刻度 6 档，最大 +120%');
  eq(REPLAY_BOOST_MAX, 3.0, '7.9b 存档兜底上限 3.0');
  ok(REPLAY_BOOST_MAX > Math.max(...REPLAY_BOOST_STEPS),
    '7.9c 兜底上限大于 UI 上限（改档后读档行为才一致）',
    '若两者相等，防注入的收敛会失去意义');
  ok(REPLAY_BOOST_STEPS.every((v) => v >= 0 && v <= REPLAY_BOOST_MAX),
    '7.9d 每个 UI 档位都在兜底上限内');
}

{
  // 加难百分比必须落在合法区间内
  reset();
  SaveManager.getProfile();
  SaveManager.setReplayBoost(3, 1, 99);
  // 上限是 REPLAY_BOOST_MAX = 3.0（+300%）。
  // 注意 UI 只提供到 +120%（REPLAY_BOOST_STEPS），但 API 允许存到 3.0。
  eq(SaveManager.getReplayBoost(3, 1), 3.0, '7.10 超范围加难收敛到 REPLAY_BOOST_MAX=3.0');
  SaveManager.setReplayBoost(3, 1, -5);
  eq(SaveManager.getReplayBoost(3, 1), 0, '7.11 负数加难归零');
}

// ==================================================================
section('8 · 图鉴');

{
  reset();
  SaveManager.getProfile();
  SaveManager.markFormsSeen(['blade', 'bow', 'fus_x']);
  const seen = SaveManager.getSeenForms();
  ok(seen.includes('blade'), '8.1 已见形态被记录');
  ok(seen.includes('fus_x'), '8.2 合成形态也能记录');
  eq(new Set(seen).size, seen.length, '8.3 不产生重复项');
}

{
  // 重复标记不应重复计数
  reset();
  SaveManager.getProfile();
  SaveManager.markFormsSeen(['blade']);
  SaveManager.markFormsSeen(['blade', 'bow']);
  const seen = SaveManager.getSeenForms();
  eq(seen.length, 2, '8.4 重复标记不增加条目数');
}

// ==================================================================
section('9 · resetAll');

{
  reset();
  SaveManager.getProfile();
  SaveManager.addGold(1000);
  SaveManager.unlockTier(1, 3);
  SaveManager.saveArchive({
    levelId: 1, tier: 1,
    loadout: { resources: {}, stats: {}, equipment: [], talents: {} },
    bestScore: 100, bestTime: 30, clearCount: 1,
  });
  ok(Object.keys(sys.__storage.__dump()).length > 0, '9.1 清理前有数据');

  SaveManager.resetAll();
  const keys = Object.keys(sys.__storage.__dump());
  eq(keys.includes('mg_archive_1_1'), false, '9.2 档案被清');
  eq(SaveManager.getProfile().gold, 0, '9.3 金币归零');
  eq(SaveManager.getMaxTier(1), 1, '9.4 难度锁回普通');
}

// ==================================================================
section('10 · 迁移链');

{
  // 10.1 SAVE_VERSION 与迁移函数必须同步
  //     若迁移函数缺失，v(version-1) 的存档会被当成 v8 读，字段全是 undefined
  eq(SAVE_VERSION, 8, '10.1 SAVE_VERSION = 8');
}

{
  // 10.2 缺失字段要能兜底 —— 老档不该让 getProfile 崩
  reset();
  // 伪造一个"缺一堆字段"的 v8 档
  const minimal = { version: 8, gold: 100, unlockedLevel: 5 };
  const payload = { data: minimal, sig: sign(minimal), ts: Date.now() };
  sys.__storage.setItem('mg_profile', JSON.stringify(payload));
  SaveManager.profileCache = null;

  const p = SaveManager.getProfile();
  eq(p.gold, 100, '10.2 保留已有字段');
  eq(p.unlockedLevel, 5, '10.3 保留已有进度');
  ok(Array.isArray(p.equipment), '10.4 equipment 补成空数组');
  ok(p.tutorials && typeof p.tutorials === 'object', '10.5 tutorials 补成空对象');
  ok(typeof p.crystals === 'number', '10.6 crystals 补默认值');
}

{
  // 10.3 坏档必须安全降级，不能抛异常
  reset();
  sys.__storage.setItem('mg_profile', '{"data":"不是JSON","sig":"xxx","ts":1}');
  let threw = false;
  let p = null;
  try { p = SaveManager.getProfile(); } catch (e) { threw = true; }
  ok(!threw, '10.7 坏档不抛异常');
  if (p) eq(p.version, SAVE_VERSION, '10.8 坏档降级为新号');
}

{
  // 10.4 签名错误的档不会把可疑数据带进逻辑
  reset();
  const forged = { version: 8, gold: 999999, unlockedLevel: 999 };
  sys.__storage.setItem('mg_profile', JSON.stringify({
    data: JSON.stringify(forged), sig: 'deadbeef', ts: Date.now(),
  }));
  const p = SaveManager.getProfile();
  ok(p.gold !== 999999, '10.9 伪造的金币不生效',
    `实际 gold=${p.gold}`);
  ok(p.unlockedLevel < 999, '10.10 伪造的关卡进度不生效',
    `实际 unlockedLevel=${p.unlockedLevel}`);
}

{
  // 10.5 hasReplayed 与 replayCounts 的关系
  //     （addCounters 之外，复玩判定应只看 replayCounts）
  reset();
  SaveManager.getProfile();
  eq(SaveManager.hasReplayed(1, 1), false, '10.11 新号未复玩');
  SaveManager.bumpReplay(1, 1);
  eq(SaveManager.hasReplayed(1, 1), true, '10.12 复玩后可查询');
}

const result = t.report();
if (result.failed > 0) process.exitCode = 1;
export { result };