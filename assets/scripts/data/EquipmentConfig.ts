/**
 * 武器配置表（局外部分）
 *
 * 【这张表只管"永久投资"这一半】
 *
 *   这里定义的是一件武器在**主界面**上的样子：
 *     解锁条件（关卡 AND 难度）、升级消耗、每级提供的基础伤害。
 *
 *   而它在**局内**长什么样（攻击方式、瞄准方式、进化成哪些形态、
 *   能和谁合成）全部在 FormConfig.ts 的形态图里。
 *   两边的连接点是：**装备 id 就是它的根形态 id**。
 *
 * 【为什么要把局外等级和局内形态拆开】
 *
 *   因为合成进化会改变形态、但不改变"这件武器吃了多少金币投资"。
 *   合成后的"剑雨风暴"依然要吃铁剑与短弓的局外等级收益，
 *   所以基础伤害的来源必须挂在不变的 id 上，而不是挂在会变的形态上。
 *
 * 【12 种武器原型的分工】
 *
 *   「每关最合适的武器都不一样」这件事，靠的不是文案，是这张表：
 *   只有当武器在 射程 / 攻速 / 打击形状 三个维度上真正错开，
 *   关卡才能靠"敌人从哪来、多密、多快"去偏爱其中某几把。
 *
 *   短射程快攻速：blade(前向) dagger(移动向) scythe(扇形)
 *   中射程均衡  ：orb(自动) shuriken(撒网) staff(连锁) spear(贯穿)
 *   长射程慢攻速：bow(锁定) lance(锁定贯穿) cannon(锁定砸落)
 *   超长射程最慢：wheel(全屏)
 *
 * 【新武器靠"关卡 AND 难度"开放】
 *   两个条件都满足才发放，于是推进难度与推进关卡都有明确回报。
 */

import { AimModeId, EquipLevelConf, EquipType, EquipmentDef } from './GameTypes';

/** 升到下一形态所需经验的总量级参考：一关约产出 300~500 点经验 */
export const EXP_PER_KILL_BASE = 30;

/**
 * 各武器原型的基础打击尺度（像素，按 720×1280 竖屏设计分辨率标定）。
 * 实际尺度 = 基础尺度 × (1 + 形态 rangePct + 天赋/辅助 rangePct)。
 *
 * 注意它不是索敌射程 —— 索敌与弹道飞行距离统一按全屏算（见 BattleTypes.fullScreenRange），
 * 否则会出现"锁定了却打不到"的假 bug。
 */
export const WEAPON_BASE_RANGE: Record<EquipType, number> = {
    blade: 95,
    bow: 270,
    orb: 250,
    hammer: 120,
    wheel: 520,
    spear: 300,
    dagger: 200,
    staff: 280,
    scythe: 140,
    cannon: 340,
    shuriken: 230,
    lance: 320,
};

/**
 * 各武器原型的基础攻击间隔（秒）。
 * 近战快、重击慢、全屏最慢 —— 用间隔把不同瞄准方式的收益拉平，
 * 否则"全屏横扫"会直接碾压"前向单体"。
 *
 * 间隔与"打击形状"必须一起看，单独看任何一个都会得到错误结论：
 *   巨镰走 SWEEP（半径 = 射程×0.7，命中范围内全部敌人），
 *   它的"每次挥砍覆盖面积"是铁剑的近战的 4 倍以上，
 *   所以间隔必须明显更长，否则它会变成所有阵型的通用最优解 ——
 *   那样"每关最合适的武器都不一样"就不成立了。
 */
export const WEAPON_BASE_INTERVAL: Record<EquipType, number> = {
    blade: 0.50,
    bow: 0.85,
    orb: 0.90,
    hammer: 1.05,
    wheel: 1.50,
    spear: 0.78,
    dagger: 0.32,
    staff: 1.00,
    scythe: 0.95,
    cannon: 1.70,
    shuriken: 0.55,
    // 光矛是 LOCK_ON（自动瞄准、从不落空）+ 穿透，
    // 而长枪是 FRONT（要靠走位对准、会打空）。
    // 命中率更高的那把必须更慢，否则光矛就是长枪的严格上位替代 ——
    // 实测中长枪约 1/3 的挥击会打空，这就是间隔差的定价依据。
    lance: 1.35,
};

/**
 * 贯穿类武器的**穿透上限**（最多打穿几个敌人）。
 *
 * 为什么必须按武器分开配，而不是所有 PIERCE 统一给 5：
 *   长枪与光矛都是 PIERCE，但长枪是"前向贯穿"（需要玩家对准成列的敌人），
 *   光矛是"锁定贯穿"（自动瞄准，不需要操作）。
 *   如果两者穿透数一样，光矛就变成了长枪的**严格上位替代** ——
 *   同样打穿 5 个、射程更长、还不用瞄准，那长枪就永远没有出场理由。
 *   所以长枪拿满穿透（它是贯穿专家），光矛只穿 3 个（它的定位是"打一条线"）。
 */
export const WEAPON_BASE_PIERCE: Record<EquipType, number> = {
    blade: 1, bow: 1, orb: 1, spear: 5, hammer: 1, dagger: 1,
    staff: 1, scythe: 1, cannon: 1, shuriken: 1, lance: 3, wheel: 1,
};

/** 取穿透上限（非贯穿类返回 1，即只命中一个目标） */
export function getBasePierce(t: EquipType | 'aux'): number {
    if (t === 'aux') return 1;
    return WEAPON_BASE_PIERCE[t] ?? 1;
}

/** 辅助装备没有武器原型，用一组固定档位 */
export const AUX_BASE_RANGE = 240;
export const AUX_BASE_INTERVAL = 1.20;

/** 武器原型的中文名 */
export const EQUIP_TYPE_TEXT: Record<EquipType, string> = {
    blade: '近战',
    bow: '远程',
    orb: '法术',
    hammer: '重击',
    wheel: '割草',
    spear: '穿刺',
    dagger: '速攻',
    staff: '连锁',
    scythe: '横扫',
    cannon: '炮击',
    shuriken: '弹幕',
    lance: '贯穿',
};

/** 取打击尺度，辅助装备走固定档位 */
export function getBaseRange(t: EquipType | 'aux'): number {
    if (t === 'aux') return AUX_BASE_RANGE;
    return WEAPON_BASE_RANGE[t];
}

/** 取攻击间隔，辅助装备走固定档位 */
export function getBaseInterval(t: EquipType | 'aux'): number {
    if (t === 'aux') return AUX_BASE_INTERVAL;
    return WEAPON_BASE_INTERVAL[t];
}

function lv(level: number, baseDamage: number, upgradeCost: number): EquipLevelConf {
    return { level, baseDamage, upgradeCost };
}

/** 批量生成一条 5 级成长曲线：起始伤害、末级倍率、首升价、末升价 */
function levelCurve(startDamage: number, endMul: number, firstCost: number, lastCost: number): EquipLevelConf[] {
    const out: EquipLevelConf[] = [];
    for (let i = 0; i < 5; i++) {
        const t = i / 4;
        // 伤害走线性，价格走二次 —— 越往后越贵，但收益始终是稳的
        const dmg = Math.round(startDamage * (1 + (endMul - 1) * t));
        const cost = i === 0 ? 0 : Math.round(firstCost + (lastCost - firstCost) * (i - 1) / 3);
        out.push(lv(i + 1, dmg, cost));
    }
    return out;
}

// ====================================================================
// 武器表（12 把）
// ====================================================================

export const EQUIPMENT_TABLE: EquipmentDef[] = [
    {
        id: 'blade', name: '铁剑', type: 'blade',
        desc: '前向单体的近战起手武器。必须走位对准才能砍中',
        aimMode: AimModeId.FRONT,
        maxLevel: 5, unlockLevel: 1, unlockDifficulty: 1,
        levels: levelCurve(8, 5.75, 200, 2400),
    },
    {
        id: 'bow', name: '短弓', type: 'bow',
        desc: '锁定一个目标持续追踪，无需自己瞄准',
        aimMode: AimModeId.LOCK_ON,
        maxLevel: 5, unlockLevel: 1, unlockDifficulty: 1,
        levels: levelCurve(9, 6.0, 180, 2200),
    },
    {
        id: 'orb', name: '冰晶球', type: 'orb',
        desc: '自动攻击最近的敌人，解放双手',
        aimMode: AimModeId.NEAREST,
        maxLevel: 5, unlockLevel: 2, unlockDifficulty: 1,
        levels: levelCurve(10, 5.4, 240, 2800),
    },
    {
        id: 'spear', name: '长枪', type: 'spear',
        desc: '前向贯穿直线。敌人排成一列时，一枪能串起整排',
        aimMode: AimModeId.FRONT,
        maxLevel: 5, unlockLevel: 3, unlockDifficulty: 1,
        levels: levelCurve(10, 5.5, 220, 2600),
    },
    {
        id: 'hammer', name: '铁锤', type: 'hammer',
        desc: '朝你拖动的方向砸出震荡波，走哪打哪',
        aimMode: AimModeId.MOVE_DIR,
        maxLevel: 5, unlockLevel: 3, unlockDifficulty: 2,
        levels: levelCurve(14, 5.14, 260, 3000),
    },
    {
        id: 'dagger', name: '飞刃', type: 'dagger',
        desc: '极快攻速的移动向三连射。边走边泼，靠频率压死敌人',
        aimMode: AimModeId.MOVE_DIR,
        maxLevel: 5, unlockLevel: 4, unlockDifficulty: 1,
        levels: levelCurve(4, 4.5, 160, 1800),
    },
    {
        id: 'staff', name: '雷杖', type: 'staff',
        desc: '自动锁最密集处连锁导电。敌人越扎堆越强',
        aimMode: AimModeId.NEAREST,
        maxLevel: 5, unlockLevel: 5, unlockDifficulty: 2,
        levels: levelCurve(11, 5.6, 280, 3200),
    },
    {
        id: 'scythe', name: '巨镰', type: 'scythe',
        desc: '前向大扇形横扫。被围住时一刀清一圈',
        aimMode: AimModeId.FRONT,
        maxLevel: 5, unlockLevel: 6, unlockDifficulty: 1,
        levels: levelCurve(9, 5.6, 240, 2900),
    },
    {
        id: 'cannon', name: '重炮', type: 'cannon',
        desc: '锁定后砸下范围爆炸。射速极慢，一发要打准位置',
        aimMode: AimModeId.LOCK_ON,
        maxLevel: 5, unlockLevel: 7, unlockDifficulty: 2,
        levels: levelCurve(18, 5.5, 320, 3600),
    },
    {
        id: 'shuriken', name: '手里剑', type: 'shuriken',
        desc: '朝移动方向撒出弹幕，跑动中铺满全场',
        aimMode: AimModeId.MOVE_DIR,
        maxLevel: 5, unlockLevel: 8, unlockDifficulty: 1,
        levels: levelCurve(5, 5.0, 200, 2400),
    },
    {
        id: 'lance', name: '光矛', type: 'lance',
        desc: '锁定目标后贯穿一条线，射程内后排也会被串到',
        aimMode: AimModeId.LOCK_ON,
        maxLevel: 5, unlockLevel: 9, unlockDifficulty: 3,
        levels: levelCurve(12, 5.6, 340, 3800),
    },
    {
        id: 'wheel', name: '回旋轮', type: 'wheel',
        desc: '滚轮横扫整个战场，完全不需要瞄准',
        aimMode: AimModeId.SCREEN_ROLL,
        maxLevel: 5, unlockLevel: 5, unlockDifficulty: 3,
        levels: levelCurve(12, 5.5, 300, 3400),
    },

    // ================================================================
    // 第八轮：高阶专属武器（直接以高品阶出生）
    //
    // 这 6 把**不走自动发放**，只能从武器池抽到或用 25 个高阶碎片兑换。
    // 它们与常规武器的区别不在"数值更高"，而在三件事：
    //   1. 原生品阶就是钻石及以上（品质倍率 1.70~2.60）
    //   2. 自带复合属性（innate），不需要镶任何材料就有属性加成
    //   3. 升阶到传说后拿到全游戏唯一的 4 个镶嵌槽
    //
    // 局外等级曲线刻意比同类型常规武器高 40%~60% 的起始伤害 ——
    // 因为它们是"抽到的奖励"，起始就弱于同级常规武器会让抽卡毫无意义。
    // 但终局伤害并没有更高：常规武器靠 depth 4 形态（atkPct 6.5~12）补回来，
    // 于是两条线终局接近，只是**过程体验完全不同**。
    // ================================================================
    {
        id: 'star_blade', name: '星刃', type: 'blade',
        desc: '【钻石】光与剑的双生之刃，出鞘即带破甲之势',
        aimMode: AimModeId.FRONT,
        maxLevel: 5, unlockLevel: 5, unlockDifficulty: 2,
        rarity: 3,
        levels: levelCurve(9, 6.0, 300, 3600),
    },
    {
        id: 'frost_lance', name: '霜寒枪', type: 'spear',
        desc: '【钻石】冰与水凝成的长枪，贯穿之处尽数冻结',
        aimMode: AimModeId.FRONT,
        maxLevel: 5, unlockLevel: 5, unlockDifficulty: 2,
        rarity: 3,
        levels: levelCurve(10, 5.8, 280, 3400),
    },
    {
        id: 'storm_bow', name: '疾风弓', type: 'bow',
        desc: '【史诗】风与翼的合奏，三连箭自带追踪',
        aimMode: AimModeId.LOCK_ON,
        maxLevel: 5, unlockLevel: 7, unlockDifficulty: 2,
        rarity: 4,
        levels: levelCurve(9, 6.0, 320, 3800),
    },
    {
        id: 'quake_hammer', name: '震地锤', type: 'hammer',
        desc: '【史诗】土与石的怒号，每一锤都让地面裂开',
        aimMode: AimModeId.MOVE_DIR,
        maxLevel: 5, unlockLevel: 7, unlockDifficulty: 2,
        rarity: 4,
        levels: levelCurve(14, 6.2, 360, 4200),
    },
    {
        id: 'void_cannon', name: '虚空炮', type: 'cannon',
        desc: '【神话】幽与空间的造物，炮口连着另一个次元',
        aimMode: AimModeId.LOCK_ON,
        maxLevel: 5, unlockLevel: 9, unlockDifficulty: 3,
        rarity: 5,
        levels: levelCurve(18, 6.5, 400, 4800),
    },
    {
        id: 'radiant_wheel', name: '曜日轮', type: 'wheel',
        desc: '【神话】光与火的日轮，滚过之处再无站立之地',
        aimMode: AimModeId.SCREEN_ROLL,
        maxLevel: 5, unlockLevel: 9, unlockDifficulty: 3,
        rarity: 5,
        levels: levelCurve(12, 6.4, 380, 4500),
    },
];

// ====================================================================
// 查询工具
// ====================================================================

export function getEquipDef(id: string): EquipmentDef | null {
    for (const d of EQUIPMENT_TABLE) {
        if (d.id === id) return d;
    }
    return null;
}

/** 取局外等级配置，越界自动收敛到边界值 */
export function getLevelConf(def: EquipmentDef, level: number): EquipLevelConf {
    const idx = Math.max(0, Math.min(def.levels.length - 1, level - 1));
    return def.levels[idx];
}

/** 升到下一级需要的金币，已满级返回 -1 */
export function getUpgradeCost(def: EquipmentDef, curLevel: number): number {
    if (curLevel >= def.levels.length) return -1;
    return def.levels[curLevel].upgradeCost;
}

/**
 * 升级到第2 / 3 / 4 / 5 级各自需要的**突破材料**数量。
 *
 * 【这条线2026-10-16 才真正接上】
 *   第八轮《品阶与升阶设计》§二 承诺"局外升级除了金币还要消耗 `mat_<type>`"，
 *   但实现里 `EquipmentManager.upgrade()` 只扣金币 —— 12 种材料被产出却永远花不掉，
 *   "打推荐关 → 掉双份材料 → 升级那把武器"这条闭环不存在。
 *   另一条消费方 `breakthrough()` 又在第八轮随 forge.rank 一起删除，
 *   于是材料彻底失去消费方。这里补上后，那条设计闭环才成立。
 *
 * 【为什么是1 / 2 / 3 / 4 而不是每级都 1】
 *   每级都 1 的话升满只要 4 个材料，"打 4 局就满"，
 *   材料线退化成一种装饰，玩家感觉不到它在推进。
 *   1+2+3+4 = **累计 10 个**，配合掉落规则
 *   （推荐武器掉 2 个 / 克制武器掉 1 个，见 ForgeManager.rollDrops）
 *   大约是"认真打 10 局左右满级"的量级，与金币曲线（累计约 5000）同档。
 *
 * 【为什么不与品阶共用一套阶梯】
 *   品阶管的是"强度倍率 + 镶嵌槽"，材料管的是"基础伤害能不能升一级"，
 *   两者正交。共用一套会让玩家面对"我要先升阶还是先升级"的伪问题。
 */
export const UPGRADE_MATERIAL_COST: number[] = [1, 2, 3, 4];

/** 升满 5 级累计需要的材料数（UI 展示用） */
export const UPGRADE_MATERIAL_TOTAL = UPGRADE_MATERIAL_COST.reduce((a, b) => a + b, 0);

/**
 * 初始赠送的武器（新号开局）。
 *
 * 【第七轮：从两把改成一把】
 *   玩家需求"开局只给一个基础武器，其他武器都靠抽"。
 *   原来给 blade + bow 两把，是为了让新号立刻体验到两种瞄准方式
 *   （前向 vs 锁定）不至于开局就卡手。
 *
 *   改成只给 blade 之后这个顾虑用**另一种方式**解决了：
 *   局内三选一从第 2 级就能抽到任何武器（见 RewardPicker 的 poolIds 使用），
 *   玩家升一级就会遇到第二把武器，而且可以自己挑要不要。
 *   "自己挑"比"系统给两把"更有参与感，也正好把抽卡的价值前置了。
 */
export const STARTER_EQUIP_IDS: string[] = ['blade'];

/** 取一件武器的难度解锁门槛，未填按 1（普通）算 */
export function getUnlockDifficulty(def: EquipmentDef): number {
    return def.unlockDifficulty === undefined ? 1 : def.unlockDifficulty;
}

/**
 * 判断一件武器是否已解锁。
 * 关卡进度与难度进度是**与**关系：两个条件都满足才发放。
 */
export function isEquipUnlocked(def: EquipmentDef, unlockedLevel: number, globalMaxTier: number): boolean {
    if (unlockedLevel < def.unlockLevel) return false;
    return globalMaxTier >= getUnlockDifficulty(def);
}

/**
 * 按解锁进度过滤玩家该拥有的武器 id 列表。
 *
 * @param unlockedLevel 已解锁到第几关
 * @param globalMaxTier 全局最高已通关难度（跨关卡取最大）
 */
export function getUnlockedEquipIds(unlockedLevel: number, globalMaxTier = 1): string[] {
    const out: string[] = [];
    for (const d of EQUIPMENT_TABLE) {
        if (isEquipUnlocked(d, unlockedLevel, globalMaxTier)) out.push(d.id);
    }
    return out;
}

/** 武器解锁条件的一句话说明，装备面板展示用 */
export function describeUnlock(def: EquipmentDef): string {
    const needTier = getUnlockDifficulty(def);
    if (needTier <= 1) return '解锁条件：通关第 ' + def.unlockLevel + ' 关';
    const names = ['普通', '困难', '噩梦'];
    return '解锁条件：第 ' + def.unlockLevel + ' 关 + 通关' +
        (names[needTier - 1] || ('难度 ' + needTier));
}
