/**
 * 关卡流程状态机 —— 难度 / 复玩加难 / 三选一 / 继承 的中枢
 *
 * 状态流转：
 *
 *   SELECT          关卡选择界面
 *     ↓ openDifficultySelect(levelId)
 *   DIFFICULTY      难度选择面板（每关三档：普通 / 困难 / 噩梦）
 *     ↓ openLevel(levelId, tier)
 *     ├─ 该难度有档案 → LOADOUT（看广告继承 / 重新开始）
 *     │                    ↓
 *     │                  （若该难度通关过）REPLAY_BOOST  选是否加难、加多少
 *     │                    ↓
 *     ├─ 无档案 + 更低难度有档案 → 直接开局（**默认免费继承**低难度装备）
 *     └─ 都没档案 → 直接开局（初始数据）
 *   PLAYING  ── 升级 ──→ REWARD  三选一（战斗暂停，等玩家选）
 *     │                    ↓
 *     │                  （合成消耗槽位时）再次 REWARD 补选武器
 *     ↓ onLevelClear()
 *   SETTLE   写入档案 + 解锁难度 + 成就结算
 *
 * 【难度维度的三条规则】
 *   1. 难度解锁是每关独立的：第 3 关打到困难，不会让第 5 关也解锁困难
 *   2. 首次进入更高难度默认免费继承低难度通关时的装备 —— 高难度怪更硬，
 *      不给继承就是纯劝退，这条不设广告
 *   3. 同一难度的复玩才走广告继承（此时玩家要的是"冲更高纪录"，
 *      带着巅峰装备重来一次的动机最强，广告价值也最高）
 *
 * 【复玩加难为什么做成一档可选刻度】
 *   复玩的核心动机是"冲更高分"。但如果三档难度的数值是固定的，
 *   玩家把噩梦打穿之后就没有更高的目标了 —— 这一关就"死"了。
 *   允许自选加难百分比，等于把难度上限交给玩家，同一关可以一直往上加码。
 *   它与档位倍率是乘算关系，所以不会破坏新手体验（不开就是原样）。
 *
 * 【三选一为什么要暂停战斗】
 *   如果把三选一做成"边打边弹"，玩家会在被围殴时被迫做选择，体验极差。
 *   暂停之后，三选一变成一次真正的"决策间歇"：
 *   玩家可以静下心比较三张卡，这也是三张卡能产生意义的前提。
 */

import {
    AttrMap,
    CombatModifier,
    DifficultyDef,
    EquipRunState,
    EvolutionEvent,
    LevelArchive,
    LevelConfigItem,
    LevelState,
    REPLAY_BOOST_STEPS,
    ReplayBoost,
    RewardOption,
    RunLoadoutState,
    RunSummary,
} from '../data/GameTypes';
import { buildLoadout, describeLoadout, getLevelConfig, hasNextLevel } from '../data/LevelConfig';
import { getDifficulty, hasNextTier, normalizeTier } from '../data/DifficultyConfig';
import { ALL_FORMS } from '../data/FormConfig';
import { affinityDamageMul, affinityNames } from '../data/LevelAffinity';
import { auxSlotCap, weaponSlotCap } from '../data/RunConfig';
import { EquipmentManager } from './EquipmentManager';
import { grantDrops, mergeArmorBonus, rollDrops } from './ForgeManager';
import {
    ApplyResult, applyReward, createRunLoadout, gainExp, levelProgress,
} from './RunLoadout';
import {
    allFormIdsOf, aggregateModifier, maxDepthOf, weaponRootsOf,
} from './FormGraph';
import {
    addCrystals, auxInnateOf, auxRankMulOf, auxRarityMulOf,
} from './GachaManager';
import { crystalRewardOf, CRYSTAL_PER_PULL, MAX_PULL_BATCH } from '../data/GachaConfig';
import { RewardContext, pickRewards } from './RewardPicker';
import {
    contextFromProfile, judgeAchievements, toRecords, totalGoldOf,
} from './AchievementManager';
import { AdReward, AdTag } from '../ad/AdReward';
import { SaveManager } from './SaveManager';
import { makeRunId } from './HashUtil';
import { makeRng } from '../battle/BattleTypes';

export type LevelPhase =
    | 'SELECT' | 'DIFFICULTY' | 'LOADOUT' | 'REPLAY_BOOST'
    | 'PLAYING' | 'REWARD' | 'SETTLE';

/** 继承来源 */
export type CarrySource = 'none' | 'archive' | 'lowerTier';

/** 玩家点进已通关关卡时，选择面板需要的数据 */
export interface LoadoutPayload {
    levelId: number;
    difficulty: number;
    difficultyName: string;
    archive: LevelArchive;
    summary: string;
    /** 装备与形态的展示文案，如"裂空剑（攻击 +160% · 全屏）　暴雨弩（…）" */
    equipmentText: string;
    adRetryLeft: number;
    justCleared: boolean;
    /** 该关的推荐武器名，帮玩家在开局前调整搭配 */
    affinityText: string;
}

/** 难度选择面板需要的数据 */
export interface DifficultyPayload {
    levelId: number;
    maxTier: number;
    globalMaxTier: number;
}

/** 复玩加难面板需要的数据 */
export interface ReplayBoostPayload {
    levelId: number;
    difficulty: number;
    difficultyName: string;
    /** 第几次复玩 */
    replayCount: number;
    /** 上次选定的加难百分比 */
    current: number;
    /** 可选档位 */
    steps: number[];
    /** 各档位下的敌人强度预览文案 */
    preview: string[];
}

/** 三选一面板需要的数据 */
export interface RewardPayload {
    options: RewardOption[];
    /** 当前关卡等级 */
    level: number;
    /** 当前槽位占用情况 */
    slotText: string;
    /** 是否是合成后的补选 */
    refill: boolean;
    /** 本关推荐武器，UI 可做提示 */
    affinityText: string;
}

/** 通关结算面板需要的数据 —— 复玩目标导向：冲分 / 计时 / 挑战更高难度 */
export interface SettlePayload {
    levelId: number;
    difficulty: number;
    difficultyName: string;
    score: number;
    isNewScoreBest: boolean;
    isNewTimeBest: boolean;
    bestScore: number;
    bestTime: number;
    elapsed: number;
    kills: number;
    clearCount: number;
    goldGained: number;
    /** 本次通关触发的进化事件，用于结算页展示"本局养成了什么" */
    evolutions: EvolutionEvent[];
    /** 本局触发的合成次数 */
    fusions: number;
    /** 本局达到的最高形态层级 */
    maxDepth: number;
    /** 本局启用的加难百分比 */
    boostPercent: number;
    /** 本局新解锁的成就名 */
    newAchievements: string[];
    /** 新成就带来的金币 */
    achievementGold: number;
    /** 图鉴收录进度文案 */
    collectionText: string;
    nextTier: number;
    hasNextTier: boolean;
    tierJustUnlocked: boolean;
    nextLevelId: number;
    hasNext: boolean;
    summary: string;
    equipmentText: string;
    /**
     * 本次通关掉落的材料，结算页展示用。
     * 突破材料与属性碎片分开，因为两者的后续动作完全不同：
     * 前者去锻造面板突破，后者去凑 10 个合成完整材料。
     */
    drops: {
        materials: Record<string, number>;
        shards: Record<string, number>;
        elements: string[];
    };
    /**
     * 本次通关获得的许愿水晶，以及抽卡后的余额。
     * 结算页要把它做成一个明确的按钮入口："去抽卡" ——
     * 玩家刚打完成就立刻能花掉它，成就感与决策感同时到位。
     */
    crystalsGained: number;
    crystalsLeft: number;
    /** 攒够一次十连了吗（决定主按钮的引导文案） */
    canBatchPull: boolean;
}

type StartListener = (s: LevelState, cfg: LevelConfigItem) => void;
type LoadoutListener = (p: LoadoutPayload) => void;
type DifficultyListener = (p: DifficultyPayload) => void;
type ReplayBoostListener = (p: ReplayBoostPayload) => void;
type RewardListener = (p: RewardPayload) => void;
type SettleListener = (p: SettlePayload) => void;
type EvolveListener = (events: EvolutionEvent[]) => void;

/** 广告看完后允许重选的最大次数，防止无限刷广告请求 */
const MAX_AD_RETRY = 2;

/**
 * 选择「重新开始」时是否删除该难度的档案。
 *
 * false（当前策略）= 温和：档案保留，本次只是不带装备、从初始数据开打。
 * true = 严格：不看广告就等于回到未通关状态。
 *
 * 想回退成严格策略，把这里改成 true 即可，其余逻辑无需改动。
 */
const DROP_ARCHIVE_ON_RESTART = false;

/** 复玩（非首次通关）时的永久金币产出折扣，防止刷金币 */
const REPLAY_GOLD_RATE = 0.6;

/** 继承数据的内部结构 */
interface CarryData {
    resources: AttrMap;
    stats: AttrMap;
    equipment?: EquipRunState[];
    talents?: Record<string, number>;
}

export class LevelFlow {
    private static _inst: LevelFlow | null = null;
    static get inst(): LevelFlow {
        if (!this._inst) this._inst = new LevelFlow();
        return this._inst;
    }

    private _phase: LevelPhase = 'SELECT';
    private _state: LevelState | null = null;
    private _pendingLevel = 1;
    private _pendingTier = 1;
    private _selectingLevel = 1;
    private _adRetryLeft = MAX_AD_RETRY;
    private _justCleared = false;

    /** 等待玩家确认复玩加难时的待入场数据 */
    private _pendingEntry: { data: CarryData | null; carried: boolean; source: CarrySource } | null = null;

    /** 本局累计的进化事件、合成次数与受伤量（结算与成就用） */
    private _runEvents: EvolutionEvent[] = [];
    private _runFusions = 0;
    private _damageTaken = 0;
    /** 本局用属性克制打出的伤害（成就 elementCounter 的进度） */
    private _elementDamage = 0;
    /** 本局被属性抗性减免的伤害（成就 elementResist 的进度） */
    private _resistReduced = 0;
    /** 三选一的随机序列，保证同一局的多次三选一不重复 */
    private _rewardSeq = 0;

    private _startCbs: StartListener[] = [];
    private _loadoutCbs: LoadoutListener[] = [];
    private _difficultyCbs: DifficultyListener[] = [];
    private _boostCbs: ReplayBoostListener[] = [];
    private _rewardCbs: RewardListener[] = [];
    private _settleCbs: SettleListener[] = [];
    private _evolveCbs: EvolveListener[] = [];

    get phase(): LevelPhase { return this._phase; }
    get current(): LevelState | null { return this._state; }
    get adRetryLeft(): number { return this._adRetryLeft; }
    get pendingLevel(): number { return this._pendingLevel; }
    get pendingTier(): number { return this._pendingTier; }
    get selectingLevel(): number { return this._selectingLevel; }
    get unlockedLevel(): number { return SaveManager.getProfile().unlockedLevel; }
    get globalMaxTier(): number { return SaveManager.getGlobalMaxTier(); }
    get dropArchiveOnRestart(): boolean { return DROP_ARCHIVE_ON_RESTART; }
    /** 战斗中是否需要暂停（三选一 / 复玩面板打开时） */
    get paused(): boolean { return this._phase === 'REWARD' || this._phase === 'REPLAY_BOOST'; }
    /** 本局是否携带老档 —— 决定高级进化是否出现 */
    get allowAdvanced(): boolean {
        return !!this._state && this._state.carrySource !== 'none';
    }

    onStart(cb: StartListener): void { this._startCbs.push(cb); }
    onLoadoutChoice(cb: LoadoutListener): void { this._loadoutCbs.push(cb); }
    onDifficultySelect(cb: DifficultyListener): void { this._difficultyCbs.push(cb); }
    onReplayBoost(cb: ReplayBoostListener): void { this._boostCbs.push(cb); }
    onReward(cb: RewardListener): void { this._rewardCbs.push(cb); }
    onSettle(cb: SettleListener): void { this._settleCbs.push(cb); }
    /** 订阅装备进化事件，UI 用来播特效/飘字 */
    onEvolve(cb: EvolveListener): void { this._evolveCbs.push(cb); }

    // ------------------------------------------------------------ 启动

    /**
     * 启动游戏。
     * 优先续玩上次未打完的单局（数据完整保留，不需要看广告），
     * 没有进行中的关卡就进入关卡选择界面。
     */
    boot(): void {
        EquipmentManager.syncProfile();

        const saved = SaveManager.loadLevel();
        if (saved && !saved.cleared) {
            saved.difficulty = normalizeTier(saved.difficulty || 1);
            if (!saved.carrySource) saved.carrySource = saved.carried ? 'archive' : 'none';
            this._state = saved;
            this._phase = 'PLAYING';
            this.emitStart(saved, getLevelConfig(saved.levelId, saved.difficulty, saved.replay.percent));
            return;
        }
        this.backToSelect();
    }

    // ------------------------------------------------------------ 关卡选择

    backToSelect(): void {
        this._phase = 'SELECT';
        this._state = null;
        this._justCleared = false;
        this._pendingEntry = null;
    }

    isUnlocked(levelId: number): boolean {
        return levelId <= this.unlockedLevel;
    }

    isCleared(levelId: number): boolean {
        return SaveManager.hasAnyArchive(levelId);
    }

    getMaxTier(levelId: number): number {
        return SaveManager.getMaxTier(levelId);
    }

    isTierUnlocked(levelId: number, tier: number): boolean {
        return SaveManager.isTierUnlocked(levelId, tier);
    }

    /** 该关已通关的难度数量，关卡列表上用来显示"难度 2/3" */
    clearedTierCount(levelId: number): number {
        let n = 0;
        for (let t = 1; t <= 3; t++) {
            if (SaveManager.hasArchive(levelId, t)) n += 1;
        }
        return n;
    }

    /**
     * 点击某一关 → 打开难度选择面板。
     *
     * 难度选择是硬需求而不是锦上添花：玩家打通困难后发现噩梦还差一点，
     * 需要一个明确的入口回去再试，而不是被迫从关卡列表猜"点进去会进哪一档"。
     */
    openDifficultySelect(levelId: number): void {
        if (!this.isUnlocked(levelId)) return;
        this._selectingLevel = levelId;
        this._phase = 'DIFFICULTY';
        this.emitDifficulty({
            levelId,
            maxTier: this.getMaxTier(levelId),
            globalMaxTier: this.globalMaxTier,
        });
    }

    /**
     * 进入某一关某一难度。
     *
     * @param levelId 关卡号
     * @param tier    难度层级。不传 = 该关已解锁的最高难度
     */
    openLevel(levelId: number, tier?: number): void {
        if (!this.isUnlocked(levelId)) return;

        const t = normalizeTier(tier === undefined ? this.getMaxTier(levelId) : tier);
        if (!this.isTierUnlocked(levelId, t)) return;

        this._pendingLevel = levelId;
        this._pendingTier = t;

        const archive = SaveManager.loadArchive(levelId, t);
        if (archive) {
            this._adRetryLeft = MAX_AD_RETRY;
            this._phase = 'LOADOUT';
            this.emitLoadout(this.buildLoadoutPayload(archive));
            return;
        }

        // 首次进入更高难度：默认继承上一档通关时的装备，**不要求看广告**。
        if (t > 1) {
            const lower = SaveManager.loadArchive(levelId, t - 1);
            if (lower) {
                console.log('[Level] 首次进入第 ' + levelId + ' 关难度 ' + t +
                    '，默认继承难度 ' + (t - 1) + ' 通关时的装备');
                this._justCleared = false;
                this.beginEntry(levelId, t, lower.loadout, true, 'lowerTier');
                return;
            }
        }

        this.beginEntry(levelId, t, null, false, 'none');
    }

    private buildLoadoutPayload(archive: LevelArchive): LoadoutPayload {
        const tier = normalizeTier(archive.difficulty || 1);
        return {
            levelId: archive.levelId,
            difficulty: tier,
            difficultyName: getDifficulty(tier).name,
            archive,
            summary: describeLoadout(archive.loadout),
            equipmentText: this.describeEquipment(archive.loadout.equipment),
            adRetryLeft: this._adRetryLeft,
            justCleared: this._justCleared,
            affinityText: affinityNames(archive.levelId),
        };
    }

    /**
     * 装备列表的展示文案，按武器 / 辅助分组。
     *
     * 两组都**始终**输出（空的那组打印"无"）——
     * 继承面板上"辅助：无"本身就是一条信息：这一局没攒到辅助装备，
     * 而"少了这一行"只会让玩家以为是显示不全。
     */
    private describeEquipment(list?: EquipRunState[]): string {
        const weapons: string[] = [];
        const auxes: string[] = [];
        for (const st of list || []) {
            const txt = EquipmentManager.describeSlot(st);
            if (st.kind === 'aux') auxes.push(txt);
            else weapons.push(txt);
        }
        return '武器：' + (weapons.length > 0 ? weapons.join('、') : '无') +
            '　辅助：' + (auxes.length > 0 ? auxes.join('、') : '无');
    }

    // ------------------------------------------------------------ 两种开局方式

    /**
     * 分支 A：看广告，继承该难度档案里的装备与形态。
     * @returns true = 继承成功；false = 没看完/失败，留在选择面板让玩家重选
     */
    async startWithCarry(levelId: number, tier?: number): Promise<boolean> {
        const t = normalizeTier(tier === undefined ? this._pendingTier : tier);
        const archive = SaveManager.loadArchive(levelId, t);
        if (!archive) return false;

        const ok = await AdReward.show(AdTag.CARRY_OVER);
        if (!ok) {
            this._adRetryLeft = Math.max(0, this._adRetryLeft - 1);
            this._phase = 'LOADOUT';
            this.emitLoadout(this.buildLoadoutPayload(archive));
            return false;
        }

        SaveManager.bumpAdView();
        this._justCleared = false;
        this.beginEntry(levelId, t, archive.loadout, true, 'archive');
        return true;
    }

    /**
     * 分支 B：重新开始，用初始数据开局。
     *
     * 默认策略下**不会删除档案**（DROP_ARCHIVE_ON_RESTART = false）——
     * 玩家只是想重玩一遍，辛苦攒的装备应当保留，下次进来仍可看广告继承。
     */
    startFresh(levelId: number, tier?: number, dropArchive?: boolean): void {
        const t = normalizeTier(tier === undefined ? this._pendingTier : tier);
        const shouldDrop = dropArchive === undefined ? DROP_ARCHIVE_ON_RESTART : dropArchive;
        if (shouldDrop && SaveManager.hasArchive(levelId, t)) {
            SaveManager.dropArchive(levelId, t);
            console.log('[Level] 第 ' + levelId + ' 关难度 ' + t + ' 的档案已按显式要求重置');
        }
        SaveManager.clearLevel();
        this._justCleared = false;
        this.beginEntry(levelId, t, null, false, 'none');
    }

    /**
     * 入场前的最后一道闸门：判断要不要先问"复玩加难"。
     *
     * 只在**该难度已经通关过**时才问 —— 第一次打进一档难度时，
     * 玩家面对的是全新的挑战，此时再加难属于劝退，不是服务。
     */
    private beginEntry(
        levelId: number,
        tier: number,
        data: CarryData | null,
        carried: boolean,
        source: CarrySource
    ): void {
        this._pendingEntry = { data, carried, source };

        const cleared = (SaveManager.getProfile().clearCounts[SaveManager.statKey(levelId, tier)] || 0) > 0;
        if (!cleared) {
            this.commitEntry(false, 0);
            return;
        }

        this._phase = 'REPLAY_BOOST';
        this.emitReplayBoost(this.buildBoostPayload(levelId, tier));
    }

    private buildBoostPayload(levelId: number, tier: number): ReplayBoostPayload {
        const preview: string[] = [];
        for (const p of REPLAY_BOOST_STEPS) {
            const c = getLevelConfig(levelId, tier, p);
            preview.push((p <= 0 ? '不加难' : '+' + Math.round(p * 100) + '%') +
                '　血量 ' + c.baseEnemyHp + ' · 攻击 ' + c.baseEnemyAtk + ' · 数量 ' + c.enemies);
        }
        return {
            levelId, difficulty: tier,
            difficultyName: getDifficulty(tier).name,
            replayCount: SaveManager.getReplayCount(levelId, tier),
            current: SaveManager.getReplayBoost(levelId, tier),
            steps: REPLAY_BOOST_STEPS.slice(),
            preview,
        };
    }

    /**
     * 玩家确认了复玩加难设置，真正进场。
     *
     * @param enabled 是否启用加难
     * @param percent 加难百分比（未启用时会被归零）
     */
    confirmReplayBoost(enabled: boolean, percent: number): void {
        const p = enabled ? Math.max(0, percent) : 0;
        SaveManager.setReplayBoost(this._pendingLevel, this._pendingTier, p);
        this.commitEntry(enabled && p > 0, p);
    }

    /** 跳过加难设置（保持上次的选择） */
    skipReplayBoost(): void {
        const p = SaveManager.getReplayBoost(this._pendingLevel, this._pendingTier);
        this.commitEntry(p > 0, p);
    }

    /** 真正创建单局状态并进场 */
    private commitEntry(enabled: boolean, percent: number): void {
        const entry = this._pendingEntry;
        const levelId = this._pendingLevel;
        const tier = this._pendingTier;
        this._pendingEntry = null;

        const data = entry ? entry.data : null;
        const carried = entry ? entry.carried : false;
        const source: CarrySource = entry ? entry.source : 'none';

        const boost: ReplayBoost = { enabled: enabled && percent > 0, percent: enabled ? percent : 0 };
        const cfg = getLevelConfig(levelId, tier, boost.percent);

        // 局内 build：以局外选好的武器为起点，继承档案里的形态与天赋
        const loadout = createRunLoadout(
            EquipmentManager.getEquippedIds(),
            data ? data.equipment : undefined,
            data ? data.talents : undefined
        );

        const state: LevelState = {
            levelId,
            difficulty: tier,
            runId: makeRunId(levelId),
            resources: { ...cfg.initialResources },
            stats: { ...cfg.initialStats },
            loadout,
            replay: boost,
            score: 0,
            elapsed: 0,
            kills: 0,
            cleared: false,
            carried,
            carrySource: source,
            updatedAt: Date.now(),
        };

        if (data) {
            Object.assign(state.resources, data.resources);
            Object.assign(state.stats, data.stats);
        }

        // 入场就把初始形态记进图鉴，否则"收录 N 种形态"的进度会从进化的那一刻才开始算
        SaveManager.markFormsSeen(allFormIdsOf(loadout));

        this._state = state;
        this._runEvents = [];
        this._runFusions = 0;
        this._damageTaken = 0;
        this._elementDamage = 0;
        this._resistReduced = 0;
        this._rewardSeq = 0;
        this._adRetryLeft = MAX_AD_RETRY;
        this._phase = 'PLAYING';
        SaveManager.saveLevel(state);

        if (carried) {
            const power = this.getCombatPower();
            console.log('[Level] 继承开局（' + source + '）：总伤害 ' +
                (power ? power.finalDamage : 0) +
                (boost.enabled ? '，复玩加难 +' + Math.round(boost.percent * 100) + '%' : ''));
        }
        // 复玩时记一笔，之后"是否加难"的默认值会带上上次的选择
        if (carried || SaveManager.hasAnyArchive(levelId)) {
            SaveManager.bumpReplay(levelId, tier);
        }
        this.emitStart(state, cfg);
    }

    /**
     * 战败后重试：同一个 LevelState 继续用，本局数据与形态进度都不清。
     */
    retryLevel(): void {
        if (!this._state) return;
        this._phase = 'PLAYING';
        SaveManager.saveLevel(this._state);
        this.emitStart(this._state, getLevelConfig(
            this._state.levelId, this._state.difficulty, this._state.replay.percent));
    }

    // ------------------------------------------------------------ 局内数据操作

    addResource(key: string, delta: number): void {
        if (!this._state) return;
        this._state.resources[key] = Math.max(0, (this._state.resources[key] ?? 0) + delta);
    }

    addStat(key: string, delta: number): void {
        if (!this._state) return;
        this._state.stats[key] = (this._state.stats[key] ?? 0) + delta;
    }

    addScore(delta: number): void {
        if (!this._state) return;
        this._state.score += delta;
    }

    addElapsed(dt: number): void {
        if (!this._state) return;
        this._state.elapsed += dt;
    }

    addKill(): void {
        if (!this._state) return;
        this._state.kills += 1;
    }

    /** 局内消费，余额不足返回 false 拒绝扣费 */
    spendResource(key: string, cost: number): boolean {
        if (!this._state) return false;
        const cur = this._state.resources[key] ?? 0;
        if (cur < cost) return false;
        this._state.resources[key] = cur - cost;
        return true;
    }

    /** 记录玩家受伤（无伤通关的成就判定依赖它） */
    notePlayerHurt(dmg: number): void {
        if (dmg > 0) this._damageTaken += dmg;
    }

    /**
     * 战斗结束时上报本局的属性相关统计。
     *
     * 由 GameEntry 在 onCleared / onDefeat 时把 BattleWorld.stats 传进来。
     * 之所以显式上报而不是让 LevelFlow 反查战斗层：流程层不该认识战斗层的对象，
     * 否则两个模块就绑死了（和 weapons/stats 那两个纯数据接口同一个原则）。
     */
    noteElementStats(elementDamage: number, resistReduced: number): void {
        if (elementDamage > 0) this._elementDamage += elementDamage;
        if (resistReduced > 0) this._resistReduced += resistReduced;
    }

    // ------------------------------------------------------------ 战力

    /**
     * 汇总本局的战斗修正。
     *
     * 三个回调分别是辅助装备的三条局外投资线，全部由 LevelFlow 注入：
     *   auxRankMulOf     局外阶数（第七轮，花金币升）
     *   auxRarityMulOf   品阶强度倍率（第八轮，抽卡 + 消耗同阶装备升阶）
     *   auxInnateOf      自带复合属性（第八轮，钻石及以上专属辅助才有）
     *
     * 由 LevelFlow 注入而不是让 FormGraph 直接读档，
     * 这样 FormGraph 保持纯函数，战斗相关的测试不需要建存档。
     *
     * 单独抽成方法是为了保证三个调用点（战斗修正 / 战力快照 / 击杀经验）
     * 用的是同一份规则 —— 少一处注入就会出现"经验算升阶、伤害不算"的错位。
     *
     * ★ 防具增益在这里并入（原本漏接，导致防具词条/套装/镶嵌增益完全不生效）：
     * 防具是**局外穿戴**的，不进 buildWeapons 的逐武器计算，
     * 但它的单件 innate、套装 2/4 件属性、镶嵌属性石都是玩家侧的全局增益，
     * 语义上与天赋、辅助装备完全同源，所以并进同一份 CombatModifier。
     * 在这里并（而不是在 GameEntry 里另加参数）有三个好处：
     *   1. 战斗伤害、战力面板、击杀经验三处自动一致，不会出现"面板有伤害没有"
     *   2. 与每把武器自己的镶嵌相加时不会重复计算 —— 那是两条不同的来源
     *   3. 护盾 / 荆棘 / 生命上限走同一条路，无需在 setup 里单独补
     */
    private modifierOf(loadout: RunLoadoutState): CombatModifier {
        const mod = aggregateModifier(
            loadout,
            auxRankMulOf,
            (rootId) => auxRarityMulOf(rootId),
            (rootId) => auxInnateOf(rootId)
        );
        return mergeArmorBonus(mod);
    }

    /** 本局当前的战斗修正（天赋 + 辅助装备 + 辅助升阶） */
    getModifier(): CombatModifier | null {
        if (!this._state) return null;
        return this.modifierOf(this._state.loadout);
    }

    /** 本局的关卡适配伤害倍率 */
    getAffinityMul(): number {
        if (!this._state) return 1;
        return affinityDamageMul(this._state.levelId, weaponRootsOf(this._state.loadout));
    }

    /** 当前战力快照，HUD 展示用 */
    getCombatPower() {
        if (!this._state) return null;
        return EquipmentManager.computePower(
            this._state.loadout, this._state.stats, this.modifierOf(this._state.loadout), this.getAffinityMul());
    }

    /** 当前难度定义，UI 直接读名字与配色 */
    getCurrentDifficulty(): DifficultyDef | null {
        if (!this._state) return null;
        return getDifficulty(this._state.difficulty);
    }

    // ------------------------------------------------------------ 经验与三选一

    /** 当前局内等级进度 0~1，HUD 画经验条用 */
    getLevelProgress(): number {
        if (!this._state) return 0;
        return levelProgress(this._state.loadout);
    }

    /**
     * 击杀一只敌人的完整结算：加分、加经验、掉资源，并在升级时触发三选一。
     *
     * 注意经验在投放到两条曲线之前先乘了经验加成 ——
     * 智慧书 / 贪婪印记这类加成必须作用在"击杀产出"这一侧，
     * 而不是作用在升级门槛上，否则不同来源的加成会互相干扰。
     */
    onEnemyKilled(): void {
        if (!this._state || this.paused) return;
        const state = this._state;
        const cfg = getLevelConfig(state.levelId, state.difficulty, state.replay.percent);

        this.addKill();
        this.addScore(Math.round(
            (20 + state.levelId * 2) * cfg.diff.scoreMul * (1 + state.replay.percent)
        ));

        const perDrop = Math.max(1, Math.round(cfg.reward['coin'] / Math.max(1, cfg.enemies)));
        this.addResource('coin', perDrop);
        this.addStat('atk', 2);
        this.addStat('hp', 4);

        const mod = this.modifierOf(state.loadout);
        const amount = Math.max(1, Math.round(cfg.expPerEnemy * (1 + mod.expPct)));
        const ups = gainExp(state.loadout, amount);

        // 路上遇到的形态都要进图鉴，否则"收录 N 种形态"永远只能收录终点
        SaveManager.markFormsSeen(allFormIdsOf(state.loadout));
        SaveManager.saveLevel(state);

        // 一次击杀跨过多级在实战中不可能出现（等级门槛按 1.3 倍增长，
        // 而单只经验是固定的），所以这里只开一次面板，不做待开队列。
        if (ups > 0 && state.loadout.pending.length === 0) {
            this.openReward();
        }
    }

    /**
     * 打开一次三选一（战斗会随之暂停）。
     *
     * @returns 是否真的弹出了面板。池子空时返回 false 并把阶段交还给调用方 ——
     *          合成补选时如果池子空了却没把阶段改回 PLAYING，玩家会卡在
     *          一个空面板上再也动不了，这是必须在这里堵住的死锁。
     */
    private openReward(): boolean {
        const state = this._state;
        if (!state) return false;

        const carry = state.carrySource !== 'none';
        this._rewardSeq += 1;

        const ctx: RewardContext = {
            loadout: state.loadout,
            allowAdvanced: carry,
            weaponCap: weaponSlotCap(carry),
            auxCap: auxSlotCap(carry),
            level: state.loadout.level,
            ownedEquipIds: EquipmentManager.getOwnedList().map((e) => e.id),
            seenForms: SaveManager.getSeenForms(),
            // 种子随"关卡 + 难度 + 等级 + 本局序号"变化：
            // 同一局的同一次升级永远给同样的三张卡（防重开刷卡），
            // 但不同局之间不会雷同。
            rng: makeRng(state.levelId * 7919 + state.difficulty * 1313 + state.loadout.level * 17 + this._rewardSeq),
        };

        const options = pickRewards(ctx);
        if (options.length === 0) {
            // 池子真的空了（槽满 + 无进化 + 无合成 + 天赋全满）
            console.log('[Level] 无可用奖励卡，放弃本次三选一');
            state.loadout.pending = [];
            state.loadout.pendingPicks = 0;
            this._phase = 'PLAYING';
            return false;
        }

        state.loadout.pending = options;
        this._phase = 'REWARD';
        SaveManager.saveLevel(state);

        const payload = this.getRewardPayload();
        if (payload) this._rewardCbs.forEach((cb) => cb(payload));
        return true;
    }

    /**
     * 玩家选定了三选一里的一张卡。
     *
     * 合成会消耗一个武器槽并释放出待补选名额，此时**立刻**再开一次三选一
     * （而不是等下一次升级）—— 玩家刚做完一个亏格子的决策，
     * 应该马上得到补偿，而不是带着空槽再打十几只怪。
     */
    chooseReward(index: number): ApplyResult | null {
        const state = this._state;
        if (!state) return null;
        const opt = state.loadout.pending[index];
        if (!opt) return null;

        const carry = state.carrySource !== 'none';
        const caps = { weaponCap: weaponSlotCap(carry), auxCap: auxSlotCap(carry) };
        const res = applyReward(state.loadout, opt, caps);

        if (!res.ok) {
            console.warn('[Level] 奖励无法应用：' + res.message);
            return res;
        }

        if (res.event) {
            this._runEvents.push(res.event);
            if (res.event.type === 'fusion') this._runFusions += 1;
            this._evolveCbs.forEach((cb) => cb([res.event!]));
        }

        SaveManager.markFormsSeen(allFormIdsOf(state.loadout));
        SaveManager.saveLevel(state);

        // 合成会释放出待补选名额时立刻再开一次三选一；
        // 若池子已空（openReward 返回 false），它已经把阶段归位，这里不再重复设置。
        if (!(state.loadout.pendingPicks > 0 && this.openReward())) {
            this._phase = 'PLAYING';
        }
        return res;
    }

    /** 当前待选的三张卡（UI 重绘时读它） */
    getPendingRewards(): RewardOption[] {
        return this._state ? this._state.loadout.pending.slice() : [];
    }

    /** 当前三选一面板的完整数据（UI 重绘用，直接复用 openReward 的组装逻辑） */
    getRewardPayload(): RewardPayload | null {
        const state = this._state;
        if (!state || state.loadout.pending.length === 0) return null;
        const carry = state.carrySource !== 'none';
        return {
            options: state.loadout.pending.slice(),
            level: state.loadout.level,
            slotText: '武器 ' + state.loadout.weapons.length + '/' + weaponSlotCap(carry) +
                '　辅助 ' + state.loadout.auxes.length + '/' + auxSlotCap(carry),
            refill: state.loadout.pendingPicks > 0,
            affinityText: affinityNames(state.levelId),
        };
    }

    /**
     * 调试专用：直接灌经验，用于在编辑器里验证进化链与三选一。
     * 它复用正常升级的所有路径（进图鉴、存档、弹面板），
     * 不另开一条"只改数字"的旁路 —— 那样验不出真实流程。
     */
    debugGainExp(amount: number): void {
        const state = this._state;
        if (!state) return;
        const ups = gainExp(state.loadout, amount);
        SaveManager.markFormsSeen(allFormIdsOf(state.loadout));
        SaveManager.saveLevel(state);
        if (ups > 0 && state.loadout.pending.length === 0) this.openReward();
    }

    // ------------------------------------------------------------ 通关结算

    /**
     * 通关：把本次结束时的数据写入该难度的档案（覆盖式），解锁下一难度，
     * 并做一次成就判定。
     */
    onLevelClear(): SettlePayload | null {
        if (!this._state) return null;
        const state = this._state;
        const tier = normalizeTier(state.difficulty);
        state.cleared = true;

        const cfg = getLevelConfig(state.levelId, tier, state.replay.percent);
        for (const k of Object.keys(cfg.reward)) {
            state.resources[k] = (state.resources[k] ?? 0) + cfg.reward[k];
        }

        const loadout = buildLoadout(state);
        const old = SaveManager.loadArchive(state.levelId, tier);
        const clearCount = (old ? old.clearCount : 0) + 1;

        const bestScore = Math.max(old ? old.bestScore : 0, state.score);

        // 耗时记录必须过滤非正数：0 秒通关不该被记成"最快纪录"，
        // 否则之后谁也打不破，复玩的计时目标就废了。
        const prevBestTime = old ? old.bestTime : 0;
        const validTime = state.elapsed > 0;
        const isNewTimeBest = validTime && (prevBestTime <= 0 || state.elapsed < prevBestTime);
        const bestTime = !validTime
            ? prevBestTime
            : (prevBestTime > 0 ? Math.min(prevBestTime, state.elapsed) : state.elapsed);
        const isNewScoreBest = !old || state.score > old.bestScore;

        // 复玩时永久金币打折，防止反复刷同一难度
        const roots = weaponRootsOf(state.loadout);
        const affinityGold = state.replay.percent > 0 ? 1 + state.replay.percent * 0.5 : 1;
        const goldGained = Math.round(
            cfg.goldReward * (clearCount > 1 ? REPLAY_GOLD_RATE : 1) * affinityGold
        );
        SaveManager.addGold(goldGained);

        // ---- 许愿水晶 ----
        // 按难度档固定发放（普通 10 / 困难 30 / 噩梦 100），10 个水晶一次抽。
        //
        // 【为什么放在这里而不是难度解锁时】
        //   因为它是"每次通关都给"（玩家需求），不是首次通关奖励。
        //   复玩同一难度同样发放 —— 这正是我们要的：
        //   刷噩梦是水晶的主要来源，于是"要不要挑战更高难度"这个决策
        //   多了一个明确的、可量化的收益（100 vs 30）。
        //
        //   注意它**不打折**，而金币有 REPLAY_GOLD_RATE。
        //   区别在于：金币要防刷（可无限快速刷同一难度），
        //   而水晶的速率由"通关一次"这个硬门槛锁死了 ——
        //   你至少得把那一关的怪全打完。
        const crystalsGained = crystalRewardOf(tier);
        const crystalsLeft = addCrystals(crystalsGained);

        // ---- 材料掉落 ----
        // 突破材料跟着"这关推荐什么武器"走，属性碎片跟着"这关是什么属性"走。
        // 两条线都不需要看广告，纯靠打关卡积累。
        const drops = rollDrops(
            state.levelId,
            cfg.affinityWeaponIds,
            cfg.weakWeaponIds,
            // 掉落数量用 goldGained 派生：打得越好材料越多，
            // 不额外引入一条随机源，保证同一局结算可复现
            Math.min(0.999, goldGained / 3000),
            // 第八轮：难度档位，决定神话之核（三复合关卡 + 噩梦专属）是否可能掉落
            tier
        );
        grantDrops(drops);

        const archive: LevelArchive = {
            levelId: state.levelId,
            difficulty: tier,
            loadout,
            boostPercent: state.replay.percent,
            lastScore: state.score,
            bestScore,
            lastTime: state.elapsed,
            bestTime,
            clearCount,
            clearedAt: Date.now(),
        };
        SaveManager.saveArchive(archive);
        SaveManager.saveLevel(state);

        // 进度只进不退，与数值重置无关
        const nextLevel = state.levelId + 1;
        SaveManager.unlockLevel(nextLevel);
        const nextTier = tier + 1;
        const tierJustUnlocked = hasNextTier(tier) && SaveManager.unlockTier(state.levelId, nextTier);

        // 难度/关卡推进可能带来新武器与更多出战槽位
        EquipmentManager.syncProfile();

        // ---- 成就结算 ----
        const usedAffinity = affinityDamageMul(state.levelId, roots) > 1;
        const summary: RunSummary = {
            levelId: state.levelId,
            tier,
            cleared: true,
            noDamage: this._damageTaken <= 0,
            score: state.score,
            time: state.elapsed,
            kills: state.kills,
            goldEarned: goldGained,
            usedAffinity,
            boosted: state.replay.enabled && state.replay.percent > 0,
            boostPercent: state.replay.percent,
            fusions: this._runFusions,
            maxDepth: maxDepthOf(state.loadout),
            forms: allFormIdsOf(state.loadout),
            talents: state.loadout.talents,
            weaponCount: state.loadout.weapons.length,
            auxCount: state.loadout.auxes.length,
            elementDamage: this._elementDamage,
            resistReduced: this._resistReduced,
            crystalsGained,
        };

        SaveManager.markFormsSeen(summary.forms);
        SaveManager.addCounters(summary.kills, summary.fusions, usedAffinity ? 1 : 0);
        // 属性相关的累计也并入档案：成就是累计型的，每局只判一次是不够的
        {
            const prof = SaveManager.getProfile();
            prof.elementDamageTotal = (prof.elementDamageTotal || 0) + this._elementDamage;
            prof.resistReducedTotal = (prof.resistReducedTotal || 0) + this._resistReduced;
            SaveManager.saveProfile(prof);
        }

        const profile = SaveManager.getProfile();
        const actx = contextFromProfile(profile, summary, ALL_FORMS.length);
        const unlocked = judgeAchievements(actx);
        const achGold = totalGoldOf(unlocked);
        const freshIds = SaveManager.unlockAchievements(toRecords(unlocked, Date.now()), achGold);
        const newAchievementNames = unlocked
            .filter((d) => freshIds.indexOf(d.id) >= 0)
            .map((d) => d.name);

        const seen = SaveManager.getSeenForms().length;
        const payload: SettlePayload = {
            levelId: state.levelId,
            difficulty: tier,
            difficultyName: cfg.diff.name,
            score: state.score,
            isNewScoreBest,
            isNewTimeBest,
            bestScore,
            bestTime,
            elapsed: state.elapsed,
            kills: state.kills,
            clearCount,
            goldGained,
            evolutions: this._runEvents.slice(),
            fusions: this._runFusions,
            maxDepth: summary.maxDepth,
            boostPercent: state.replay.percent,
            newAchievements: newAchievementNames,
            achievementGold: achGold,
            collectionText: '图鉴 ' + seen + '/' + ALL_FORMS.length,
            nextTier,
            hasNextTier: hasNextTier(tier),
            tierJustUnlocked,
            nextLevelId: nextLevel,
            hasNext: hasNextLevel(nextLevel),
            summary: describeLoadout(loadout),
            equipmentText: this.describeEquipment(loadout.equipment),
            drops: {
                materials: drops.materials,
                shards: drops.shards,
                elements: drops.elements,
            },
            crystalsGained,
            crystalsLeft,
            canBatchPull: crystalsLeft >= CRYSTAL_PER_PULL * MAX_PULL_BATCH,
        };

        this._phase = 'SETTLE';
        this._settleCbs.forEach((cb) => cb(payload));
        return payload;
    }

    // ------------------------------------------------------------ 结算后的去向

    /** 进入下一关（下一关只解锁了普通难度，从初始数据开局） */
    goNextLevel(): void {
        const cur = this._state;
        if (!cur) return;
        this._justCleared = true;
        this.openLevel(cur.levelId + 1);
    }

    /**
     * 挑战本关的下一难度 —— 走 openLevel，因此会自动命中
     * "首次进入更高难度 → 默认免费继承低难度装备"这条分支。
     */
    goNextTier(): void {
        const cur = this._state;
        if (!cur) return;
        const next = cur.difficulty + 1;
        if (!hasNextTier(cur.difficulty) || !this.isTierUnlocked(cur.levelId, next)) return;
        this._justCleared = true;
        this.openLevel(cur.levelId, next);
    }

    /**
     * 重玩本难度 —— 广告转化率最高的入口。
     * 刚通关的档案已经写好，此时弹选择面板，
     * 玩家为了"带着这套进化装备再刷一次高分"更容易接受观看激励视频。
     * 通关过之后还会多一步"是否加难"，让他能给同一关加码。
     */
    replayLevel(): void {
        const cur = this._state;
        if (!cur) return;
        this._justCleared = true;
        this.openLevel(cur.levelId, cur.difficulty);
    }

    /** 结算页直接带加难重来（跳过面板，用当前加难 +15% 再来一次） */
    replayWithMoreBoost(delta = 0.15): void {
        const cur = this._state;
        if (!cur) return;
        const next = Math.max(0, cur.replay.percent + delta);
        SaveManager.setReplayBoost(cur.levelId, cur.difficulty, next);
        this._justCleared = true;
        this.beginEntry(cur.levelId, cur.difficulty, null, true, 'archive');
    }

    /**
     * 手动重置某一关某一难度的档案（真正的清档入口）。
     * @param tier 不传 = 清掉该关所有难度
     */
    resetArchive(levelId: number, tier?: number): void {
        if (tier === undefined) {
            for (let t = 1; t <= 3; t++) SaveManager.dropArchive(levelId, t);
        } else {
            SaveManager.dropArchive(levelId, normalizeTier(tier));
        }
        SaveManager.bumpRestart();
        console.log('[Level] 第 ' + levelId + ' 关' +
            (tier === undefined ? ' 全部难度' : ' 难度 ' + tier) + ' 的档案已手动重置');
    }

    // ------------------------------------------------------------ 事件

    private emitStart(s: LevelState, cfg: LevelConfigItem): void {
        this._startCbs.forEach((cb) => cb(s, cfg));
    }

    private emitLoadout(p: LoadoutPayload): void {
        this._loadoutCbs.forEach((cb) => cb(p));
    }

    private emitDifficulty(p: DifficultyPayload): void {
        this._difficultyCbs.forEach((cb) => cb(p));
    }

    private emitReplayBoost(p: ReplayBoostPayload): void {
        this._boostCbs.forEach((cb) => cb(p));
    }
}
