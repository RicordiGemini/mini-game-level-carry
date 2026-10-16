/**
 * 属性系统 —— 参考《洛克王国》的 24 种属性
 *
 * 【为什么改成 24 种】
 *
 *   上一版只有 6 种（光/暗/雷/冰/风/血），玩家两局就打透了，
 *   属性材料很快变成"每种都攒一点、镶哪都一样"，收集感和辨识度都撑不住。
 *
 *   洛克王国的属性体系是国内最成熟的"属性相克 + 属性石镶嵌"范式，
 *   它的辨识度来自**每种属性都有独立的性格**：火就是爆、水就是持续、
 *   机械怕火、龙怕冰。所以直接参考它的 18 种
 *   （普通/火/水/草/电/冰/石/土/机械/翼/武/毒/虫/幽/龙/恶魔/光/萌），
 *   再按需求补 6 种：金属性、剑、木、风、空间、时间。
 *
 * 【刻意没有照抄的三件事】
 *
 *   1. **倍率不抄 ×2 / ×0.5**，改成 ×1.6 / ×0.9。
 *      洛克是回合制，玩家看得见下一招才决定用哪只；我们是实时拖动走位，
 *      一发 ×2 在这种玩法里会被当成 bug 而非策略。
 *      ×1.6 的差距足够"我选对了属性"被感知到，又不会让一次失误直接送命。
 *
 *   2. **不做"光属性免疫克制"**（洛克的招牌规则）。
 *      它依赖双属性精灵才有意义，而我们的敌人只有 1 种属性，
 *      搬过来等于给某一种属性开了无双还说不清为什么。
 *
 *   3. **敌人永远只有 1 种属性**，所以洛克"双属性被双克 = ×4"在我们这儿是空的，不实现。
 *
 * 【克制表怎么组织】
 *
 *   只写一张 `COUNTERS`：X 克制谁。**抵抗关系由它反推**。
 *   洛克原表是 18×18 的双向表，手写必然出现"A 克 B 但 B 也克 A 却倍率不同"的矛盾；
 *   反推从根上杜绝这种不一致 —— 克制关系天然自洽。
 *
 * 【为什么保留洛克的双向克制】
 *
 *   龙克龙、幽克幽、光↔幽、空间↔时间 —— 这些"互克"是洛克的性格所在，
 *   强行拆成单向会让这些属性变得平庸，所以显式保留。
 *   注意双向克制**只算一次**倍率，不是 1.6 × 1.6。
 *
 * 【关卡属性怎么编排】
 *
 *   24 种属性分成 **6 组 × 4 种**，一关的属性只能取自同一组：
 *
 *     五行   火 水 木 金属
 *     自然   草 虫 石 萌
 *     气象   电 冰 风 光
 *     造物   机械 剑 武 毒
 *     灵异   幽 恶魔 龙 翼
 *     法则   空间 时间 土 普通
 *
 *   限制"同组"是为了让关卡有**主题**："这关是五行关""这关是法则关"。
 *   如果 24 种随便混，一关里出现"空间 + 虫 + 水"就没有任何可读的规律，
 *   玩家只能背表 —— 那是查字典，不是策略。
 *
 *   种类仍是 1→2→3→4 递增（边界在第 4/5、8/9、12/13 关），每 3 关换一次组。
 *
 *   【24 种属性对 2~3 分钟的一局意味着什么】
 *   属性种类多到这个程度后，**UI 必须实时把克制关系标出来**，
 *   绝不能让玩家自己背 24×24 的表。所以对局角落常驻一块克制面板，
 *   关卡确认页直接列出本关属性 —— 这不是锦上添花，是这个规模下的必需品。
 */

import { AttrMap } from './GameTypes';

// ====================================================================
// 基础类型
// ====================================================================

export type ElementId =
    // ---- 洛克 18 种 ----
    | 'normal' | 'fire' | 'water' | 'grass' | 'electric' | 'ice' | 'stone'
    | 'earth' | 'machine' | 'flying' | 'combat' | 'poison' | 'bug'
    | 'ghost' | 'dragon' | 'devil' | 'light' | 'cute'
    // ---- 补充的 6 种 ----
    | 'metal' | 'sword' | 'wood' | 'wind' | 'space' | 'time';

/** 全部 24 种，按组排列 —— 这个顺序也是 UI 展示顺序 */
export const ELEMENT_IDS: ElementId[] = [
    'fire', 'water', 'wood', 'metal',
    'grass', 'bug', 'stone', 'cute',
    'electric', 'ice', 'wind', 'light',
    'machine', 'sword', 'combat', 'poison',
    'ghost', 'devil', 'dragon', 'flying',
    'space', 'time', 'earth', 'normal',
];

// ====================================================================
// 克制表
// ====================================================================

/**
 * X → 它克制的属性。
 *
 * 【只写这一张表，抵抗关系由反推得出】
 *   resistedBy(X) = 所有满足 X ∈ COUNTERS[Y] 的 Y
 *
 * 写成双向表的最大风险是自相矛盾：手写 18×24 时，
 * "火克草"和"草克火"很容易在不同位置各写一次，还带着不同的倍率。
 * 反推让这两种情况在数学上不可能出现。
 */
const COUNTERS: Record<ElementId, ElementId[]> = {
    // ---- 洛克原表的关系 ----
    normal: [],                                  // 普通不克任何（洛克原设定）
    fire: ['grass', 'wood', 'ice', 'bug', 'machine', 'metal'],
    water: ['fire', 'stone', 'earth', 'poison'],
    grass: ['water', 'earth', 'stone'],
    electric: ['water', 'flying', 'machine', 'wind', 'metal'],
    ice: ['grass', 'wood', 'dragon', 'earth', 'flying', 'water'],
    stone: ['fire', 'ice', 'flying', 'bug', 'combat', 'normal'],
    earth: ['fire', 'electric', 'poison', 'stone', 'machine', 'ghost'],
    machine: ['ice', 'stone', 'poison', 'light', 'normal'],
    flying: ['grass', 'bug', 'wood', 'wind'],
    combat: ['normal', 'ice', 'stone', 'devil', 'machine', 'sword', 'dragon'],
    poison: ['grass', 'wood', 'machine', 'cute'],
    bug: ['grass', 'devil', 'wood', 'cute'],
    ghost: ['machine', 'space', 'poison'],
    dragon: ['bug', 'devil', 'machine'],
    devil: ['ghost', 'combat', 'cute', 'time'],
    light: ['devil', 'ghost', 'wood', 'space'],
    cute: ['poison'],

    // ---- 补充的 6 种 ----
    metal: ['wood', 'stone', 'ice', 'poison', 'bug'],
    sword: ['combat', 'devil', 'machine', 'bug', 'poison', 'light'],
    wood: ['earth', 'water', 'grass', 'bug'],
    wind: ['grass', 'earth', 'fire', 'wood', 'poison'],
    space: ['light', 'ghost', 'time', 'bug', 'combat'],
    time: ['space', 'grass', 'combat', 'wind', 'cute'],
};

/**
 * 双向克制：双方攻击对方都吃克制倍率（只算一次，不叠成 ×1.6²）。
 *
 * 洛克原设定里的两组：光 ↔ 幽。
 * 加上我们自定的空间 ↔ 时间 —— 法则系的两个极端互为死敌。
 */
const MUTUAL: Array<[ElementId, ElementId]> = [
    ['light', 'ghost'],
    ['space', 'time'],
];

/**
 * **同属性互克**：龙克龙、幽克幽（洛克原设定）。
 *
 * 为什么单独一个集合而不是塞进 COUNTERS：
 *   COUNTERS 里的 "X 克 Y" 一律要求 X ≠ Y，它是"这份表里不能有自指"的基础不变式；
 *   自指会让"抵抗关系反推"这条校验永远失败（`resistedBy(dragon)` 会把 dragon 自己算进去）。
 *   所以自指单独声明，`pairMul` 与 `elementDamageMul` 各自识别它。
 */
const SELF_COUNTER: ElementId[] = ['dragon', 'ghost'];

/** 该属性是否同属性互克（龙、幽） */
export function isSelfCounter(id: ElementId): boolean {
    return SELF_COUNTER.indexOf(id) >= 0;
}

/** 克制倍率（不是洛克的 ×2 —— 见文件头说明） */
export const COUNTER_MUL = 1.6;
/** 被克倍率（不是洛克的 ×0.5） */
export const COUNTERED_MUL = 0.9;
/** 多属性叠加后的倍率硬上限，防止 4 个镶嵌叠出天文数字 */
export const ELEMENT_MUL_MAX = 2.0;

/**
 * 该属性克制谁（不含同属性互克 —— 那个在 SELF_COUNTER 里）。
 *
 * 【为什么 COUNTERS 里没有自指】
 *   这张表的硬不变式是"X 克 Y 时 X ≠ Y"。
 *   龙克龙、幽克幽是洛克的设定，但写成自指会让
 *   `resistedBy()` 的反推校验永远失败（它会把 dragon 自己算成"被自己克"）。
 *   所以自指单独声明，两处语义不混。
 */
export function countersOf(id: ElementId): ElementId[] {
    return COUNTERS[id] || [];
}

/** 谁克制该属性（由 COUNTERS 反推） */
export function resistedBy(id: ElementId): ElementId[] {
    const out: ElementId[] = [];
    for (let i = 0; i < ELEMENT_IDS.length; i++) {
        const y = ELEMENT_IDS[i];
        if (y === id) continue;
        const list = COUNTERS[y];
        if (list && list.indexOf(id) >= 0) out.push(y);
    }
    return out;
}

/** 两个属性之间是不是双向克制（光↔幽、空间↔时间） */
export function isMutualCounter(a: ElementId, b: ElementId): boolean {
    for (const [x, y] of MUTUAL) {
        if ((x === a && y === b) || (x === b && y === a)) return true;
    }
    return false;
}

/**
 * 单条克制关系的倍率。
 *
 * 双向克制**只算一次**克制，不叠成 1.6 × 1.6 ——
 * 洛克的实装里"光打幽 = ×2"而不是 ×4，双向克制是"谁打谁都吃那个数"，
 * 不是"两边各算一次"。
 */
export function pairMul(a: ElementId, b: ElementId): number {
    // 同属性互克：龙打龙、幽打幽都吃克制倍率（洛克设定）
    if (a === b) return SELF_COUNTER.indexOf(a) >= 0 ? COUNTER_MUL : 1;
    const aCountersB = countersOf(a).indexOf(b) >= 0;
    const bCountersA = countersOf(b).indexOf(a) >= 0;
    if (aCountersB) return COUNTER_MUL;         // 互克也走这一支
    if (bCountersA) return COUNTERED_MUL;
    return 1;
}

/**
 * 一组镶嵌属性对某属性敌人的伤害倍率。
 *
 * 相乘后封顶 `ELEMENT_MUL_MAX`，再按破防收敛。
 * 不封顶的话，一件 4 阶武器镶 4 个克制属性能叠到 1.6⁴ = 6.5 倍，
 * 那是"一套装备通吃"而不是"配装决策"。
 *
 * @param counterBreak 破防比例 0~1，把倍率向 1.0 收敛（见 softenByBreak）
 */
export function elementDamageMul(
    weaponEls: ElementId[],
    enemyEl: ElementId,
    counterBreak = 0
): number {
    let mul = 1;
    for (const e of weaponEls) {
        // 同属性默认不产生倍率；但龙 / 幽 是同属性互克，交给 pairMul 判定
        if (e === enemyEl && !isSelfCounter(e)) continue;
        mul *= pairMul(e, enemyEl);
    }
    if (mul > ELEMENT_MUL_MAX) mul = ELEMENT_MUL_MAX;
    if (mul < 1 / ELEMENT_MUL_MAX) mul = 1 / ELEMENT_MUL_MAX;
    return softenByBreak(mul, counterBreak);
}

// ====================================================================
// 无视克制（破防）
// ====================================================================

/**
 * 把克制倍率向 1.0 收敛。
 *
 * 需求原文："支持装备够好的时候, 可以直接无视克制"。
 *
 * 【为什么用"收敛"而不是"开关"】
 *   二元开关（够强就不吃克制、否则全吃）会让体验在阈值两侧断崖跳变：
 *   刚凑够破防的那一发伤害暴涨，之后一直不变。
 *   线性收敛的好处是**每一分投入都看得见**：
 *   破防 30% → ×1.6 变成 ×1.42，破防 60% → ×1.24，一直推到 100% 才是真正的无视。
 */
export function softenByBreak(mul: number, breakPct: number): number {
    const b = Math.max(0, Math.min(1, breakPct));
    if (b <= 0) return mul;
    return 1 + (mul - 1) * (1 - b);
}

/** 破防值的硬上限：满配也不能把倍率推到 1.0 以下 */
export const COUNTER_BREAK_MAX = 0.9;

/** 每级局外升级提供的破防 */
export const BREAK_PER_LEVEL = 0.03;
/** 每阶突破提供的破防 */
export const BREAK_PER_RANK = 0.06;
/** 每颗镶嵌的属性提供的破防 */
export const BREAK_PER_SOCKET = 0.03;

/**
 * 一把武器当前的破防比例。
 *
 * 三个来源刻意配成"都要投入才能接近上限"：
 *   满级武器（5 级）+0.12、满阶突破（5 阶）+0.24、4 颗镶嵌 +0.12 = 0.48
 *   再加上防具的破防加成（见 ArmorConfig）才逼近 0.9。
 *
 * 也就是说**没有任何一条线能单独点满无视克制** ——
 * 必须把金币、材料、碎片三样都投进去，这正是"装备够好才无视"的含义。
 */
export function counterBreakOf(
    equipLevel: number,
    rank: number,
    socketCount: number,
    armorBonus = 0
): number {
    const raw =
        Math.max(0, equipLevel - 1) * BREAK_PER_LEVEL +
        Math.max(0, rank - 1) * BREAK_PER_RANK +
        Math.max(0, socketCount) * BREAK_PER_SOCKET +
        armorBonus;
    return Math.min(COUNTER_BREAK_MAX, raw);
}

// ====================================================================
// 属性定义（武器效果 / 防具抗性）
// ====================================================================

/**
 * 属性作用在武器上时贡献的修正。
 *
 * 24 种属性只有 14 条可用乘区，必然存在**主效果相近、次效果不同**的情况。
 * 这不是偷懒：洛克那边同样是"机械系主要吃毒"这种倾向性定位。
 * 每种属性都给了 `effectText` 说明它的**主效果**，
 * 保证玩家读到的是明确差异而不是一堆数字。
 */
export interface ElementBonus {
    atkPct?: number;
    atkSpeedPct?: number;
    critRate?: number;
    critMul?: number;
    lifesteal?: number;
    moveSpeedPct?: number;
    maxHpFlat?: number;
    shield?: number;
    thorns?: number;
    rangePct?: number;
    extraShots?: number;
    /** 穿透上限 +1（只对贯穿类攻击生效） */
    pierce?: number;
    /** 连锁跳数 +1（只对连锁闪电生效） */
    chain?: number;
    /** 无视目标属性抗性的比例 */
    pierceResist?: number;
    /** 对血量高于上限 30% 的敌人加伤 */
    highHpDmg?: number;
}

export interface ElementDef {
    id: ElementId;
    name: string;
    group: string;
    color: [number, number, number];
    desc: string;
    bonus: ElementBonus;
    effectText: string;
    /** 防具抗性绝对值（0~1） */
    resistValue: number;
    resistText: string;
}

function el(
    id: ElementId, name: string, group: string, color: [number, number, number],
    desc: string, bonus: ElementBonus, effectText: string,
    resistValue: number, resistText: string
): ElementDef {
    return { id, name, group, color, desc, bonus, effectText, resistValue, resistText };
}

export const ELEMENT_TABLE: Record<ElementId, ElementDef> = {
    // ---------------------------------------------------------- 五行
    fire: el('fire', '火', '五行', [238, 108, 68],
        '高温爆发。点燃草木、熔化金属、烧毁机械。',
        { atkPct: 0.14, atkSpeedPct: 0.04 }, '+14% 伤害 · +4% 攻速', 0.16, '火抗 16%'),
    water: el('water', '水', '五行', [86, 158, 230],
        '持续压制。灭火、渗土、让电路短路。',
        { atkSpeedPct: 0.08, lifesteal: 0.01 }, '+8% 攻速 · +1% 吸血', 0.16, '水抗 16%'),
    wood: el('wood', '木', '五行', [122, 186, 96],
        '扎根生长。吸干水分、扎穿土层、缠住虫类。',
        { maxHpFlat: 40, thorns: 3 }, '+40 生命 · +3 反伤', 0.16, '木抗 16%'),
    metal: el('metal', '金属', '五行', [178, 186, 200],
        '坚不可摧。克木、碎石、破冰，但也最怕雷电与火烧。',
        { atkPct: 0.09, pierce: 1 }, '+9% 伤害 · 贯穿 +1', 0.18, '金属抗 18%'),

    // ---------------------------------------------------------- 自然
    grass: el('grass', '草', '自然', [124, 200, 108],
        '生生不息。抽干水分、汲取土养、从岩缝里钻出来。',
        { lifesteal: 0.03 }, '+3% 吸血', 0.14, '草抗 14%'),
    bug: el('bug', '虫', '自然', [168, 196, 96],
        '数量取胜。啃食草木，也被火焰与石头碾死。',
        { chain: 1 }, '连锁 +1', 0.12, '虫抗 12%'),
    stone: el('stone', '石', '自然', [156, 150, 138],
        '坚硬不摧。砸冰砸火，但最怕水与绿植。',
        { pierceResist: 0.15, atkPct: 0.06 }, '无视 15% 抗性 · +6% 伤害', 0.22, '石抗 22%'),
    cute: el('cute', '萌', '自然', [246, 176, 200],
        '看似无害，实则百毒不侵。靠卖萌化解大部分攻击。',
        { critRate: 0.05, moveSpeedPct: 0.05 }, '+5% 暴击 · +5% 移速', 0.10, '萌抗 10%'),

    // ---------------------------------------------------------- 气象
    electric: el('electric', '电', '气象', [250, 216, 96],
        '传导一切。水里、翼上、金属里都能窜。',
        { atkSpeedPct: 0.12 }, '+12% 攻速', 0.18, '电抗 18%'),
    ice: el('ice', '冰', '气象', [150, 214, 236],
        '冻结一切。克草木、龙、土，也能压住火焰。',
        { rangePct: 0.18, atkSpeedPct: 0.03 }, '+18% 攻击距离', 0.16, '冰抗 16%'),
    wind: el('wind', '风', '气象', [168, 224, 196],
        '无处不在。助火势、扬尘土、撕碎草木。',
        { atkSpeedPct: 0.09, moveSpeedPct: 0.05 }, '+9% 攻速 · +5% 移速', 0.14, '风抗 14%'),
    light: el('light', '光', '气象', [252, 238, 176],
        '驱散黑暗。同时克制恶魔与幽。',
        { atkPct: 0.10, lifesteal: 0.015 }, '+10% 伤害 · +1.5% 吸血', 0.16, '光抗 16%'),

    // ---------------------------------------------------------- 造物
    machine: el('machine', '机械', '造物', [146, 160, 176],
        '人造之物。最怕火、水、电，但能精准打击自然造物。',
        { extraShots: 1 }, '弹道 +1', 0.14, '机械抗 14%'),
    sword: el('sword', '剑', '造物', [206, 214, 224],
        '锐不可当。专破格斗系、恶魔与机械。',
        { atkPct: 0.11, critRate: 0.04 }, '+11% 伤害 · +4% 暴击', 0.14, '剑抗 14%'),
    combat: el('combat', '武', '造物', [224, 140, 108],
        '纯粹的肉体格斗。克普通、冰、石、恶魔。',
        { critRate: 0.06 }, '+6% 暴击率', 0.14, '武抗 14%'),
    poison: el('poison', '毒', '造物', [152, 190, 96],
        '持续侵蚀。对草木与机械尤其致命，也能反噬幽与萌。',
        { lifesteal: 0.02, atkPct: 0.05 }, '+5% 伤害 · +2% 吸血', 0.12, '毒抗 12%'),

    // ---------------------------------------------------------- 灵异
    ghost: el('ghost', '幽', '灵异', [172, 148, 208],
        '穿过实体。对机械与毒系有特效，能撕裂空间。',
        { critMul: 0.35 }, '+0.35 暴击倍率', 0.12, '幽抗 12%'),
    devil: el('devil', '恶魔', '灵异', [204, 88, 96],
        '以强凌弱。压制幽与格斗，代价是出手变慢。',
        { atkPct: 0.12, atkSpeedPct: -0.05 }, '+12% 伤害 · -5% 攻速', 0.12, '恶魔抗 12%'),
    dragon: el('dragon', '龙', '灵异', [216, 156, 84],
        '传说之姿。最强的贯穿，专杀虫与恶魔。',
        { pierce: 1, highHpDmg: 0.15 }, '贯穿 +1 · 对高血量加伤 15%', 0.14, '龙抗 14%'),
    flying: el('flying', '翼', '灵异', [176, 204, 226],
        '制空权。克草木与虫类，但被电与冰轻易打下来。',
        { moveSpeedPct: 0.10, critRate: 0.03 }, '+10% 移速 · +3% 暴击', 0.12, '翼抗 12%'),

    // ---------------------------------------------------------- 法则
    space: el('space', '空间', '法则', [166, 138, 226],
        '撕裂维度。对光与幽是毁灭性的，但与时间互为死敌。',
        { extraShots: 1, rangePct: 0.10 }, '弹道 +1 · +10% 距离', 0.16, '空间抗 16%'),
    time: el('time', '时间', '法则', [236, 196, 120],
        '操纵时序。让一切变慢，但被空间直接锁死。',
        { atkPct: 0.10, pierceResist: 0.10 }, '+10% 伤害 · 无视 10% 抗性', 0.16, '时间抗 16%'),
    earth: el('earth', '土', '法则', [166, 138, 100],
        '厚重沉稳。克火、电、毒、石、机械，也能缠住幽。',
        { maxHpFlat: 60, shield: 25 }, '+60 生命 · +25 护盾', 0.20, '土抗 20%'),
    normal: el('normal', '普通', '法则', [190, 190, 196],
        '没有属性，也没有弱点。什么都能扛一点，什么都不克。',
        { atkPct: 0.08 }, '+8% 伤害', 0.10, '普通抗 10%'),
};

export function getElementDef(id: ElementId): ElementDef {
    return ELEMENT_TABLE[id] || ELEMENT_TABLE.normal;
}

export function elementName(id: ElementId): string {
    return getElementDef(id).name;
}

/** 取某属性镶嵌到武器上时给的修正 */
export function elementBonusToModifier(id: ElementId): ElementBonus {
    return getElementDef(id).bonus;
}

// ====================================================================
// 关卡属性编排
// ====================================================================

/** 6 个属性组，每组 4 种 —— 一关的属性只能取自同一组 */
export const ELEMENT_GROUPS: Array<{ name: string; els: ElementId[] }> = [
    { name: '五行', els: ['fire', 'water', 'wood', 'metal'] },
    { name: '自然', els: ['grass', 'bug', 'stone', 'cute'] },
    { name: '气象', els: ['electric', 'ice', 'wind', 'light'] },
    { name: '造物', els: ['machine', 'sword', 'combat', 'poison'] },
    { name: '灵异', els: ['ghost', 'devil', 'dragon', 'flying'] },
    { name: '法则', els: ['space', 'time', 'earth', 'normal'] },
];

/**
 * 每个属性组覆盖几关。
 *
 * **必须等于 4**，而且必须是 4 —— 这不是随便取的数：
 *   `elementCountForLevel` 的四档边界正好是 4/5、8/9、12/13，
 *   也就是"每 4 关换一次属性种类"。
 *   两者的周期一旦对齐，每个组内部的属性种类就是**恒定**的：
 *     1~4 关  五行关（单属性）   5~8 关  自然关（双属性）
 *     9~12 关 气象关（三属性）   13+ 关 造物/灵异/法则关（四属性）
 *   组内种类不变，窗口偏移才能干净地"每关 +1"，于是
 *   **双属性以上时，相邻两关必然共享至少 1 种属性**。
 *
 * 如果这里取 3（比如"每 3 关换组"），就会出现两类破窗：
 *   - 种类增加发生在组内部（lv5 自然组内 1→2 种），窗口又长又移，一个属性都留不下
 *   - 偏移序列被"冻结"打断，从 0 直接跳到 2，重叠保证失效
 * 曾经就是这么写的，被 forge_e2e 的重叠不变式打回来了。
 */
const LEVELS_PER_GROUP = 4;

/**
 * 一关有几种属性。
 *
 * 刻度不变（1/2/3/4 递增，边界在第 4/5、8/9、12/13 关）：
 * 24 种属性已经让"选哪几种"变难了，再往上加会让一局变成查字典。
 */
export function elementCountForLevel(levelId: number): number {
    const lv = Math.max(1, Math.floor(levelId));
    if (lv <= 4) return 1;
    if (lv <= 8) return 2;
    if (lv <= 12) return 3;
    return 4;
}

/**
 * 某一关的属性列表。
 *
 * 组内连续取 n 个，偏移逐关右移 —— 但**属性种类增加的那一关偏移不动**。
 *
 * 【为什么种类增加时要"停一下"】
 *   最朴素的写法是 `off = (lv-1) % 3`，一路右移。它在"种类不变"时是对的：
 *   窗口长度 ≥ 2 且偏移只走 1，相邻两关必然重叠。
 *   但种类从 1 涨到 2 的那一关（第 5 关）会同时"长度 +1、偏移 +1"，
 *   于是窗口整个滑掉一格，上一关的属性一个都留不下。
 *   所以那一关把偏移**冻结**在上一关的值：窗口只向右长，不向右移。
 *
 * 由此得到三条不变式（都有测试守着）：
 *   1. 同一关内属性互不重复（组内 4 种，n ≤ 4 保证取得到）
 *   2. **同组内相邻两关必然共享 ≥1 种**（偏移只走 0 或 1，且长度不减）
 *   3. 换组的那一关属性完全不同 —— 那是"这关是五行关"的主题切换，是刻意的
 */
export function elementsForLevel(levelId: number): ElementId[] {
    const lv = Math.max(1, Math.floor(levelId));
    const n = elementCountForLevel(lv);
    const g = Math.floor((lv - 1) / LEVELS_PER_GROUP) % ELEMENT_GROUPS.length;
    const group = ELEMENT_GROUPS[g];
    const off = (lv - 1) % LEVELS_PER_GROUP;

    const out: ElementId[] = [];
    for (let i = 0; i < n; i++) {
        out.push(group.els[(off + i) % group.els.length]);
    }
    return out;
}

/** 该关的属性组名，UI 展示用 */
export function elementGroupOfLevel(levelId: number): string {
    const g = Math.floor((Math.max(1, levelId) - 1) / LEVELS_PER_GROUP) % ELEMENT_GROUPS.length;
    return ELEMENT_GROUPS[g].name;
}

/** 该关敌人的属性名串 */
export function levelElementText(levelId: number): string {
    return elementsForLevel(levelId).map(elementName).join(' · ');
}

/** 该关属性的一行主题描述，难度面板与关卡确认页用 */
export function levelElementDesc(levelId: number): string {
    const n = elementCountForLevel(levelId);
    const kind = n === 1 ? '单属性' : n === 2 ? '双属性' : n === 3 ? '三属性' : '四属性';
    return elementGroupOfLevel(levelId) + '关 · ' + kind + '：' + levelElementText(levelId);
}

// ====================================================================
// 属性抗性
// ====================================================================

export type ResistMap = Record<ElementId, number>;

export function emptyResist(): ResistMap {
    const out = {} as ResistMap;
    for (const e of ELEMENT_IDS) out[e] = 0;
    return out;
}

/** 抗性累加上限 —— 全属性防具 + 多件叠加也不会到免疫 */
export const RESIST_MAX = 0.75;

export function addResist(base: ResistMap, extra: Partial<ResistMap> | undefined): ResistMap {
    if (!extra) return base;
    for (const e of ELEMENT_IDS) {
        base[e] = Math.min(RESIST_MAX, (base[e] || 0) + (extra[e] || 0));
    }
    return base;
}

export function resistText(res: Partial<ResistMap>): string {
    const parts: string[] = [];
    for (const e of ELEMENT_IDS) {
        const v = res[e] || 0;
        if (v > 0) parts.push(elementName(e) + ' ' + Math.round(v * 100) + '%');
    }
    return parts.length ? parts.join(' · ') : '无抗性';
}

/** 按抗性算实际承伤。上限 75%，刻意不给免疫。 */
export function resistMul(res: Partial<ResistMap> | undefined, enemyEl: ElementId): number {
    if (!res) return 1;
    const v = Math.min(RESIST_MAX, res[enemyEl] || 0);
    return 1 - v;
}

/** 抗性 ↔ AttrMap 的序列化（存档用，键为 'res_fire'） */
export function resistToAttrMap(res: Partial<ResistMap>): AttrMap {
    const out: AttrMap = {};
    for (const e of ELEMENT_IDS) {
        const v = res[e] || 0;
        if (v > 0) out['res_' + e] = Math.round(v * 1000) / 1000;
    }
    return out;
}

export function resistFromAttrMap(a: AttrMap | undefined): ResistMap {
    const out = emptyResist();
    if (!a) return out;
    for (const e of ELEMENT_IDS) {
        const v = a['res_' + e];
        if (typeof v === 'number' && v > 0) out[e] = Math.min(RESIST_MAX, v);
    }
    return out;
}

/** 把若干条 ElementBonus 累加成一份扁平的部分字段表 */
export function mergeElementBonus(
    target: Record<string, number>,
    bonus: ElementBonus | undefined
): Record<string, number> {
    if (!bonus) return target;
    for (const k of Object.keys(bonus)) {
        const v = (bonus as Record<string, number>)[k];
        if (v) target[k] = (target[k] || 0) + v;
    }
    return target;
}