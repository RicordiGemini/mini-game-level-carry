/**
 * 战斗世界 —— 拖动走位玩法的完整模拟
 *
 * 【一帧的推进顺序】（顺序很重要，写反了会出现"敌人穿模""伤害重复结算"）
 *
 *   1. 读取拖动输入 → 移动玩家 → 更新朝向
 *   2. 每件武器独立结算冷却 → 瞄准 → 生成判定体
 *   3. 判定体移动 + 命中判定 + 伤害结算
 *   4. 敌人 AI：朝玩家移动，贴身则按间隔攻击
 *   5. 清理死亡实体
 *   6. 判定胜负
 *
 * 【为什么武器是"每件独立开火"】
 * 玩家可以同时带 2 件装备，它们各自按自己的瞄准方式工作：
 * 铁剑前向挥砍、短弓锁定射击，两种手感同时存在。
 * 这样"换武器 = 换操作手感"这件事才成立。
 *
 * 本文件不依赖 cocos，可直接在 Node 中跑完整仿真。
 */

import { AimModeId, EnemyKind, FormationKind } from '../data/GameTypes';
import { resolveAim, findNearest } from './AimResolver';
import { buildAttack, resetProjectileIds } from './AttackFactory';
import {
    ARENA_H,
    ARENA_W,
    Actor,
    BattleCallbacks,
    BattleResult,
    BattleSetup,
    DEFAULT_CHARGER_DASH_SPEED_MUL,
    DEFAULT_CHARGER_DASH_TIME,
    DEFAULT_CHARGER_HIT_DMG_MUL,
    DEFAULT_CHARGER_WINDUP,
    DEFAULT_CHARGER_WINDUP_SPEED_MUL,
    DEFAULT_ELITE_HP_MUL,
    DEFAULT_ELITE_SHIELD_FRAC,
    DEFAULT_ELITE_SPEED_MUL,
    DEFAULT_KITE_RANGE,
    DEFAULT_RANGED_HP_MUL,
    DEFAULT_RANGED_SPEED_MUL,
    DEFAULT_SHOT_INTERVAL,
    DEFAULT_SHOT_SPEED,
    DEFAULT_SWIFT_HP_MUL,
    DEFAULT_SWIFT_SPEED_MUL,
    EnemyShot,
    EnemyState,
    KITE_DEADZONE,
    PLAYER_RADIUS,
    PLAYER_SPEED,
    PlayerCombatSpec,
    Projectile,
    SPAWN_SAFE_DIST,
    Vec2,
    WeaponRuntime,
    WeaponSpec,
    WaveProgress,
    ZERO,
    makeRng,
    fullScreenRange,
    v2,
    vadd,
    vcopy,
    vdist,
    vlen,
    vnorm,
    vrot,
    vscale,
    vsub,
} from './BattleTypes';

/**
 * 未指定属性时用的默认属性。
 *
 * 战斗层不认识属性表的具体含义（那是 data/ElementConfig 的事），
 * 只认"字符串 key"。所以这里给一个确定的默认值，
 * 让不传 elements 的旧配置 / 旧测试行为完全不变。
 */
const DEFAULT_ELEMENT = 'light';

/**
 * 属性克制倍率。
 *
 * 战斗层**不认识**属性表（那是 data/ElementConfig 的职责），
 * 但它需要知道"克制环"这件事。这里只认一条约定：
 * `ElementConfig` 注入的乘数函数。
 * 未注入时返回 1（不启用属性克制），于是战斗层依然可以在
 * 不涉及属性的配置与测试里正常跑。
 */
let elementMulFor: (weaponEls: string[], enemyEl: string, counterBreak: number) => number =
    () => 1;

/** 由 GameEntry 在启动时注入，注入后属性克制才真正生效 */
export function setElementResolver(
    fn: (weaponEls: string[], enemyEl: string, counterBreak: number) => number
): void {
    elementMulFor = fn || (() => 1);
}

/** 玩家实体（比 Actor 多几个战斗字段） */
export interface PlayerState extends Actor {
    speed: number;
    /** 最后一次移动方向，也是朝向 */
    facing: Vec2;
    /**
     * 护盾：优先于生命承受伤害，每关开局按 CombatModifier 重置。
     * 单独一个字段而不是加进 hp —— 否则"护盾还剩多少"这件事
     * 在 UI 上就看不出来了，而它恰恰是玩家判断"还能不能浪"的依据。
     */
    shield: number;
}

/** 一场战斗结束时的统计 */
export interface BattleStats {
    kills: number;
    damageDealt: number;
    shotsFired: number;
    elapsed: number;
    /** 触发暴击的次数，结算页与 HUD 展示用 */
    critCount: number;
    /** 护盾吸收掉的伤害总量 */
    shieldAbsorbed: number;
    /** 被属性抗性减免掉的伤害累计，用于结算页展示"防具值多少" */
    resistReduced: number;
    /** 用属性克制打出的伤害累计（只算吃到加成的那部分） */
    elementDamage: number;
    /**
     * 本局的破防比例（无视克制）。
     * 取出战武器里的最高那一件，由 GameEntry 开战时算好传进来。
     */
    counterBreak: number;
}

export class BattleWorld {
    // ------------------------------------------------------------ 战场状态
    arenaW = ARENA_W;
    arenaH = ARENA_H;

    /**
     * 开火 / 索敌射程。
     * 默认 = 场地对角线（全屏），也就是"射程直接按全屏来"：
     * 屏幕上任何位置的敌人都在射程内，不会再出现"锁定了却打不到"。
     * 关卡想做成"够不着就不开火"，在 BattleSetup.engageRange 里传一个小值即可。
     */
    engageRange = fullScreenRange(ARENA_W, ARENA_H);

    player: PlayerState = {
        id: 0,
        pos: v2(ARENA_W / 2, ARENA_H * 0.24),
        radius: PLAYER_RADIUS,
        hp: 100,
        maxHp: 100,
        alive: true,
        speed: PLAYER_SPEED,
        facing: v2(1, 0),
        shield: 0,
    };

    enemies: EnemyState[] = [];
    projectiles: Projectile[] = [];
    /** 敌人发射的弹丸，与玩家武器的判定体分开管理 */
    enemyShots: EnemyShot[] = [];
    weapons: WeaponRuntime[] = [];

    running = false;
    result: BattleResult = 'ongoing';
    time = 0;

    stats: BattleStats = {
        kills: 0, damageDealt: 0, shotsFired: 0, elapsed: 0, critCount: 0, shieldAbsorbed: 0, resistReduced: 0, elementDamage: 0, counterBreak: 0,
    };

    // ------------------------------------------------------------ 内部
    /** 战斗事件回调。可在 setup 前后整体替换，表现层用它来桥接渲染与音效 */
    cb: BattleCallbacks = {};
    private _rng: () => number = makeRng(1);
    private _nextId = 1;
    private _spawnLeft = 0;
    private _batchTimer = 0;
    private _waveIndex = 0;
    private _waveElapsed = 0;
    /** 密集怪群的统一受击保护，避免同帧叠伤。 */
    private _hurtCooldown = 0;
    private _waveByEnemy = new Map<number, number>();
    /** 已投放的批次数，阵型摆位按它决定"这一批从哪来" */
    private _batchIndex = 0;
    /** 额外弹道的 id 分配，避免与工厂产出的判定体撞号 */
    private _extraShotId = 900000;
    /** 荆棘反伤值（来自天赋 / 辅助装备） */
    private _thorns = 0;
    private _shieldBonus = 0;
    private _killedEnemyIds = new Set<number>();
    private _enemySpec: BattleSetup['enemy'] | null = null;
    /**
     * 出生队列：开打前就把"这一关的敌人分别是近战还是远程"洗好牌，
     * 生成时按顺序取。
     *
     * 为什么不在生成时按概率掷骰子：那样远程怪有可能全部挤在最后一批，
     * 前两批全是近战 —— 玩家体感是"这一关忽然变难"，而不是"难度设计如此"。
     * 预先洗牌保证了远程怪均匀分布在每一波里。
     */
    private _spawnKinds: EnemyKind[] = [];
    private _spawnKindIdx = 0;
    /** 本关的属性池（null = 不启用属性） */
    private _elementPool: string[] | null = null;
    /** 属性轮转游标，保证属性均匀铺开而不是随机扎堆 */
    private _elementCursor = 0;
    /** 玩家属性抗性，key = 属性 id */
    private _resist: Record<string, number> = {};
    /** 破防比例：把克制倍率向 1.0 收敛 */
    private _counterBreak = 0;
    /** 无视抗性的比例（石 / 时间属性） */
    private _pierceResist = 0;
    private _moveDir: Vec2 = { x: 0, y: 0 };
    private _moveStrength = 0;
    /** 每帧自动衰减的拖动输入，防止松手后还一直跑 */
    private _inputHold = 0;

    constructor(cb?: BattleCallbacks) {
        if (cb) this.cb = cb;
    }

    // ================================================================
    // 开局
    // ================================================================

    /** 重置并开始一场战斗 */
    setup(cfg: BattleSetup): void {
        this.arenaW = cfg.arenaW ?? ARENA_W;
        this.arenaH = cfg.arenaH ?? ARENA_H;
        // 射程按全屏来：不配就是场地对角线，场上没有任何敌人在射程外
        this.engageRange = cfg.engageRange && cfg.engageRange > 0
            ? cfg.engageRange
            : fullScreenRange(this.arenaW, this.arenaH);
        this._rng = makeRng(cfg.seed ?? 20261014);
        this._nextId = 1;
        this._killedEnemyIds = new Set(cfg.killedEnemyIds ?? []);
        resetProjectileIds();

        this.player = {
            id: 0,
            pos: v2(this.arenaW / 2, this.arenaH * 0.24),
            radius: PLAYER_RADIUS,
            hp: cfg.playerHp,
            maxHp: cfg.playerHp,
            alive: true,
            speed: cfg.playerSpeed ?? PLAYER_SPEED,
            facing: v2(0, 1), // 竖屏默认朝上，符合"敌人在上方"的直觉
            shield: Math.max(0, Math.round(cfg.shield ?? 0)),
        };

        this.enemies = [];
        this.projectiles = [];
        this.enemyShots = [];
        this.weapons = cfg.weapons.map((w) => this.toRuntime(w));
        this._thorns = Math.max(0, cfg.thorns ?? 0);
        this._shieldBonus = this.player.shield;
        this._resist = cfg.resist || {};
        this._pierceResist = Math.max(0, Math.min(0.9, cfg.pierceResist || 0));
        this._counterBreak = Math.max(0, Math.min(0.9, cfg.counterBreak || 0));

        this.time = 0;
        this.stats = {
            kills: 0, damageDealt: 0, shotsFired: 0, elapsed: 0, critCount: 0, shieldAbsorbed: 0, resistReduced: 0, elementDamage: 0, counterBreak: 0,
        };
        this._enemySpec = cfg.enemy;
        this._spawnLeft = cfg.enemy.count;
        this._spawnKinds = cfg.enemy.waves ? [] : this.buildSpawnKinds(cfg.enemy);
        this._spawnKindIdx = 0;
        this._elementPool = cfg.enemy.elements && cfg.enemy.elements.length
            ? cfg.enemy.elements.slice()
            : null;
        this._elementCursor = cfg.enemy.elementCursor !== undefined
            ? cfg.enemy.elementCursor
            : 0;
        this._batchIndex = 0;
        this._batchTimer = 0;
        this._moveDir = { x: 0, y: 0 };
        this._moveStrength = 0;
        this._inputHold = 0;

        this.result = 'ongoing';
        this.running = true;

        this._waveIndex = 0;
        this._waveElapsed = 0;
        this._hurtCooldown = 0;
        this._waveByEnemy.clear();
        if (cfg.enemy.waves?.length) {
            this._spawnLeft = 0;
            const p = cfg.waveProgress;
            const total = cfg.enemy.waves.reduce((n, w) => n + w.duration, 0);
            if (p?.version === 1 && Number.isFinite(p.elapsed) && p.elapsed >= 0 &&
                Number.isInteger(p.nextId) && p.nextId > 0 && p.nextId < 10000000 &&
                Number.isInteger(p.waveIndex) && p.waveIndex >= 0 && p.waveIndex <= cfg.enemy.waves.length &&
                Number.isFinite(p.waveElapsed) && p.waveElapsed >= 0 &&
                Number.isFinite(p.spawnTimer) && p.spawnTimer >= 0 && Array.isArray(p.alive) &&
                p.waveElapsed < (cfg.enemy.waves[p.waveIndex]?.duration ?? 1) &&
                Math.abs(Math.min(p.elapsed, total) - (cfg.enemy.waves.slice(0, p.waveIndex).reduce((n, w) => n + w.duration, 0) + p.waveElapsed)) < .1) {
                this.time = p.elapsed;
                this.stats.elapsed = this.time;
                this._waveIndex = p.waveIndex;
                this._waveElapsed = p.waveElapsed;
                this._batchTimer = Math.min(p.spawnTimer, cfg.enemy.waves[p.waveIndex]?.spawnInterval ?? 1);
                const seen = new Set<number>();
                let restoredCount = 0;
                for (const ref of p.alive) {
                    if (restoredCount >= (cfg.enemy.maxAlive ?? 240)) break;
                    if (!ref || typeof ref !== 'object' || !Number.isInteger(ref.id) || ref.id < 1 || ref.id >= p.nextId || seen.has(ref.id) ||
                        !Number.isInteger(ref.waveIndex) || !cfg.enemy.waves[ref.waveIndex] || ref.waveIndex > p.waveIndex || this._killedEnemyIds.has(ref.id)) continue;
                    seen.add(ref.id);
                    this._nextId = ref.id;
                    this.enemies.push(this.makeEnemy(ref.waveIndex));
                    restoredCount += 1;
                }
                this._nextId = p.nextId;
            } else {
                this.spawnTimedBatch();
                this._batchTimer = cfg.enemy.waves[0].spawnInterval;
            }
            return;
        }

        // 立刻放第一批，别让玩家开局空等
        this.spawnBatch();
        this._batchTimer = cfg.enemy.batchInterval;
    }

    /**
     * 取下一只敌人的属性。
     *
     * 【为什么用轮转而不是每次随机】
     *   随机分配会出现"连着 4 只都是光属性"，玩家刚镶好的暗属性武器突然没用了，
     *   体感是"系统在耍我"。轮转保证属性均匀铺开、每一批都能见到全部属性，
     *   于是"哪把武器带哪个属性"这件事始终是稳定的策略而不是运气。
     *   传了 elementCursor 就完全可复现（测试用），没传则从 0 开始轮转。
     */
    private nextElement(): string {
        const pool = this._elementPool;
        if (!pool || pool.length === 0) return DEFAULT_ELEMENT;
        const i = this._elementCursor % pool.length;
        this._elementCursor += 1;
        return pool[i];
    }

    private toRuntime(spec: WeaponSpec): WeaponRuntime {
        const w: WeaponRuntime = JSON.parse(JSON.stringify(spec));
        w.cd = 0;
        w.lockedId = 0;
        return w;
    }

    /**
     * 生成"这一关的敌人类型序列"。
     *
     * 先按五类比例（melee / ranged / elite / swift / charger）分配，
     * 再 Fisher-Yates 洗牌，最后走一遍分批兜底。
     *
     * 【为什么整关洗牌还不够，还要"分批兜底"】
     *   整关洗牌能保证**总数**对，但保证不了**分布**：
     *   12 只怪 / 4 批 / 40% 远程 = 5 只远程，纯随机的期望是
     *   某一批可能一只远程都不出（概率约 13%），于是玩家会遇到
     *   "前两波纯贴脸互殴、第三波突然被弹丸糊脸"——
     *   难度不是渐进的，而是突变的。
     *   所以洗牌之后再走一遍分批检查：只要远程总数够每批 1 只，
     *   就保证每一批至少有 1 只远程。多出来的远程仍然随机撒。
     *
     * 【普通 / 困难怎么避免新种类】
     *   它们传给 spawn 的 elite/swift/chargerRatio 都是 0，
     *   `_clampedCount` 返回 0，下面循环就只填 melee / ranged，
     *   自动退化成旧的二分逻辑。
     */
    private buildSpawnKinds(spec: BattleSetup['enemy']): EnemyKind[] {
        const total = Math.max(0, Math.floor(spec.count));
        const ranged = this._clampedCount(total, spec.rangedRatio ?? 0, 0.6);
        const elite = this._clampedCount(total, spec.eliteRatio ?? 0, 1);
        const swift = this._clampedCount(total, spec.swiftRatio ?? 0, 1);
        const charger = this._clampedCount(total, spec.chargerRatio ?? 0, 1);

        const kinds: EnemyKind[] = [];
        let specialLeft = ranged + elite + swift + charger;
        let rangedLeft = ranged, eliteLeft = elite, swiftLeft = swift, chargerLeft = charger;
        for (let i = 0; i < total; i++) {
            if (specialLeft <= 0) {
                kinds.push('melee');
                continue;
            }
            // 按剩余权重随机挑一个非 melee 种类
            const w = rangedLeft + eliteLeft + swiftLeft + chargerLeft;
            const pick = this._rng() * w;
            let acc = 0;
            if ((acc += rangedLeft) >= pick) { kinds.push('ranged'); rangedLeft--; }
            else if ((acc += eliteLeft) >= pick) { kinds.push('elite'); eliteLeft--; }
            else if ((acc += swiftLeft) >= pick) { kinds.push('swift'); swiftLeft--; }
            else { kinds.push('charger'); chargerLeft--; }
            specialLeft--;
        }

        for (let i = kinds.length - 1; i > 0; i--) {
            const j = Math.floor(this._rng() * (i + 1));
            const t = kinds[i];
            kinds[i] = kinds[j];
            kinds[j] = t;
        }

        this.spreadRangedPerBatch(kinds, ranged, Math.max(1, Math.floor(spec.batchSize)));
        return kinds;
    }

    /** 把"按比例取整"集中到一个地方：四舍五入后再封顶到 maxFrac */
    private _clampedCount(total: number, ratio: number, maxFrac: number): number {
        const r = Math.max(0, Math.min(1, ratio));
        let n = Math.round(total * r);
        n = Math.min(n, Math.floor(total * maxFrac));
        return n;
    }

    /**
     * 分批兜底：保证每批至少 1 只远程怪（远程总数足够时）。
     *
     * 做法是逐批扫描，把"这一批一只远程都没有"的位置，
     * 与"其他批远程最多"的位置做一个交换 —— 相当于把远程配额
     * 从富余的批匀给空缺的批，多余的远程仍然留在原位随机分布。
     */
    private spreadRangedPerBatch(kinds: EnemyKind[], ranged: number, batchSize: number): void {
        const batchCount = Math.ceil(kinds.length / batchSize);
        if (batchCount < 2 || ranged < batchCount) return;

        // 每批的 [起, 止)
        const bounds: number[] = [];
        for (let b = 0; b < batchCount; b++) {
            bounds.push(b * batchSize, Math.min(kinds.length, (b + 1) * batchSize));
        }

        const countRanged = (from: number, to: number): number => {
            let n = 0;
            for (let i = from; i < to; i++) if (kinds[i] === 'ranged') n++;
            return n;
        };

        for (let b = 0; b < batchCount; b++) {
            const from = bounds[b * 2];
            const to = bounds[b * 2 + 1];
            if (countRanged(from, to) > 0) continue;

            // 从远程最多的那一批借一只
            let best = -1;
            let bestCount = 1;
            for (let o = 0; o < batchCount; o++) {
                if (o === b) continue;
                const c = countRanged(bounds[o * 2], bounds[o * 2 + 1]);
                if (c > bestCount) {
                    bestCount = c;
                    best = o;
                }
            }
            if (best < 0) continue;

            // 借出方那一批要留至少 1 只，所以要给它一只 >= 2 只的批
            const oFrom = bounds[best * 2];
            const oTo = bounds[best * 2 + 1];
            for (let i = oFrom; i < oTo; i++) {
                if (kinds[i] !== 'ranged') continue;
                // 后面还有别的 ranged 就挪这一只
                let hasMore = false;
                for (let j = i + 1; j < oTo; j++) {
                    if (kinds[j] === 'ranged') { hasMore = true; break; }
                }
                if (hasMore) {
                    kinds[i] = 'melee';
                    kinds[from] = 'ranged';
                    break;
                }
            }
        }
    }

    // ================================================================
    // 外部输入
    // ================================================================

    /**
     * 拖动输入。
     * @param dir      方向（会被归一化）
     * @param strength 强度 0~1，摇杆式拖动用它做速度缩放
     */
    setMoveInput(dir: Vec2, strength: number): void {
        if (vlen(dir) < 1e-4 || strength <= 0) {
            this._moveDir = { x: 0, y: 0 };
            this._moveStrength = 0;
            this._inputHold = 0;
            return;
        }
        this._moveDir = vnorm(dir);
        this._moveStrength = Math.max(0, Math.min(1, strength));
        // 保持 0.12 秒：触摸事件在部分机型上会丢帧，短暂保持能避免走位一顿一顿
        this._inputHold = 0.12;
    }

    /** 立即停止移动（例如战斗结束、弹窗打开） */
    stopMove(): void {
        this.setMoveInput(ZERO, 0);
    }

    /**
     * 用新的武器参数覆盖当前武器（**装备进化后必须调用**）。
     *
     * 按 equipId 就地合并，保留冷却与锁定状态：
     *   - 保留冷却：防止进化瞬间立刻多打一发
     *   - 保留锁定：进化不该丢掉当前锁定的目标
     */
    syncWeapons(specs: WeaponSpec[]): void {
        const next: WeaponRuntime[] = [];
        for (const spec of specs) {
            const old = this.weapons.find((w) => w.equipId === spec.equipId);
            const w: WeaponRuntime = JSON.parse(JSON.stringify(spec));
            w.cd = old ? old.cd : 0;
            w.lockedId = old ? old.lockedId : 0;
            next.push(w);
        }
        this.weapons = next;
    }

    /** 重复同步不会回血或补满护盾；只应用新增的生命/护盾额度。 */
    syncPlayerStats(spec: PlayerCombatSpec): void {
        const maxHp = Math.max(1, Math.round(spec.maxHp));
        const deltaHp = maxHp - this.player.maxHp;
        this.player.maxHp = maxHp;
        if (this.player.alive) this.player.hp = Math.max(1, Math.min(maxHp, this.player.hp + deltaHp));
        const shield = Math.max(0, Math.round(spec.shield));
        this.player.shield = Math.max(0, this.player.shield + shield - this._shieldBonus);
        this._shieldBonus = shield;
        this.player.speed = Math.max(0, spec.speed);
        this._thorns = Math.max(0, spec.thorns);
        this._resist = { ...spec.resist };
        this._pierceResist = Math.max(0, Math.min(0.9, spec.pierceResist));
        this._counterBreak = Math.max(0, Math.min(0.9, spec.counterBreak));
        this.cb.onPlayerHpChanged?.(this.player.hp, this.player.maxHp);
    }

    // ================================================================
    // 主循环
    // ================================================================

    update(dt: number): void {
        if (!this.running) return;

        // dt 上限：手机会掉帧，一个大 dt 会让判定体瞬移穿过敌人
        const step = Math.min(dt, 1 / 30);
        this.time += step;
        this.stats.elapsed = this.time;
        this._hurtCooldown = Math.max(0, this._hurtCooldown - step);

        this.updatePlayer(step);
        this.updateWeapons(step);
        this.updateProjectiles(step);
        this.updateEnemies(step);
        this.updateEnemyShots(step);
        this.updateSpawn(step);
        this.cleanup();
        this.checkEnd();
    }

    /** 1. 玩家移动与朝向 */
    private updatePlayer(dt: number): void {
        if (!this.player.alive) return;

        if (this._inputHold > 0) this._inputHold -= dt;
        if (this._inputHold <= 0) {
            this._moveStrength = 0;
            this._moveDir = { x: 0, y: 0 };
        }

        if (this._moveStrength <= 0.01) return;

        const dir = vnorm(this._moveDir);
        const speed = this.player.speed * this._moveStrength;
        this.player.pos.x += dir.x * speed * dt;
        this.player.pos.y += dir.y * speed * dt;

        // 朝向跟随移动方向 —— 这决定了"前向攻击"能不能打中人
        this.player.facing = dir;

        // 限制在场地内（留出半径，不让玩家跑出屏幕）
        const m = this.player.radius + 8;
        this.player.pos.x = Math.max(m, Math.min(this.arenaW - m, this.player.pos.x));
        this.player.pos.y = Math.max(m, Math.min(this.arenaH - m, this.player.pos.y));
    }

    /** 2. 武器开火 */
    private updateWeapons(dt: number): void {
        if (!this.player.alive) return;
        const alive = this.enemies.filter((e) => e.alive);

        for (const w of this.weapons) {
            w.cd -= dt;
            if (w.cd > 0) continue;

            const aim = resolveAim({
                mode: w.aimMode,
                playerPos: this.player.pos,
                facing: this.player.facing,
                moveDir: this._moveDir,
                moveStrength: this._moveStrength,
                enemies: alive,
                lockedId: w.lockedId,
                // 索敌射程 = 全屏。武器自带的 range 只管"打出去长什么样"，
                // 不参与够不够得着的判断（详见 BattleTypes.fullScreenRange）
                range: this.engageRange,
            });

            // 写回锁定状态（只有 LOCK_ON 会给出非 0 值）
            if (w.aimMode === AimModeId.LOCK_ON) {
                w.lockedId = aim.lockedId;
            }

            if (aim.skip) {
                // 没目标：短冷却后重试，不占用整个攻击间隔
                w.cd = 0.12;
                continue;
            }

            // 有明确目标时把距离交给弹道工厂 —— 子弹飞到目标身后一点就收尾
            let targetDist = 0;
            if (aim.targetId) {
                const t = alive.find((e) => e.id === aim.targetId);
                if (t) targetDist = vdist(t.pos, this.player.pos);
            }

            const spawned = buildAttack(
                aim.dir,
                aim.fullScreen,
                w,
                {
                    arenaW: this.arenaW,
                    arenaH: this.arenaH,
                    playerPos: this.player.pos,
                    engageRange: this.engageRange,
                    targetDist,
                },
                alive,
                this._rng
            );

            if (spawned.length === 0) {
                w.cd = 0.12;
                continue;
            }

            // 判定体生成瞬间盖上一份"这一发的性质"，之后武器再进化也不影响已飞出的弹
            let produced = spawned.length;
            for (const p of spawned) {
                p.critRate = w.critRate;
                p.critMul = w.critMul;
                p.lifesteal = w.lifesteal;
                // 镶嵌的属性同理：命中时才知道敌人属性，克制倍率那一刻才算
                p.elements = w.elements;
                p.highHpDmg = w.highHpDmg;
                this.projectiles.push(p);
            }

            // 额外弹道（来自连装匣 / 分光印记）：
            // 飞行类判定体直接复制并散开角度；挂在玩家身上的挥砍类
            // 则把复制体沿外推方向再前移一段，等于把扫过的环带加宽。
            const extra = Math.max(0, Math.floor(w.extraShots || 0));
            if (extra > 0) {
                const base = spawned.slice();
                for (let k = 1; k <= extra; k++) {
                    const side = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2);
                    for (const src of base) {
                        const c: Projectile = JSON.parse(JSON.stringify(src));
                        c.id = this._extraShotId++;
                        c.hitIds = [];
                        if (c.attachDist >= 0) {
                            c.attachDist = c.attachDist + side * 58;
                        } else {
                            c.dir = vrot(c.dir, side * 0.17);
                        }
                        this.projectiles.push(c);
                        produced += 1;
                    }
                }
            }

            w.cd = w.interval;
            this.stats.shotsFired += produced;
            if (this.cb.onWeaponFired) this.cb.onWeaponFired(w, spawned[0]);
        }
    }

    /** 3. 判定体推进与命中 */
    private updateProjectiles(dt: number): void {
        for (const p of this.projectiles) {
            if (!p.alive) continue;

            if (p.delay > 0) {
                p.delay -= dt;
                if (p.delay > 0) continue;
            }

            p.life -= dt;
            if (p.life <= 0) {
                p.alive = false;
                continue;
            }

            if (p.growRate !== 0) p.radius += p.growRate * dt;

            if (p.attachDist >= 0) {
                // 挂在玩家身上的判定体（挥砍/剑气/震荡波）：
                // 位置随走位和朝向一起动，speed 表现为"向外延伸"
                p.attachDist += p.speed * dt;
                p.pos = vadd(this.player.pos, vscale(this.player.facing, p.attachDist));
            } else {
                p.pos.x += p.dir.x * p.speed * dt;
                p.pos.y += p.dir.y * p.speed * dt;

                // 出界即销毁（无限穿透的滚轮也靠这条收尾）
                const m = p.radius + 60;
                if (p.pos.x < -m || p.pos.x > this.arenaW + m || p.pos.y < -m || p.pos.y > this.arenaH + m) {
                    p.alive = false;
                    continue;
                }
            }

            this.resolveHits(p);
        }
    }

    /** 单个判定体的命中结算 */
    private resolveHits(p: Projectile): void {
        for (const e of this.enemies) {
            if (!e.alive) continue;
            if (p.hitIds.indexOf(e.id) >= 0) continue;
            if (vdist(p.pos, e.pos) > p.radius + e.radius) continue;

            p.hitIds.push(e.id);
            this.damageEnemy(e, p.damage, p);

            if (p.chainLeft > 0) {
                // 连锁：跳到下一个还没打过的敌人
                p.chainLeft -= 1;
                const nxt = findNearest(this.enemies, e.pos, p.hitIds);
                if (!nxt) {
                    p.alive = false;
                    return;
                }
                p.dir = vnorm(vsub(nxt.pos, e.pos));
                p.pos = vcopy(e.pos);
                p.life = Math.max(p.life, 0.22);
            } else if (p.pierce > 0) {
                p.pierce -= 1;
            } else if (p.pierce === 0) {
                p.alive = false;
                return;
            }
            // pierce < 0：无限穿透，继续飞
        }
    }

    /** 4. 敌人 AI：5 个 EnemyKind 各走各的子函数 */
    private updateEnemies(dt: number): void {
        for (const e of this.enemies) {
            if (!e.alive) continue;
            if (e.hitFlash > 0) e.hitFlash -= dt;
            if (e.atkCd > 0) e.atkCd -= dt;
            if (e.shotCd > 0) e.shotCd -= dt;
            // chargeTimer / chargeDashLeft 由 updateChargerEnemy 自己管（处理 dt 浮点边界）

            const toPlayer = vsub(this.player.pos, e.pos);
            const d = vlen(toPlayer);
            const n = vnorm(toPlayer);

            if (e.kind === 'ranged') {
                this.updateRangedEnemy(e, d, n, dt);
                continue;
            }
            if (e.kind === 'elite') {
                this.updateEliteEnemy(e, d, n, dt);
                continue;
            }
            if (e.kind === 'swift') {
                this.updateSwiftEnemy(e, d, n, dt);
                continue;
            }
            if (e.kind === 'charger') {
                this.updateChargerEnemy(e, d, n, dt);
                continue;
            }

            // ---- melee：一路贴脸，贴上了就按间隔咬一口 ----
            const touch = e.radius + this.player.radius + 4;
            if (d > touch) {
                e.pos.x += n.x * e.speed * dt;
                e.pos.y += n.y * e.speed * dt;
            } else if (e.atkCd <= 0 && this.player.alive) {
                e.atkCd = e.atkInterval;
                this.damagePlayer(e.atk, true, e);
            }
        }
    }

    /**
     * 敌人 AI 主循环（5 个 EnemyKind 分支）。
     *
     *   ranged  → 维持间距 + 射击（详见 updateRangedEnemy）
     *   elite   → 贴脸慢推，但**有护盾**（详见 updateEliteEnemy）
     *   swift   → 高速贴脸，比 melee 更快（详见 updateSwiftEnemy）
     *   charger → 三阶段：走近 → 蓄力 → 冲刺（详见 updateChargerEnemy）
     *   melee   → 贴脸普攻（沿用原逻辑）
     *
     * 把"噩梦更难"从单纯的"怪更硬更多"升级成"怪有性格"，
     * 让玩家不可能靠一套走位撑过去 —— 这正是用户要"怪种类与智能性加高"的落点。
     */
    private updateEnemiesLegacy(dt: number): void {
        void dt;
        // 占位用：实际逻辑在上面那个 updateEnemies 里。
        // 这个空方法存在的唯一原因是下面五个子函数需要挂在某个函数名上
        // （TypeScript 不允许两个同名方法），等所有 AI 切完再删除。
        return;
    }

    /**
     * 远程怪：维持 kiteRange 的间距，并在有视线时射击。
     *
     * 死区（KITE_DEADZONE）是必须的：没有它，敌人会在
     * "距离略大于目标 → 前进一帧 → 距离略小于目标 → 后撤一帧"之间
     * 高频抖动，画面上看起来像在原地抽筋。
     */
    private updateRangedEnemy(e: EnemyState, d: number, n: Vec2, dt: number): void {
        const far = e.kiteRange + KITE_DEADZONE;
        const near = e.kiteRange - KITE_DEADZONE;

        if (d > far) {
            // 太远：靠近
            e.pos.x += n.x * e.speed * dt;
            e.pos.y += n.y * e.speed * dt;
        } else if (d < near) {
            // 太近：后撤。这就是"必须主动切入"的压迫感来源
            e.pos.x -= n.x * e.speed * dt;
            e.pos.y -= n.y * e.speed * dt;
        }
        // 死区内保持不动，专心射击

        this.clampEnemyPos(e);

        if (e.shotCd <= 0 && this.player.alive) {
            e.shotCd = e.shotInterval;
            this.fireEnemyShot(e, n);
        }
    }

    /**
     * 精英怪：贴脸慢推，但**有护盾**。
     *
     * 移动用 `e.speed`（已乘过 0.7，比普通近战慢）；攻击用普通 atk；
     * 护盾由 `damageEnemy` 优先扣除 —— 玩家必须先打穿护盾才能扣血。
     * 视觉上是"血厚的肉盾"，持续压力源，玩家必须持续输出而不是靠走位躲。
     */
    private updateEliteEnemy(e: EnemyState, d: number, n: Vec2, dt: number): void {
        const touch = e.radius + this.player.radius + 4;
        if (d > touch) {
            e.pos.x += n.x * e.speed * dt;
            e.pos.y += n.y * e.speed * dt;
            this.clampEnemyPos(e);
        } else if (e.atkCd <= 0 && this.player.alive) {
            e.atkCd = e.atkInterval;
            this.damagePlayer(e.atk, true, e);
        }
    }

    /**
     * 高速突进怪：贴脸速度比普通近战快 70%，攻击间隔不变。
     *
     * 没用 chargeTimer，没用远程 —— 就是"贴脸更快"。被它咬到的玩家
     * 会明显感到"怎么这么快"，逼出"看到突进怪就要提前反应"的肌肉记忆。
     */
    private updateSwiftEnemy(e: EnemyState, d: number, n: Vec2, dt: number): void {
        const touch = e.radius + this.player.radius + 4;
        if (d > touch) {
            e.pos.x += n.x * e.speed * dt;
            e.pos.y += n.y * e.speed * dt;
            this.clampEnemyPos(e);
        } else if (e.atkCd <= 0 && this.player.alive) {
            e.atkCd = e.atkInterval;
            this.damagePlayer(e.atk, true, e);
        }
    }

    /**
     * 冲锋怪：三阶段状态机。
     *
     *   1) 走近（chargeTimer == 0, chargeDashLeft == 0, !isCharging）
     *      → 朝玩家移动。当距离 ≤ 触发半径 → 进入阶段 2
     *
     *   2) 蓄力（chargeTimer > 0, chargeDashLeft == 0, !isCharging）
     *      → 几乎不动（speed × 0.3），锁住方向。蓄力 0.8 秒
     *      → 蓄力完成（chargeTimer 本帧减完归零）→ 进入阶段 3
     *      → 蓄力期间玩家跑出 trigger × 1.4 → 取消蓄力，回到阶段 1
     *
     *   3) 冲刺（isCharging）
     *      → 朝 chargeDir 以 chargeSpeed 冲刺 0.5 秒
     *      → 撞到玩家 → chargeDmg 单次高伤
     *      → 撞到墙或时间到 → 回到阶段 1
     *
     * 【为什么计时在状态机里减，而不是主循环里减】
     *   主循环统一减所有 cd（atk / shot）省事，但 chargeTimer 必须用
     *   `chargeTimer - dt <= 0` 判完成 —— dt 是浮点，主循环减过再判断
     *   会出现 0.0003 之类的残留值，让"完成 → 进入冲刺"这一支跳过去。
     *   蓄力是"我曾经进入过这个状态"才有意义，所以计时收在子函数里。
     */
    private updateChargerEnemy(e: EnemyState, d: number, n: Vec2, dt: number): void {
        const trigger = e.kiteRange * 0.7;

        // 阶段 3：冲刺中
        if (e.isCharging) {
            e.pos.x += e.chargeDir.x * e.chargeSpeed * dt;
            e.pos.y += e.chargeDir.y * e.chargeSpeed * dt;
            this.clampEnemyPos(e);
            e.chargeDashLeft = Math.max(0, e.chargeDashLeft - dt);
            // 撞到玩家
            const touch = e.radius + this.player.radius + 4;
            if (this.player.alive && d <= touch) {
                this.damagePlayer(e.chargeDmg, true, e);
                e.isCharging = false;
                e.chargeDashLeft = 0;
                return;
            }
            // 冲刺时间到
            if (e.chargeDashLeft <= 0) {
                e.isCharging = false;
            }
            return;
        }

        // 阶段 2：蓄力中
        if (e.chargeTimer > 0) {
            // 蓄力时几乎不动
            e.pos.x += n.x * e.speed * DEFAULT_CHARGER_WINDUP_SPEED_MUL * dt;
            e.pos.y += n.y * e.speed * DEFAULT_CHARGER_WINDUP_SPEED_MUL * dt;
            // 玩家跑远 → 取消蓄力
            if (d > trigger * 1.4) {
                e.chargeTimer = 0;
                return;
            }
            // 蓄力完成 → 进入冲刺（用 `减完归零` 而不是 `> 0`，避免 dt 浮点误差导致错过触发）
            if (e.chargeTimer - dt <= 0) {
                e.chargeTimer = 0;
                e.isCharging = true;
                e.chargeDashLeft = DEFAULT_CHARGER_DASH_TIME;
                e.chargeDir = vnorm(e.chargeDir);
            } else {
                e.chargeTimer -= dt;
            }
            return;
        }

        // 阶段 1：走近 → 进入蓄力
        if (d <= trigger) {
            e.chargeDir = vnorm(vsub(this.player.pos, e.pos));
            e.chargeTimer = e.chargeMax;
            return;
        }
        // 还不够近：继续走近
        e.pos.x += n.x * e.speed * dt;
        e.pos.y += n.y * e.speed * dt;
        this.clampEnemyPos(e);
    }

    /** 把敌人钳制在场地内，避免后撤时退到屏幕外变成"看不见的狙击手" */
    private clampEnemyPos(e: EnemyState): void {
        const m = e.radius + 10;
        e.pos.x = Math.max(m, Math.min(this.arenaW - m, e.pos.x));
        e.pos.y = Math.max(m, Math.min(this.arenaH - m, e.pos.y));
    }

    private fireEnemyShot(e: EnemyState, dir: Vec2): void {
        const shot: EnemyShot = {
            pos: v2(e.pos.x + dir.x * (e.radius + 6), e.pos.y + dir.y * (e.radius + 6)),
            dir: vcopy(dir),
            speed: e.shotSpeed,
            radius: 9,
            damage: e.shotAtk,
            element: e.element,
            // 寿命按"够飞半个场地"给，飞完没命中就自然消失，不留残留实体
            life: Math.min(3.0, (fullScreenRange(this.arenaW, this.arenaH) * 0.6) / e.shotSpeed),
            alive: true,
        };
        this.enemyShots.push(shot);
        if (this.cb.onEnemyShoot) this.cb.onEnemyShoot(e, shot);
    }

    /** 4.5 敌弹推进与命中 */
    private updateEnemyShots(dt: number): void {
        const pr = this.player.radius;
        for (const s of this.enemyShots) {
            if (!s.alive) continue;

            s.life -= dt;
            if (s.life <= 0) {
                s.alive = false;
                continue;
            }
            s.pos.x += s.dir.x * s.speed * dt;
            s.pos.y += s.dir.y * s.speed * dt;

            const m = s.radius + 40;
            if (s.pos.x < -m || s.pos.x > this.arenaW + m ||
                s.pos.y < -m || s.pos.y > this.arenaH + m) {
                s.alive = false;
                continue;
            }

            if (this.player.alive && vdist(s.pos, this.player.pos) <= s.radius + pr) {
                s.alive = false;
                // 敌弹要带上属性，否则属性抗性只对近战生效
                this.damagePlayer(s.damage, false, undefined, s.element);
            }
        }
    }

    /** 5. 分波生成 */
    private updateSpawn(dt: number): void {
        if (this._enemySpec?.waves?.length) {
            const waves = this._enemySpec.waves;
            if (this._waveIndex >= waves.length) return;
            this._waveElapsed += dt;
            this._batchTimer -= dt;
            if (this._waveElapsed + 1e-7 >= waves[this._waveIndex].duration) {
                this._waveElapsed = 0;
                this._waveIndex++;
                if (this._waveIndex < waves.length) {
                    this.spawnTimedBatch();
                    this._batchTimer = waves[this._waveIndex].spawnInterval;
                }
                return;
            }
            if (this._batchTimer <= 1e-7) {
                this.spawnTimedBatch();
                this._batchTimer += waves[this._waveIndex].spawnInterval;
            }
            return;
        }
        if (this._spawnLeft <= 0 || !this._enemySpec) return;
        this._batchTimer -= dt;
        if (this._batchTimer > 0) return;
        this.spawnBatch();
        this._batchTimer = this._enemySpec.batchInterval;
    }

    private spawnBatch(): void {
        if (this._spawnLeft <= 0 || !this._enemySpec) return;
        const spec = this._enemySpec;
        const n = Math.min(spec.batchSize, this._spawnLeft);
        for (let i = 0; i < n; i++) {
            const enemy = this.makeEnemy();
            if (!this._killedEnemyIds.has(enemy.id)) this.enemies.push(enemy);
            this._spawnLeft -= 1;
        }
        this._batchIndex += 1;
    }

    private spawnTimedBatch(): void {
        const spec = this._enemySpec!;
        const wave = spec.waves![this._waveIndex];
        if (!wave) return;
        const capacity = Math.max(0, (spec.maxAlive ?? 240) - this.aliveEnemies.length);
        for (let i = 0; i < Math.min(wave.spawnCount, capacity); i++) {
            const enemy = this.makeEnemy(this._waveIndex);
            if (!this._killedEnemyIds.has(enemy.id)) this.enemies.push(enemy);
        }
    }

    get waveProgress(): WaveProgress | undefined {
        if (!this._enemySpec?.waves?.length) return undefined;
        return { version: 1, elapsed: this.time, waveIndex: this._waveIndex, waveElapsed: this._waveElapsed,
            spawnTimer: Math.max(0, this._batchTimer), nextId: this._nextId,
            alive: this.aliveEnemies.map(e => ({ id: e.id, waveIndex: this._waveByEnemy.get(e.id) ?? 0 })) };
    }

    get waveStatus(): { index: number; count: number; remaining: number; clearing: boolean } | null {
        const waves = this._enemySpec?.waves;
        if (!waves?.length) return null;
        return { index: Math.min(waves.length, this._waveIndex + 1), count: waves.length,
            remaining: Math.max(0, (waves[this._waveIndex]?.duration ?? 0) - this._waveElapsed),
            clearing: this._waveIndex >= waves.length };
    }

    /**
     * 按阵型算出生点。
     *
     * 【为什么阵型必须真的改变敌人位置】
     * "每关最合适的武器不同"如果只写在推荐文案里，玩家第一次不信、第二次就无视了。
     * 只有让敌人的**实际分布**不同，武器之间的取舍才有依据：
     *   成列 → 贯穿武器一枪串一排，单体武器一次只打一个
     *   扎堆 → 范围与连锁武器收益翻倍，单体武器溢出
     *   散兵 → 范围武器只能覆盖到一个，单体精确武器最舒服
     *   人海 → 高频与全屏武器跟得上节奏，慢攻速武器打不过来
     *
     * @param slot 本批第几只，成列阵型用它把敌人前后错开排成一队
     */
    private rollSpawnPos(formation: FormationKind, slot: number): Vec2 {
        const margin = 60;
        const W = this.arenaW;
        const H = this.arenaH;
        const topY = H - margin;
        const startX = margin;
        const endX = W - margin;

        for (let attempt = 0; attempt < 24; attempt++) {
            let x = W / 2;
            let y = topY;

            if (formation === 'line') {
                // 成列：整批走同一条通道，并沿纵向依次排开，形成一条可以被贯穿的队伍
                const laneCount = 5;
                const lane = startX + ((this._batchIndex % laneCount) + 0.5) / laneCount * (endX - startX);
                x = lane + (this._rng() - 0.5) * 40;
                y = topY - (slot % 5) * 48;
            } else if (formation === 'cluster') {
                // 扎堆：围绕一个随机中心挤成一团
                const cx = startX + (0.2 + this._rng() * 0.6) * (endX - startX);
                const cy = topY - 90;
                x = cx + (this._rng() - 0.5) * 160;
                y = cy + (this._rng() - 0.5) * 120;
            } else if (formation === 'swarm') {
                // 人海：三条边都来，散布最广
                const edge = Math.floor(this._rng() * 3);
                if (edge === 0) {
                    x = startX + this._rng() * (endX - startX);
                    y = topY;
                } else if (edge === 1) {
                    x = margin;
                    y = margin + this._rng() * (H - margin * 2);
                } else {
                    x = W - margin;
                    y = margin + this._rng() * (H - margin * 2);
                }
            } else {
                // 散兵：只从上方来，但横向拉得很开
                x = startX + this._rng() * (endX - startX);
                y = topY;
            }

            x = Math.max(margin, Math.min(W - margin, x));
            y = Math.max(margin, Math.min(H - margin, y));
            if (vdist(v2(x, y), this.player.pos) >= SPAWN_SAFE_DIST) return v2(x, y);
        }
        return v2(W / 2, topY);
    }

    /**
     * 老式出生点：从上 / 左 / 右三条边随机进来。
     * 未配阵型的关卡（以及只关心"能不能打中"的老测试）走这条路径。
     */
    private rollLegacyPos(): Vec2 {
        const margin = 60;
        let x = this.arenaW / 2;
        let y = this.arenaH - margin;

        for (let attempt = 0; attempt < 24; attempt++) {
            const edge = Math.floor(this._rng() * 3);
            if (edge === 0) {
                x = margin + this._rng() * (this.arenaW - margin * 2);
                y = this.arenaH - margin;
            } else if (edge === 1) {
                x = margin;
                y = margin + this._rng() * (this.arenaH - margin * 2);
            } else {
                x = this.arenaW - margin;
                y = margin + this._rng() * (this.arenaH - margin * 2);
            }
            if (vdist(v2(x, y), this.player.pos) >= SPAWN_SAFE_DIST) break;
        }
        return v2(x, y);
    }

    /**
     * 生成一只敌人。
     *
     * 类型（melee / ranged / elite / swift / charger）从预先洗好的出生队列里取，
     * 保证每一波里都有远程压力，而不是全挤在最后一批。
     *
     * 各类按其特性在 hp / speed / shield / charge 上做差异化调整：
     *   - melee：基准（贴脸，无护盾、无远程）
     *   - ranged：血少 28%，移速 +15%，射程用 spec.kiteRange 等
     *   - elite：血 +200%，移速 −30%，**护盾 = maxHp × 0.45**
     *   - swift：血 −30%，移速 +70%（贴近速度极快）
     *   - charger：血 +20%，蓄力 0.8s → 冲刺 0.5s × 3.5 倍速度，命中 = atk × 2
     */
    private makeEnemy(waveIndex?: number): EnemyState {
        const spec = this._enemySpec!;
        const wave = waveIndex === undefined ? undefined : spec.waves?.[waveIndex];
        if (wave) {
            this._rng = makeRng(this._nextId * 977 + waveIndex! * 131);
            this._spawnKindIdx = this._nextId - 1;
        }
        let kind: EnemyKind;
        if (wave) {
            const roll = this._rng();
            kind = roll < (spec.rangedRatio ?? 0) ? 'ranged'
                : roll < (spec.rangedRatio ?? 0) + (spec.swiftRatio ?? 0) ? 'swift'
                : roll < (spec.rangedRatio ?? 0) + (spec.swiftRatio ?? 0) + (spec.chargerRatio ?? 0) ? 'charger' : 'melee';
            this._spawnKindIdx++;
            this._waveByEnemy.set(this._nextId, waveIndex!);
        } else kind = this._spawnKinds[this._spawnKindIdx++] || 'melee';
        const slot = this._spawnKindIdx - 1;
        const pos = spec.formation ? this.rollSpawnPos(spec.formation, slot) : this.rollLegacyPos();
        const x = pos.x;
        const y = pos.y;

        // ---- 按 kind 决定血量 / 移速倍率 ----
        let hpMul = 1, speedMul = 1, shieldFrac = 0;
        if (kind === 'ranged') {
            hpMul = spec.rangedHpMul ?? DEFAULT_RANGED_HP_MUL;
            speedMul = spec.rangedSpeedMul ?? DEFAULT_RANGED_SPEED_MUL;
        } else if (kind === 'elite') {
            hpMul = spec.eliteHpMul ?? DEFAULT_ELITE_HP_MUL;
            speedMul = spec.eliteSpeedMul ?? DEFAULT_ELITE_SPEED_MUL;
            shieldFrac = spec.eliteShieldFrac ?? DEFAULT_ELITE_SHIELD_FRAC;
        } else if (kind === 'swift') {
            hpMul = spec.swiftHpMul ?? DEFAULT_SWIFT_HP_MUL;
            speedMul = spec.swiftSpeedMul ?? DEFAULT_SWIFT_SPEED_MUL;
        } else if (kind === 'charger') {
            // 冲锋怪：血稍厚一点点（撞到玩家要付代价），移速正常
            hpMul = 1.2;
            speedMul = 1.0;
        }
        if (wave) { hpMul = wave.hpMul; shieldFrac = 0; }
        const hp = Math.max(1, Math.round(spec.hp * hpMul));
        const atk = wave ? Math.max(1, Math.round(spec.atk * wave.atkMul)) : spec.atk;
        const shield = Math.max(0, Math.round(hp * shieldFrac));

        // ---- 冲锋参数 ----
        const chargeMax = spec.chargerWindup ?? DEFAULT_CHARGER_WINDUP;
        const chargeDashTime = spec.chargerDashTime ?? DEFAULT_CHARGER_DASH_TIME;
        const chargeSpeedMul = spec.chargerDashSpeedMul ?? DEFAULT_CHARGER_DASH_SPEED_MUL;
        const chargeDmg = wave ? atk : Math.max(1, Math.round(spec.atk * (spec.chargerHitDmgMul ?? DEFAULT_CHARGER_HIT_DMG_MUL)));

        return {
            id: this._nextId++,
            kind,
            pos: v2(x, y),
            radius: spec.radius,
            hp,
            maxHp: hp,
            alive: true,
            element: this.nextElement(),
            atk,
            speed: spec.speed * speedMul,
            atkInterval: spec.atkInterval,
            // 初始冷却错开一点，避免整批敌人同一帧齐射
            atkCd: 0.3 + this._rng() * 0.4,
            hitFlash: 0,
            expValue: wave ? spec.expValue : spec.expTotal === undefined ? spec.expValue
                : Math.floor((slot + 1) * spec.expTotal / spec.count) - Math.floor(slot * spec.expTotal / spec.count),
            formExpValue: wave ? spec.continuousFormExp : spec.formExpTotal === undefined ? undefined
                : Math.floor((slot + 1) * spec.formExpTotal / spec.count) - Math.floor(slot * spec.formExpTotal / spec.count),

            kiteRange: spec.kiteRange ?? DEFAULT_KITE_RANGE,
            shotAtk: wave ? atk : spec.shotAtk ?? Math.max(1, Math.round(spec.atk * 0.72)),
            shotSpeed: spec.shotSpeed ?? DEFAULT_SHOT_SPEED,
            shotInterval: spec.shotInterval ?? DEFAULT_SHOT_INTERVAL,
            shotCd: kind === 'ranged' ? 0.6 + this._rng() * 0.8 : 999,

            // 护盾（仅 elite 有效）
            shield,
            maxShield: shield,

            // 冲锋（仅 charger 有效）
            chargeTimer: 0,
            chargeMax,
            chargeDir: v2(0, 0),
            isCharging: false,
            chargeDashLeft: 0,
            chargeSpeed: spec.speed * chargeSpeedMul,
            chargeDmg,
        };
    }

    // ================================================================
    // 伤害结算
    // ================================================================

    /**
     * 对敌人造成伤害。
     *
     * 暴击与吸血在这里结算，而不是在生成伤害的地方 ——
     * 因为连锁弹在飞行中会不断换目标，只有"打到人的那一刻"才知道该掷哪一次骰子。
     *
     * @param src 造成伤害的判定体，带暴击/吸血属性；不传 = 纯伤害（环境伤害）
     */
    damageEnemy(e: EnemyState, dmg: number, src?: Projectile): void {
        if (!e.alive) return;

        let final = dmg;

        // 属性克制：武器镶嵌的属性克制这只敌人的属性时 ×1.35，反之 ×0.80。
        // 必须在**命中这一刻**才算，因为敌人属性是逐只不同的，
        // 同一个判定体（连锁弹）会打在不同属性的敌人身上。
        if (src && src.elements && src.elements.length && e.element) {
            // 破防值让克制倍率向 1.0 收敛 —— "装备够好就无视克制"
            const m = elementMulFor(src.elements, e.element, this._counterBreak);
            final *= m;
            // 只累计"吃到克制加成"的那部分伤害，作为 elementCounter 成就的进度。
            // 被克制的负向伤害不算 —— 成就应该奖励"打对了"，而不是"打得多"。
            if (m > 1.001) this.stats.elementDamage += final;
        }

        // 龙属性：对血量高于上限 30% 的敌人加伤。
        // 放在元素倍率之后、暴击之前 —— 它是"打对了目标"的奖励，
        // 不该再被暴击放大（否则一次暴击能到 2.6 倍）。
        if (src && src.highHpDmg && e.maxHp > 0 && e.hp / e.maxHp > 0.3) {
            final *= 1 + src.highHpDmg;
        }

        const critRate = src && src.critRate ? src.critRate : 0;
        if (critRate > 0 && this._rng() < critRate) {
            final = Math.round(final * Math.max(1.1, src!.critMul || 2));
            this.stats.critCount += 1;
        }

        // 精英怪的护盾：先扣护盾再扣血（护盾打空才扣血）。
        // 这与玩家侧的护盾逻辑对称，但**不在 damagePlayer 那条线**——
        // 玩家的盾在自己侧结算，敌人的盾由自己承受（保留 src 上下文好处理减伤与吸血）。
        if (e.shield > 0 && final > 0) {
            const absorbed = Math.min(e.shield, final);
            e.shield -= absorbed;
            final -= absorbed;
            // 护盾吸收算进 damageDealt 之外 —— "对玩家有没有造成伤害"是不同统计。
            // 这里不累加，避免盾被破的瞬间曲线跳变。
        }

        e.hp -= final;
        e.hitFlash = 0.1;
        this.stats.damageDealt += final;

        if (src && src.lifesteal && src.lifesteal > 0) {
            this.healPlayer(final * src.lifesteal);
        }

        if (e.hp <= 0) {
            e.hp = 0;
            e.alive = false;
            this.stats.kills += 1;
            if (this.cb.onEnemyKilled) this.cb.onEnemyKilled(e);
        }
    }

    /** 吸血回复，上限为生命上限 */
    healPlayer(amount: number): void {
        if (!this.player.alive || amount <= 0) return;
        const before = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + amount);
        if (this.player.hp !== before && this.cb.onPlayerHpChanged) {
            this.cb.onPlayerHpChanged(this.player.hp, this.player.maxHp);
        }
    }

    /**
     * 对玩家造成伤害。
     * 护盾优先承受，剩余部分才扣生命 —— 这是"圣盾符"这类辅助装备的实现点。
     *
     * @param raw      敌人打出来的原始伤害
     * @param melee    是否近战接触伤害（决定是否触发荆棘反伤）
     * @param source   近战来源，用于把反伤打回它身上
     */
    damagePlayer(
        raw: number,
        melee = false,
        source?: EnemyState,
        elementOverride?: string
    ): void {
        if (!this.player.alive) return;

        let dmg = Math.max(0, raw);
        if (this._enemySpec?.waves && dmg > 0) {
            if (this._hurtCooldown > 0) return;
            this._hurtCooldown = .35;
        }

        // 属性抗性：只减免**元素属性**那一部分伤害。
        // 减免上限 0.75 —— 不给免疫，否则全属性防具会让玩家彻底不看血条，
        // 噩梦难度的远程压制就失去意义了。
        if (dmg > 0 && this._resist) {
            const el = elementOverride
                || (source && source.element ? source.element : DEFAULT_ELEMENT);
            const rv = this._resist[el];
            if (rv && rv > 0) {
                const before = dmg;
                // 抗性与"无视抗性"相乘而不是相减：
                // 抗性 30% + 无视 15% → 实际只吃 70% × 85% = 59.5%
                dmg *= (1 - Math.min(0.75, rv)) * (1 - this._pierceResist);
                this.stats.resistReduced += before - dmg;
            }
        }

        // 护盾吸收
        if (this.player.shield > 0 && dmg > 0) {
            const absorbed = Math.min(this.player.shield, dmg);
            this.player.shield -= absorbed;
            dmg -= absorbed;
            this.stats.shieldAbsorbed += absorbed;
        }

        if (dmg > 0) {
            this.player.hp -= dmg;
        }
        if (this.cb.onPlayerHurt) this.cb.onPlayerHurt(raw, Math.max(0, this.player.hp));
        if (this.cb.onPlayerHpChanged) {
            this.cb.onPlayerHpChanged(Math.max(0, this.player.hp), this.player.maxHp);
        }

        // 荆棘：被近战咬到时把反伤打回去。远程弹不吃反伤 ——
        // 否则"站着不动靠反伤清屏"会变成一个比走位更优的解。
        if (melee && source && source.alive && this._thorns > 0) {
            this.damageEnemy(source, this._thorns);
        }

        if (this.player.hp <= 0) {
            this.player.hp = 0;
            this.player.alive = false;
            this.running = false;
            this.result = 'lost';
            this.stopMove();
            if (this.cb.onPlayerDead) this.cb.onPlayerDead();
        }
    }

    // ================================================================
    // 收尾
    // ================================================================

    private cleanup(): void {
        if (this._enemySpec?.waves) {
            for (const e of this.enemies) if (!e.alive) this._waveByEnemy.delete(e.id);
            this.enemies = this.enemies.filter(e => e.alive);
        }
        if (this.projectiles.length > 40) {
            this.projectiles = this.projectiles.filter((p) => p.alive);
        }
        if (this.enemyShots.length > 30) {
            this.enemyShots = this.enemyShots.filter((s) => s.alive);
        }
    }

    private checkEnd(): void {
        if (!this.running) return;
        if (!this.player.alive) return;

        const anyAlive = this.enemies.some((e) => e.alive);
        if (this._enemySpec?.waves && this._waveIndex < this._enemySpec.waves.length) return;
        if (!anyAlive && this._spawnLeft <= 0) {
            this.running = false;
            this.result = 'won';
            this.stopMove();
            if (this.cb.onCleared) this.cb.onCleared();
        }
    }

    // ================================================================
    // 查询（渲染层与 HUD 用）
    // ================================================================

    /** 剩余敌人数（含未生成的） */
    get remaining(): number {
        return this._spawnLeft + this.enemies.filter((e) => e.alive).length;
    }

    get aliveEnemies(): EnemyState[] {
        return this.enemies.filter((e) => e.alive);
    }

    /** 场上存活的远程怪数量，HUD 用来提示"小心狙击" */
    get rangedCount(): number {
        let n = 0;
        for (const e of this.enemies) {
            if (e.alive && e.kind === 'ranged') n += 1;
        }
        return n;
    }

    /** 场上飞行中的敌弹数量 */
    get aliveShots(): number {
        let n = 0;
        for (const s of this.enemyShots) {
            if (s.alive) n += 1;
        }
        return n;
    }

    /** 当前锁定的目标 id 集合，渲染层用来画锁定标记 */
    get lockedIds(): number[] {
        const out: number[] = [];
        for (const w of this.weapons) {
            if (w.aimMode === AimModeId.LOCK_ON && w.lockedId) out.push(w.lockedId);
        }
        return out;
    }
}
