/**
 * 形态图配置 —— 本文件是第三轮重构的核心
 *
 * 【为什么要从"进化链"改成"形态图"】
 *
 * 原来每件装备是一条线性链（stage 0→1→2→3），玩家没有任何选择权：
 * 拿到铁剑就注定变成天罚剑。这带来两个问题：
 *
 *   1. 复玩没有新内容 —— 同一关打第二遍，成长路径和第一遍一模一样
 *   2. 无法表达"两把武器合成一把" —— 线性链里没有第二个输入
 *
 * 改成图之后，玩家需求里的每一件事都能用同一套结构表达：
 *
 *   分支进化   depth 1 的两个形态 → 进三选一时由玩家选路线
 *   合成进化   两件武器 → 一件新武器，消耗一个武器槽
 *   高级进化   标记 advanced 的边**只在携带老档时出现**
 *
 * 【形态与局外装备的关系】
 *
 *   根形态的 id **就是**局外装备 id（'blade' / 'bow' …），
 *   所以 EquipmentConfig 的 12 把武器在这里各有自己的根节点。
 *   合成产物不是任何装备的根形态，它靠 FUSION_RECIPES 产生。
 *
 * 【合成后的基础伤害不会亏】
 *
 *   合成形态的 `sources` 是两件材料武器的局外装备 id 列表，
 *   基础伤害按 sources 求和 —— 铁剑 + 短弓合成后，
 *   一格里吃两把武器的局外等级收益。否则玩家不会愿意合成。
 *
 * 【经验与"可进化"】
 *
 *   每个槽独立累积经验，经验决定它的**形态等级**（1~3 级）。
 *   等级满了才 `ready`，三选一里才会出现它的进化选项。
 *   这就是玩家说的"升级成功然后进化"。
 */

import { AimModeId, AttackModeId, EquipType, EvolutionEdge, FormNode, InnateAttribute } from './GameTypes';
import { AUX_FORMS, AUX_ROOT_IDS } from './AuxConfig';

/** 攻击方式的中文名，形态节点默认取它 */
export const ATTACK_MODE_TEXT: Record<AttackModeId, string> = {
    [AttackModeId.SINGLE_MELEE]: '近战单体',
    [AttackModeId.SINGLE_RANGED]: '远程单体',
    [AttackModeId.TRIPLE_SHOT]: '三连射',
    [AttackModeId.SWEEP]: '范围剑气',
    [AttackModeId.PIERCE]: '穿透直线',
    [AttackModeId.SHOCKWAVE]: '震荡波',
    [AttackModeId.RAIN]: '剑雨覆盖',
    [AttackModeId.CHAIN]: '连锁闪电',
    [AttackModeId.METEOR]: '陨石轰击',
    [AttackModeId.FULL_SWEEP]: '全屏滚动',
};

/**
 * 各级形态所需的**装备形态经验**（累计值）。
 * 索引 = 目标形态等级 - 1。形态等级最高 3 级，满级后才可进化。
 *
 * 刻意压得低：一局正常打能升满 1~2 个槽，
 * 想升满全部槽必须带着继承进来的等级复玩 —— 这正是复玩的动力。
 */
export const FORM_LV_EXP: number[] = [0, 110, 260];

/** 形态等级上限 */
export const FORM_MAX_LV = FORM_LV_EXP.length;

/** 每提升 1 级形态等级提供的攻击加成 */
export const FORM_LV_ATK_PCT = 0.10;

/**
 * 各 depth 的进化经验门槛（形态已满级时，还需要这条线累积多少经验才能进化）。
 * depth 越大门槛越高，终局进化必须打满一局才能摸到。
 */
export const DEPTH_EXP_NEED: number[] = [90, 190, 340, 620, 980];

/** 形态图最大深度（对照 DEPTH_EXP_NEED 的索引上限） */
export const FORM_MAX_DEPTH = 4;

// ====================================================================
// 合成配方
// ====================================================================

/**
 * 双武器合成配方。
 *
 * 与"升级型进化"的关键区别：
 *   升级型   同一槽内换形态，**槽位数量不变**
 *   合成型   材料 A 与材料 B 两个槽 → 产物一个槽，**消耗一个武器槽**
 *            合成完成后 pendingPicks +1，玩家可以再选一件武器补进来
 */
export interface FusionRecipe {
    /** 材料 A 的形态 id */
    a: string;
    /** 材料 B 的形态 id */
    b: string;
    /** 产物形态 id */
    to: string;
    /** 按钮短文案 */
    label: string;
    /** 一句话说明 */
    desc: string;
    /** 仅携带老档（复玩继承）时可用 */
    advanced?: boolean;
}

// ====================================================================
// 武器形态节点
// ====================================================================

interface WOpts {
    aim?: AimModeId;
    aimText?: string;
    desc?: string;
    /** 第八轮：原生品阶（0~6）。不填 = 0（青铜） */
    rarity?: number;
    /** 第八轮：自带复合属性（钻石及以上专属装备才有） */
    innate?: InnateAttribute;
}

function W(
    id: string,
    name: string,
    type: EquipType,
    depth: number,
    atkPct: number,
    rangePct: number,
    mode: AttackModeId,
    opts: WOpts = {},
    evolveTo: EvolutionEdge[] = []
): FormNode {
    return {
        id, name, kind: 'weapon', desc: opts.desc || '',
        equipType: type, sources: [], depth, atkPct, rangePct,
        attackModeId: mode, attackModeText: ATTACK_MODE_TEXT[mode],
        aimModeId: opts.aim, aimModeText: opts.aimText,
        rarity: opts.rarity === undefined ? 0 : opts.rarity,
        innate: opts.innate,
        evolveTo,
    };
}

/** 升级型进化边（不消耗槽位） */
function up(to: string, label: string, desc: string, advanced = false): EvolutionEdge {
    return { to, type: 'upgrade', label, desc, advanced };
}

const TOTAL_SWEEP = AimModeId.SCREEN_ROLL;
const TOTAL_TEXT = '全屏';

/** 所有武器根形态的 id —— 与 EquipmentConfig.EQUIPMENT_TABLE 一一对应 */
/**
 * 所有武器线的根形态 id。
 *
 * 【第八轮起这里必须与 EQUIPMENT_TABLE 保持一致】
 * 它不只用于"局内候选池"，还是 `fillSources()` 遍历的依据 ——
 * 漏掉任何一个根形态，那个形态的 `sources` 会停留在 `[]`，
 * 于是基础伤害算不出来（合成判断与战力汇总都会读到 0）。
 * 早期版本这里漏加了 6 把高阶专属武器，形态图自检立刻报
 * "武器形态缺少 sources"，就是靠这个校验抓出来的。
 */
export const WEAPON_ROOT_IDS: string[] = [
    'blade', 'bow', 'orb', 'spear', 'hammer', 'dagger',
    'staff', 'scythe', 'cannon', 'shuriken', 'lance', 'wheel',
    // 第八轮：高阶专属武器（直接以高品阶出生，不走自动发放）
    'star_blade', 'frost_lance', 'storm_bow', 'quake_hammer',
    'void_cannon', 'radiant_wheel',
];

/**
 * 武器形态表。
 *
 * 读法：depth 0 是根形态（= 局外装备），depth 1 分两条线，
 * depth 2 各自收束，depth 3 是常规终局，depth 4 是**复玩限定**的更上级形态。
 *
 * evolveTo 数组的**第一项是主线** —— v2 老档案迁移时靠它把
 * (装备 id, 旧 stage) 反查成新的 formId，所以顺序不能随意调。
 */
export const WEAPON_FORMS: FormNode[] = [
    // ============================================================ 铁剑
    W('blade', '铁剑', 'blade', 0, 0, 0, AttackModeId.SINGLE_MELEE,
        { aim: AimModeId.FRONT, desc: '前向近战起手武器。必须走位对准才能砍中' }, [
            up('blade_edge', '淬锋', '单体伤害大幅提升，专注砍死一个再下一个'),
            up('blade_wide', '阔刃', '转向范围剑气，一刀扫一片'),
        ]),
    W('blade_edge', '淬锋剑', 'blade', 1, 0.60, 0.10, AttackModeId.SINGLE_MELEE,
        { desc: '单体爆发路线' }, [up('blade_rift', '裂空', '转为范围剑气，兼顾单体与群怪')]),
    W('blade_wide', '阔刃剑', 'blade', 1, 0.45, 0.25, AttackModeId.SWEEP,
        { desc: '范围路线，牺牲单体换群体' }, [up('blade_tempest', '环刃', '剑气环绕周身，来多少扫多少')]),
    W('blade_rift', '裂空剑', 'blade', 2, 1.60, 0.35, AttackModeId.SWEEP,
        { desc: '大范围剑气' }, [up('blade_doom', '天罚', '剑气化为剑雨，覆盖整个战场')]),
    W('blade_tempest', '环刃剑', 'blade', 2, 1.50, 0.30, AttackModeId.SHOCKWAVE,
        { desc: '环绕震荡波' }, [up('blade_zenith', '斩星', '剑气化为陨星，全屏轰击')]),
    W('blade_doom', '天罚剑', 'blade', 3, 3.20, 0.50, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏剑雨，无需瞄准' }, [
            up('blade_genesis', '创世', '剑雨升级为全屏横扫。只有带着旧档回来才能走到这一步', true),
        ]),
    W('blade_zenith', '斩星剑', 'blade', 3, 3.30, 0.45, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏陨星轰击' }),
    W('blade_genesis', '创世刃', 'blade', 4, 7.00, 0.80, AttackModeId.FULL_SWEEP,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定】全屏横扫，铁剑一系的终点' }),

    // ============================================================ 短弓
    W('bow', '短弓', 'bow', 0, 0, 0, AttackModeId.SINGLE_RANGED,
        { aim: AimModeId.LOCK_ON, desc: '锁定一个目标持续追踪，无需自己瞄准' }, [
            up('bow_long', '长弓', '射程更远，单发更痛'),
            up('bow_rapid', '速射弓', '转为三连射，靠频率换伤害'),
        ]),
    W('bow_long', '长弓', 'bow', 1, 0.50, 0.20, AttackModeId.SINGLE_RANGED,
        { desc: '远程狙击路线' }, [up('bow_ballista', '攻城弩', '箭矢贯穿一条直线')]),
    W('bow_rapid', '速射弓', 'bow', 1, 0.35, 0.05, AttackModeId.TRIPLE_SHOT,
        { desc: '高频路线' }, [up('bow_crossbow', '连弩', '三连射强化，弹幕更密')]),
    W('bow_ballista', '攻城弩', 'bow', 2, 1.55, 0.35, AttackModeId.PIERCE,
        { desc: '贯穿直线' }, [up('bow_rain', '暴雨弩', '箭雨覆盖，锁定即全屏落下')]),
    W('bow_crossbow', '连弩', 'bow', 2, 1.40, 0.20, AttackModeId.TRIPLE_SHOT,
        { desc: '三连射强化' }, [up('bow_storm', '疾风弩', '疾风箭雨，频率极高')]),
    W('bow_rain', '暴雨弩', 'bow', 3, 2.80, 0.45, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏箭雨' }, [
            up('bow_apocalypse', '终末', '箭雨化为终末之光。只有带着旧档回来才能走到这一步', true),
        ]),
    W('bow_storm', '疾风弩', 'bow', 3, 2.70, 0.30, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏疾风箭雨' }),
    W('bow_apocalypse', '终末之弓', 'bow', 4, 6.50, 0.70, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定】全屏箭雨，短弓一系的终点' }),

    // ============================================================ 冰晶球
    W('orb', '冰晶球', 'orb', 0, 0, 0, AttackModeId.SINGLE_RANGED,
        { aim: AimModeId.NEAREST, desc: '自动攻击最近的敌人，解放双手' }, [
            up('orb_stream', '涌流', '单发伤害大幅提升'),
            up('orb_frost', '霜华', '转为冰霜震荡波，范围伤害'),
        ]),
    W('orb_stream', '涌流球', 'orb', 1, 0.70, 0.15, AttackModeId.SINGLE_RANGED,
        { desc: '单体强化' }, [up('orb_pierce', '穿透', '冰锥穿透一整排敌人')]),
    W('orb_frost', '霜华球', 'orb', 1, 0.55, 0.20, AttackModeId.SHOCKWAVE,
        { desc: '范围冰爆' }, [up('orb_glacier', '冰川', '冰爆范围大幅扩大')]),
    W('orb_pierce', '穿透球', 'orb', 2, 1.80, 0.25, AttackModeId.PIERCE,
        { desc: '贯穿冰锥' }, [up('orb_void', '虚空', '命中后弹射到附近敌人')]),
    W('orb_glacier', '冰川球', 'orb', 2, 1.70, 0.35, AttackModeId.SHOCKWAVE,
        { desc: '大范围冰爆' }, [up('orb_absolute', '绝对零度', '冰爆化为全屏冰陨')]),
    W('orb_void', '虚空球', 'orb', 3, 3.60, 0.40, AttackModeId.CHAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏连锁闪电' }, [
            up('orb_singularity', '奇点', '连锁化为奇点撕裂。只有带着旧档回来才能走到这一步', true),
        ]),
    W('orb_absolute', '绝对零度', 'orb', 3, 3.50, 0.40, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏冰陨轰击' }),
    W('orb_singularity', '奇点', 'orb', 4, 7.00, 0.60, AttackModeId.CHAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定】全屏连锁，冰晶球一系的终点' }),

    // ============================================================ 长枪
    W('spear', '长枪', 'spear', 0, 0, 0, AttackModeId.PIERCE,
        { aim: AimModeId.FRONT, desc: '前向贯穿直线。敌人排成一列时一枪串起整排' }, [
            up('spear_long', '龙胆', '贯穿距离与伤害提升'),
            up('spear_halberd', '破军', '转为大范围横扫'),
        ]),
    W('spear_long', '龙胆枪', 'spear', 1, 0.55, 0.20, AttackModeId.PIERCE,
        { desc: '贯穿强化' }, [up('spear_dragon', '贯日', '贯穿力大幅提升')]),
    W('spear_halberd', '破军戟', 'spear', 1, 0.50, 0.15, AttackModeId.SWEEP,
        { desc: '横扫路线' }, [up('spear_reaper', '肃清', '横扫化为震荡冲击')]),
    W('spear_dragon', '贯日枪', 'spear', 2, 1.65, 0.35, AttackModeId.PIERCE,
        { desc: '长距贯穿' }, [up('spear_heaven', '天贯', '枪影从天而降，全屏贯穿')]),
    W('spear_reaper', '肃清戟', 'spear', 2, 1.55, 0.25, AttackModeId.SHOCKWAVE,
        { desc: '冲击震荡' }, [up('spear_dominion', '镇狱', '震荡化为陨落打击')]),
    W('spear_heaven', '天贯', 'spear', 3, 3.00, 0.50, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏枪雨' }),
    W('spear_dominion', '镇狱', 'spear', 3, 2.90, 0.40, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏陨落' }),

    // ============================================================ 铁锤
    W('hammer', '铁锤', 'hammer', 0, 0, 0, AttackModeId.SINGLE_MELEE,
        { aim: AimModeId.MOVE_DIR, desc: '朝你拖动的方向砸出震荡波，走哪打哪' }, [
            up('hammer_heavy', '重锤', '单体重击，砸谁谁死'),
            up('hammer_wide', '阔锤', '转为震荡波，范围杀伤'),
        ]),
    W('hammer_heavy', '重锤', 'hammer', 1, 0.55, 0.05, AttackModeId.SINGLE_MELEE,
        { desc: '单体重击' }, [up('hammer_quake', '震地', '重击落地形成震荡波')]),
    W('hammer_wide', '阔锤', 'hammer', 1, 0.45, 0.20, AttackModeId.SHOCKWAVE,
        { desc: '范围震荡' }, [up('hammer_tremor', '裂地', '震荡扩散为大范围横扫')]),
    W('hammer_quake', '震地锤', 'hammer', 2, 1.70, 0.15, AttackModeId.SHOCKWAVE,
        { desc: '震荡波强化' }, [up('hammer_meteor', '陨星', '震荡化为天降陨星')]),
    W('hammer_tremor', '裂地锤', 'hammer', 2, 1.60, 0.30, AttackModeId.SWEEP,
        { desc: '大范围横扫' }, [up('hammer_cataclysm', '崩地', '横扫化为全屏崩裂')]),
    W('hammer_meteor', '陨星锤', 'hammer', 3, 3.40, 0.30, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏陨石' }),
    W('hammer_cataclysm', '崩地锤', 'hammer', 3, 3.30, 0.40, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏崩裂' }),

    // ============================================================ 飞刃
    W('dagger', '飞刃', 'dagger', 0, 0, 0, AttackModeId.TRIPLE_SHOT,
        { aim: AimModeId.MOVE_DIR, desc: '极快攻速的移动向三连射，边走边泼' }, [
            up('dagger_swift', '流光', '三连射强化，频率更高'),
            up('dagger_venom', '毒牙', '转为单发剧毒刃，单体爆发'),
        ]),
    W('dagger_swift', '流光刃', 'dagger', 1, 0.60, 0, AttackModeId.TRIPLE_SHOT,
        { desc: '高频三连' }, [up('dagger_gale', '疾风', '三连射化为高速刃风')]),
    W('dagger_venom', '毒牙刃', 'dagger', 1, 0.75, 0.10, AttackModeId.SINGLE_RANGED,
        { desc: '剧毒单体' }, [up('dagger_plague', '瘟疫', '毒素扩散到附近敌人')]),
    W('dagger_gale', '疾风刃', 'dagger', 2, 1.75, 0.10, AttackModeId.TRIPLE_SHOT,
        { desc: '高速刃风' }, [up('dagger_barrage', '刃暴', '升华为全屏刃雨')]),
    W('dagger_plague', '瘟疫刃', 'dagger', 2, 1.65, 0.20, AttackModeId.CHAIN,
        { desc: '毒素连锁' }, [up('dagger_ruin', '蚀灭', '毒素化为全屏腐蚀陨落')]),
    W('dagger_barrage', '刃暴', 'dagger', 3, 3.10, 0.25, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏刃雨' }),
    W('dagger_ruin', '蚀灭', 'dagger', 3, 3.00, 0.30, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏腐蚀' }),

    // ============================================================ 雷杖
    W('staff', '雷杖', 'staff', 0, 0, 0, AttackModeId.SINGLE_RANGED,
        { aim: AimModeId.NEAREST, desc: '自动锁最密集处导电。敌人越扎堆越强' }, [
            up('staff_chain', '引雷', '转为连锁闪电，越密集收益越高'),
            up('staff_burst', '爆雷', '转为雷爆，范围杀伤'),
        ]),
    W('staff_chain', '引雷杖', 'staff', 1, 0.65, 0.15, AttackModeId.CHAIN,
        { desc: '连锁强化' }, [up('staff_storm', '雷暴', '连锁跳数大幅增加')]),
    W('staff_burst', '爆雷杖', 'staff', 1, 0.60, 0.10, AttackModeId.SHOCKWAVE,
        { desc: '雷爆范围' }, [up('staff_thunder', '惊蛰', '雷爆范围与伤害大幅提升')]),
    W('staff_storm', '雷暴杖', 'staff', 2, 1.85, 0.25, AttackModeId.CHAIN,
        { desc: '大范围连锁' }, [up('staff_judgment', '天罚雷', '连锁化为全屏雷击')]),
    W('staff_thunder', '惊蛰杖', 'staff', 2, 1.75, 0.30, AttackModeId.SHOCKWAVE,
        { desc: '大范围雷爆' }, [up('staff_ragnarok', '诸神黄昏', '雷爆化为全屏陨雷')]),
    W('staff_judgment', '天罚雷', 'staff', 3, 3.70, 0.40, AttackModeId.CHAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏连锁雷击' }),
    W('staff_ragnarok', '诸神黄昏', 'staff', 3, 3.60, 0.35, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏陨雷' }),

    // ============================================================ 巨镰
    W('scythe', '巨镰', 'scythe', 0, 0, 0, AttackModeId.SWEEP,
        { aim: AimModeId.FRONT, desc: '前向大扇形横扫。被围住时一刀清一圈' }, [
            up('scythe_great', '巨斩', '扇形范围与伤害提升'),
            up('scythe_whirl', '旋风', '转为环身漩涡，四面都打得到'),
        ]),
    W('scythe_great', '巨斩镰', 'scythe', 1, 0.60, 0.15, AttackModeId.SWEEP,
        { desc: '大扇形强化' }, [up('scythe_death', '死亡', '扇形扩展为死亡领域')]),
    W('scythe_whirl', '旋风镰', 'scythe', 1, 0.50, 0.25, AttackModeId.SHOCKWAVE,
        { desc: '环身漩涡' }, [up('scythe_vortex', '涡旋', '漩涡范围与吸力提升')]),
    W('scythe_death', '死亡镰', 'scythe', 2, 1.75, 0.30, AttackModeId.SWEEP,
        { desc: '死亡领域' }, [up('scythe_harvest', '收割', '领域内落下全屏镰雨')]),
    W('scythe_vortex', '涡旋镰', 'scythe', 2, 1.65, 0.35, AttackModeId.SHOCKWAVE,
        { desc: '大漩涡' }, [up('scythe_maelstrom', '大漩涡', '漩涡化为全屏陨落')]),
    W('scythe_harvest', '收割', 'scythe', 3, 3.20, 0.45, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏镰雨' }, [
            up('scythe_eternity', '永劫', '镰雨化为永劫轮回。只有带着旧档回来才能走到这一步', true),
        ]),
    W('scythe_maelstrom', '大漩涡', 'scythe', 3, 3.10, 0.45, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏陨落' }),
    W('scythe_eternity', '永劫镰', 'scythe', 4, 6.80, 0.70, AttackModeId.FULL_SWEEP,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定】全屏横扫，巨镰一系的终点' }),

    // ============================================================ 重炮
    W('cannon', '重炮', 'cannon', 0, 0, 0, AttackModeId.SINGLE_RANGED,
        { aim: AimModeId.LOCK_ON, desc: '锁定后砸下范围爆炸。射速极慢，一发要打准位置' }, [
            up('cannon_heavy', '重炮改', '单发爆炸伤害大幅提升'),
            up('cannon_scatter', '散花', '转为多段散射，覆盖面更广'),
        ]),
    W('cannon_heavy', '重炮改', 'cannon', 1, 0.70, 0.15, AttackModeId.SINGLE_RANGED,
        { desc: '单发强化' }, [up('cannon_siege', '攻城', '炮弹升级为范围轰炸')]),
    W('cannon_scatter', '散花炮', 'cannon', 1, 0.55, 0.10, AttackModeId.TRIPLE_SHOT,
        { desc: '多段散射' }, [up('cannon_cluster', '集束', '散射升级为集束覆盖')]),
    W('cannon_siege', '攻城炮', 'cannon', 2, 1.90, 0.30, AttackModeId.METEOR,
        { desc: '范围轰炸' }, [up('cannon_doom', '灭世', '轰炸升级为全屏灭世')]),
    W('cannon_cluster', '集束炮', 'cannon', 2, 1.75, 0.25, AttackModeId.RAIN,
        { desc: '集束覆盖' }, [up('cannon_swarm', '蜂群', '集束升级为全屏蜂群')]),
    W('cannon_doom', '灭世炮', 'cannon', 3, 3.80, 0.40, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏灭世' }),
    W('cannon_swarm', '蜂群炮', 'cannon', 3, 3.60, 0.35, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏蜂群' }),

    // ============================================================ 手里剑
    W('shuriken', '手里剑', 'shuriken', 0, 0, 0, AttackModeId.TRIPLE_SHOT,
        { aim: AimModeId.MOVE_DIR, desc: '朝移动方向撒出弹幕，跑动中铺满全场' }, [
            up('shuriken_gale', '疾风', '三连射强化，撒得更密'),
            up('shuriken_shadow', '影', '转为单发高伤暗影刃'),
        ]),
    W('shuriken_gale', '疾风手里剑', 'shuriken', 1, 0.55, 0, AttackModeId.TRIPLE_SHOT,
        { desc: '密集弹幕' }, [up('shuriken_storm', '岚', '弹幕升华为全屏撒网')]),
    W('shuriken_shadow', '影手里剑', 'shuriken', 1, 0.70, 0.15, AttackModeId.SINGLE_RANGED,
        { desc: '暗影单体' }, [up('shuriken_eclipse', '蚀影', '暗影扩散为连锁蚀灭')]),
    W('shuriken_storm', '岚', 'shuriken', 2, 1.70, 0.20, AttackModeId.RAIN,
        { desc: '全屏撒网' }, [up('shuriken_myriad', '万刃', '刃数翻倍，全屏覆盖')]),
    W('shuriken_eclipse', '蚀影', 'shuriken', 2, 1.65, 0.15, AttackModeId.CHAIN,
        { desc: '连锁蚀灭' }, [up('shuriken_void', '虚刃', '蚀灭升华为全屏虚空刃雨')]),
    W('shuriken_myriad', '万刃', 'shuriken', 3, 3.30, 0.30, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏万刃' }),
    W('shuriken_void', '虚刃', 'shuriken', 3, 3.20, 0.35, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏虚空刃雨' }),

    // ============================================================ 光矛
    W('lance', '光矛', 'lance', 0, 0, 0, AttackModeId.PIERCE,
        { aim: AimModeId.LOCK_ON, desc: '锁定目标后贯穿一条线，后排也会被串到' }, [
            up('lance_light', '圣光', '贯穿伤害与射程提升'),
            up('lance_burst', '爆裂', '转为定点爆发，命中即炸'),
        ]),
    W('lance_light', '圣光矛', 'lance', 1, 0.65, 0.20, AttackModeId.PIERCE,
        { desc: '贯穿强化' }, [up('lance_radiant', '辉耀', '贯穿化为辉耀光束')]),
    W('lance_burst', '爆裂矛', 'lance', 1, 0.60, 0.15, AttackModeId.SHOCKWAVE,
        { desc: '定点爆发' }, [up('lance_sunburst', '烈阳', '爆发化为烈阳冲击')]),
    W('lance_radiant', '辉耀矛', 'lance', 2, 1.80, 0.35, AttackModeId.PIERCE,
        { desc: '辉耀光束' }, [up('lance_zenith', '天穹', '光束升华为全屏天穹之光')]),
    W('lance_sunburst', '烈阳矛', 'lance', 2, 1.70, 0.30, AttackModeId.SHOCKWAVE,
        { desc: '烈阳冲击' }, [up('lance_supernova', '超新星', '冲击升华为全屏超新星')]),
    W('lance_zenith', '天穹之光', 'lance', 3, 3.60, 0.50, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏天穹之光' }, [
            up('lance_apex', '极光', '光束化为极光审判。只有带着旧档回来才能走到这一步', true),
        ]),
    W('lance_supernova', '超新星', 'lance', 3, 3.50, 0.40, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '全屏超新星' }),
    W('lance_apex', '极光矛', 'lance', 4, 6.90, 0.70, AttackModeId.PIERCE,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定】全屏极光审判，光矛一系的终点' }),

    // ============================================================ 回旋轮
    W('wheel', '回旋轮', 'wheel', 0, 0, 0, AttackModeId.FULL_SWEEP,
        { aim: AimModeId.SCREEN_ROLL, desc: '滚轮横扫整个战场，完全不需要瞄准' }, [
            up('wheel_rift', '裂空', '全屏伤害大幅提升'),
            up('wheel_spike', '刺轮', '加装刺刃，横扫范围更广'),
        ]),
    W('wheel_rift', '裂空轮', 'wheel', 1, 0.60, 0.15, AttackModeId.FULL_SWEEP,
        { desc: '全屏伤害强化' }, [up('wheel_storm', '磁暴', '加装磁暴场，横扫更强')]),
    W('wheel_spike', '刺轮', 'wheel', 1, 0.50, 0.10, AttackModeId.FULL_SWEEP,
        { desc: '范围强化' }, [up('wheel_saw', '锯轮', '锯刃高速旋转，范围与频率齐升')]),
    W('wheel_storm', '磁暴轮', 'wheel', 2, 1.70, 0.30, AttackModeId.FULL_SWEEP,
        { desc: '磁暴横扫' }, [up('wheel_sky', '天轮', '横扫升华为天轮碾压')]),
    W('wheel_saw', '锯轮', 'wheel', 2, 1.60, 0.25, AttackModeId.FULL_SWEEP,
        { desc: '锯刃横扫' }, [up('wheel_annihilate', '湮灭', '锯刃升华为湮灭之轮')]),
    W('wheel_sky', '天轮', 'wheel', 3, 3.50, 0.50, AttackModeId.FULL_SWEEP,
        { desc: '全屏天轮' }, [
            up('wheel_perpetual', '永动', '天轮化为永动机。只有带着旧档回来才能走到这一步', true),
        ]),
    W('wheel_annihilate', '湮灭轮', 'wheel', 3, 3.40, 0.45, AttackModeId.FULL_SWEEP,
        { desc: '全屏湮灭' }),
    W('wheel_perpetual', '永动轮', 'wheel', 4, 7.10, 0.70, AttackModeId.FULL_SWEEP,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定】全屏永动碾压，回旋轮一系的终点' }),

    // ============================================================ 合成产物
    // 合成形态不属于任何一条武器线，只能通过 FUSION_RECIPES 得到。
    W('fus_swordstorm', '剑雨风暴', 'blade', 3, 5.20, 0.60, AttackModeId.RAIN,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【合成】裂空剑 × 暴雨弩。两把武器的局外伤害汇成一份' }),
    W('fus_singularity', '湮灭奇点', 'orb', 3, 5.40, 0.55, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【合成】震地锤 × 虚空球。范围与连锁的合体' }),
    W('fus_galecircle', '风神环', 'wheel', 3, 5.30, 0.65, AttackModeId.FULL_SWEEP,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【合成】磁暴轮 × 贯日枪。全屏横扫加贯穿' }),
    W('fus_tempest', '万象风暴', 'staff', 3, 5.50, 0.50, AttackModeId.CHAIN,
        { aim: AimModeId.NEAREST, desc: '【合成】雷暴杖 × 死亡镰。连锁与扇形的合体' }),
    W('fus_bladehell', '刃狱', 'shuriken', 3, 5.00, 0.55, AttackModeId.RAIN,
        { aim: AimModeId.MOVE_DIR, desc: '【合成】疾风刃 × 岚。朝哪跑，刃狱就铺到哪' }),
    W('fus_starfall', '星坠', 'cannon', 3, 5.60, 0.60, AttackModeId.METEOR,
        { aim: AimModeId.LOCK_ON, desc: '【合成】攻城炮 × 辉耀矛。锁定即从天而降' }),
    W('fus_genesis', '创世', 'blade', 4, 12.00, 0.85, AttackModeId.METEOR,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定·合成】剑雨风暴 × 湮灭奇点。四把武器的基础伤害集于一格' }),
    W('fus_eternal', '永恒', 'wheel', 4, 12.50, 0.90, AttackModeId.FULL_SWEEP,
        { aim: TOTAL_SWEEP, aimText: TOTAL_TEXT, desc: '【复玩限定·合成】风神环 × 万象风暴。四把武器的基础伤害集于一格' }),

    // ============================================================ 第八轮：高阶专属武器
    //
    // 这 6 把是**直接以高品阶出生**的专属武器，不走"从青铜爬上来"那条路。
    //
    // 【为什么它们没有进化线】
    //   常规武器的强度来自"局内形态深度"（depth 0→4 一条长线），
    //   而专属武器的强度来自**品阶倍率 + 自带复合属性 + 镶嵌槽**。
    //   再给它们一条进化线会让 build 出现第三条成长轴，
    //   玩家要同时管形态、品阶、镶嵌三件事 —— 那是复杂度堆叠，不是深度。
    //   所以它们是"抽到即完全体"，成长全部发生在局外（升级 / 升阶 / 镶属性）。
    //
    // 【为什么 attackMode 复用已有形状】
    //   打击形状只有十种，新增形状要改战斗层。高阶武器的差异化
    //   应该体现在**数值与属性**上，而不是再引入第十一种攻击方式。
    //   所以它们复用现有形状，靠品阶倍率与自带属性拉开差距。

    // ---- 钻石 ----
    W('star_blade', '星刃', 'blade', 0, 0.55, 0.15, AttackModeId.SINGLE_MELEE, {
        aim: AimModeId.FRONT, desc: '【钻石】光与剑的双生之刃，出鞘即带破甲之势',
        rarity: 3,
        innate: { elements: ['light', 'sword'], bonus: { atkPct: 0.12, pierceResist: 0.10 } },
    }),
    W('frost_lance', '霜寒枪', 'spear', 0, 0.50, 0.20, AttackModeId.PIERCE, {
        aim: AimModeId.FRONT, desc: '【钻石】冰与水凝成的长枪，贯穿之处尽数冻结',
        rarity: 3,
        innate: { elements: ['ice', 'water'], bonus: { atkPct: 0.10, rangePct: 0.12 } },
    }),

    // ---- 史诗 ----
    W('storm_bow', '疾风弓', 'bow', 0, 0.60, 0.25, AttackModeId.TRIPLE_SHOT, {
        aim: AimModeId.LOCK_ON, desc: '【史诗】风与翼的合奏，三连箭自带追踪',
        rarity: 4,
        innate: { elements: ['wind', 'flying'], bonus: { atkPct: 0.14, atkSpeedPct: 0.12 } },
    }),
    W('quake_hammer', '震地锤', 'hammer', 0, 0.65, 0.10, AttackModeId.SHOCKWAVE, {
        aim: AimModeId.MOVE_DIR, desc: '【史诗】土与石的怒号，每一锤都让地面裂开',
        rarity: 4,
        innate: { elements: ['earth', 'stone'], bonus: { atkPct: 0.16, highHpDmg: 0.12 } },
    }),

    // ---- 神话 ----
    W('void_cannon', '虚空炮', 'cannon', 0, 0.70, 0.15, AttackModeId.METEOR, {
        aim: AimModeId.LOCK_ON, desc: '【神话】幽与空间的造物，炮口连着另一个次元',
        rarity: 5,
        innate: { elements: ['ghost', 'space'], bonus: { atkPct: 0.20, extraShots: 1 } },
    }),
    W('radiant_wheel', '曜日轮', 'wheel', 0, 0.60, 0.30, AttackModeId.FULL_SWEEP, {
        aim: AimModeId.SCREEN_ROLL, desc: '【神话】光与火的日轮，滚过之处再无站立之地',
        rarity: 5,
        innate: { elements: ['light', 'fire'], bonus: { atkPct: 0.18, critRate: 0.08 } },
    }),
];

// ====================================================================
// 合成配方表
// ====================================================================

/**
 * 8 条合成配方，其中 2 条是复玩限定。
 *
 * 材料都选在 depth ≥ 2 的形态上 —— 也就是说玩家必须先各自进化两轮，
 * 才有资格合成。这让合成成为"一局后半段的目标"，而不是开局就有的捷径。
 */
export const FUSION_RECIPES: FusionRecipe[] = [
    {
        a: 'blade_rift', b: 'bow_rain', to: 'fus_swordstorm',
        label: '剑雨风暴', desc: '裂空剑 + 暴雨弩 → 全屏剑雨，两把武器的基础伤害合并',
    },
    {
        a: 'hammer_quake', b: 'orb_void', to: 'fus_singularity',
        label: '湮灭奇点', desc: '震地锤 + 虚空球 → 全屏陨落，范围与连锁合体',
    },
    {
        a: 'wheel_storm', b: 'spear_dragon', to: 'fus_galecircle',
        label: '风神环', desc: '磁暴轮 + 贯日枪 → 全屏横扫加贯穿',
    },
    {
        a: 'staff_storm', b: 'scythe_death', to: 'fus_tempest',
        label: '万象风暴', desc: '雷暴杖 + 死亡镰 → 自动瞄准的大范围连锁',
    },
    {
        a: 'dagger_gale', b: 'shuriken_storm', to: 'fus_bladehell',
        label: '刃狱', desc: '疾风刃 + 岚 → 朝移动方向铺满刃雨',
    },
    {
        a: 'cannon_siege', b: 'lance_radiant', to: 'fus_starfall',
        label: '星坠', desc: '攻城炮 + 辉耀矛 → 锁定后从天而降',
    },
    {
        a: 'fus_swordstorm', b: 'fus_singularity', to: 'fus_genesis',
        label: '创世', desc: '剑雨风暴 + 湮灭奇点 → 四把武器的基础伤害集于一格', advanced: true,
    },
    {
        a: 'fus_galecircle', b: 'fus_tempest', to: 'fus_eternal',
        label: '永恒', desc: '风神环 + 万象风暴 → 四把武器的基础伤害集于一格', advanced: true,
    },
];

// ====================================================================
// 图构建与索引
// ====================================================================

const FORM_MAP: Record<string, FormNode> = {};
const ROOT_OF: Record<string, string> = {};

function registerForm(f: FormNode): void {
    if (FORM_MAP[f.id]) {
        throw new Error('[FormConfig] 形态 id 重复：' + f.id);
    }
    FORM_MAP[f.id] = f;
}

function buildGraph(): void {
    for (const f of WEAPON_FORMS) registerForm(f);
    for (const f of AUX_FORMS) registerForm(f);

    // 1. 根形态：sources = [自己]；武器线的所有升级后代继承同一份 sources
    //    辅助装备没有局外等级，sources 保持为空 —— 它们不贡献基础伤害
    const setSources = (rootId: string, next: string[]): void => {
        const f = FORM_MAP[rootId];
        if (!f) return;
        if (f.kind === 'aux') {
            f.sources = [];
        } else if (f.sources.length === 0) {
            f.sources = next;
        }
        for (const e of f.evolveTo) {
            if (e.type !== 'upgrade') continue;
            ROOT_OF[e.to] = ROOT_OF[rootId] || rootId;
            setSources(e.to, f.sources);
        }
    };
    for (const id of WEAPON_ROOT_IDS.concat(AUX_ROOT_IDS)) {
        ROOT_OF[id] = id;
        setSources(id, [id]);
    }

    // 2. 合成产物：sources = 两份材料 sources 的并集
    //    迭代到稳定 —— 高级合成（创世/永恒）的材料本身也是合成产物，
    //    所以需要多跑几轮才能把它们的基础伤害凑齐。
    for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const r of FUSION_RECIPES) {
            const target = FORM_MAP[r.to];
            const fa = FORM_MAP[r.a];
            const fb = FORM_MAP[r.b];
            if (!target || !fa || !fb) continue;
            if (fa.sources.length === 0 || fb.sources.length === 0) continue;
            const merged: string[] = fa.sources.slice();
            for (const s of fb.sources) {
                if (merged.indexOf(s) < 0) merged.push(s);
            }
            if (merged.length !== target.sources.length) {
                target.sources = merged;
                changed = true;
            }
        }
        if (!changed) break;
    }

    // 3. 把合成配方镜像成两条 fusion 进化边，让图鉴从任意一件材料都能看到配方
    for (const r of FUSION_RECIPES) {
        const fa = FORM_MAP[r.a];
        const fb = FORM_MAP[r.b];
        if (fa) {
            fa.evolveTo.push({
                to: r.to, type: 'fusion', need: r.b,
                label: r.label, desc: r.desc, advanced: r.advanced,
            });
        }
        if (fb) {
            fb.evolveTo.push({
                to: r.to, type: 'fusion', need: r.a,
                label: r.label, desc: r.desc, advanced: r.advanced,
            });
        }
    }
}

buildGraph();

/** 全部形态（武器 + 辅助） */
export const ALL_FORMS: FormNode[] = Object.keys(FORM_MAP).map((k) => FORM_MAP[k]);

// ====================================================================
// 查询接口
// ====================================================================

/** 取形态，不存在返回 null */
export function getForm(id: string): FormNode | null {
    return FORM_MAP[id] || null;
}

/** 取形态，不存在时抛错 —— 配置错误应该在开发期就炸出来 */
export function requireForm(id: string): FormNode {
    const f = FORM_MAP[id];
    if (!f) throw new Error('[FormConfig] 未知形态 id：' + id);
    return f;
}

/** 某形态所属的根形态 id（这条线的起点）。合成形态返回它自己 */
export function getRootOf(id: string): string {
    return ROOT_OF[id] || id;
}

/** 某个根形态（= 局外装备 id）的根节点 */
export function getRootForm(equipId: string): FormNode | null {
    return FORM_MAP[equipId] || null;
}

/** 按槽位种类取全部根形态 id */
export function getRootIds(kind: 'weapon' | 'aux'): string[] {
    return kind === 'weapon' ? WEAPON_ROOT_IDS.slice() : AUX_ROOT_IDS.slice();
}

/** 某个形态是否是根形态 */
export function isRootForm(id: string): boolean {
    return WEAPON_ROOT_IDS.indexOf(id) >= 0 || AUX_ROOT_IDS.indexOf(id) >= 0;
}

/**
 * 取某形态在给定条件下**可选的进化边**。
 *
 * @param allowAdvanced 是否允许出现"更上级进化"。
 *                      调用方传"本局是否携带老档"—— 这是复玩的核心回报之一。
 */
export function getEvolveOptions(formId: string, allowAdvanced: boolean): EvolutionEdge[] {
    const f = FORM_MAP[formId];
    if (!f) return [];
    const out: EvolutionEdge[] = [];
    for (const e of f.evolveTo) {
        if (e.advanced && !allowAdvanced) continue;
        out.push(e);
    }
    return out;
}

/**
 * 全部进化边（含 advanced），用于图鉴展示 —— 图鉴要让玩家**看到**
 * 还有哪些路线没解锁，所以不能过滤掉。
 */
export function getAllEdges(formId: string): EvolutionEdge[] {
    const f = FORM_MAP[formId];
    return f ? f.evolveTo.slice() : [];
}

/** 找出所有能产出该形态的合成配方（图鉴里"如何得到"用） */
export function getRecipesFor(formId: string): FusionRecipe[] {
    return FUSION_RECIPES.filter((r) => r.to === formId);
}

/** 该形态是否只能通过合成得到 */
export function isFusionOnly(formId: string): boolean {
    return getRecipesFor(formId).length > 0 && ROOT_OF[formId] === undefined;
}

/** 某个形态等级需要多少累计经验 */
export function formLvExp(lv: number): number {
    const idx = Math.max(0, Math.min(FORM_LV_EXP.length - 1, lv - 1));
    return FORM_LV_EXP[idx];
}

/** 由累计经验推出形态等级（1 ~ FORM_MAX_LV） */
export function formLevelOf(exp: number): number {
    let lv = 1;
    for (let i = 0; i < FORM_LV_EXP.length; i++) {
        if (exp >= FORM_LV_EXP[i]) lv = i + 1;
    }
    return Math.min(FORM_MAX_LV, lv);
}

/** 形态等级是否已满（满级才可进化） */
export function isFormLvMax(exp: number): boolean {
    return formLevelOf(exp) >= FORM_MAX_LV;
}

/** 某 depth 进化所需的经验门槛 */
export function depthExpNeed(depth: number): number {
    const idx = Math.max(0, Math.min(DEPTH_EXP_NEED.length - 1, depth));
    return DEPTH_EXP_NEED[idx];
}

/**
 * v2 老档案迁移用：(装备 id, 旧 stage) → 新的 formId。
 *
 * 依赖"evolveTo 数组第一项是主线"这个约定，沿主线走 stage 步。
 */
export function legacyFormId(equipId: string, stage: number): string {
    let cur = equipId;
    for (let i = 0; i < stage; i++) {
        const f = FORM_MAP[cur];
        if (!f) break;
        const main = f.evolveTo.filter((e) => e.type === 'upgrade')[0];
        if (!main) break;
        cur = main.to;
    }
    return cur;
}

/** 形态的展示名（带所属武器线，便于 UI 分组） */
export function formLabel(id: string): string {
    const f = FORM_MAP[id];
    if (!f) return id;
    if (isRootForm(id)) return f.name;
    const root = ROOT_OF[id];
    const rf = root ? FORM_MAP[root] : null;
    return (rf ? rf.name + ' · ' : '') + f.name;
}

// ====================================================================
// 配置自检 —— 由测试调用，把配置错误挡在运行之前
// ====================================================================

/**
 * 校验形态图的完整性。
 *
 * 这些错误如果不在启动期发现，就会变成玩家侧的表现：
 * 三选一里点了一张卡却什么都没发生、合成之后形态不见了、图鉴里有个问号点不开。
 * 所以宁可让它在这里抛出来。
 *
 * 【2026-10-16 重构为可测试】
 *   原实现直接读模块级的 `FORM_MAP` / `FUSION_RECIPES`，测试无法注入"坏配置"，
 *   只能验证"当前配置是对的"—— 那样测不出校验逻辑本身有没有用。
 *   现在拆成两层：
 *     `validateFormGraphData(forms, recipes, weaponRoots, auxRoots)` 纯函数，接收数据
 *     `validateFormGraph()` 保持原签名与行为，读全局数据后调它
 *   生产代码行为完全不变，测试则可以拿各种畸形数据喂进去。
 */
export function validateFormGraph(): string[] {
    return validateFormGraphData(
        ALL_FORMS, FUSION_RECIPES, WEAPON_ROOT_IDS, AUX_ROOT_IDS);
}

/**
 * 校验形态图（纯函数版，见上方说明为什么拆出来）。
 *
 * @param forms       全部形态节点（含武器与辅助）
 * @param recipes     合成配方
 * @param weaponRoots 武器根形态 id 列表
 * @param auxRoots    辅助根形态 id 列表
 * @returns 错误描述数组，**空数组代表通过**
 */
export function validateFormGraphData(
    forms: FormNode[],
    recipes: FusionRecipe[],
    weaponRoots: string[],
    auxRoots: string[]
): string[] {
    const errors: string[] = [];

    /** id → 节点。刻意重建映射而不是复用模块级的 FORM_MAP，保证只校验传入的数据 */
    const map: Record<string, FormNode> = {};
    for (const f of forms) map[f.id] = f;
    for (const f of forms) {
        if (f.sources.length === 0 && f.kind === 'weapon') {
            errors.push('武器形态缺少 sources：' + f.id);
        }
        if (f.kind === 'weapon' && f.equipType === 'aux') {
            errors.push('武器形态的 equipType 不能是 aux：' + f.id);
        }
        if (f.kind === 'aux' && f.equipType !== 'aux') {
            errors.push('辅助形态的 equipType 必须是 aux：' + f.id);
        }

        for (const e of f.evolveTo) {
            const target = map[e.to];
            if (!target) {
                errors.push('进化边指向不存在的形态：' + f.id + ' → ' + e.to);
                continue;
            }
            if (target.kind !== f.kind) {
                errors.push('进化边跨越了槽位种类：' + f.id + ' → ' + e.to);
            }
            /**
             * 层级检查分两种，因为 upgrade 与 fusion 的语义本来就不同：
             *
             *   upgrade  同一槽位往下走一层 → **必须**严格加深
             *   fusion   两条武器线并成一条  → 是"换路线"而不是"下一层"，
             *            所以只要求产物不比任一材料浅
             *
             * 双武器合成的产物与单线终局同层（都是 3），这是刻意的：
             * 它俩是同层级的两种收束方式（合并伤害 vs 极端单项），
             * 谁都不比谁高一级；真正更高的第 4 层留给复玩限定的
             * "更上级进化"与"四武器合一"，那样第 4 层才始终意味着"老档专属"。
             */
            if (e.type === 'fusion') {
                if (target.depth < f.depth) {
                    errors.push('合成产物的层级低于材料：' + f.id + '(' + f.depth +
                        ') → ' + e.to + '(' + target.depth + ')');
                }
            } else if (target.depth <= f.depth) {
                errors.push('进化边没有加深层级：' + f.id + '(' + f.depth + ') → ' +
                    e.to + '(' + target.depth + ')');
            }
            if (e.type === 'fusion') {
                if (!e.need) {
                    errors.push('合成边缺少 need：' + f.id + ' → ' + e.to);
                } else if (!map[e.need]) {
                    errors.push('合成边材料不存在：' + f.id + ' → ' + e.to + ' 需要 ' + e.need);
                }
                if (f.kind !== 'weapon') {
                    errors.push('辅助装备不允许合成进化（会消耗槽位）：' + f.id);
                }
            }
            if (e.advanced && f.depth < 2) {
                errors.push('高级进化不应该出现在 depth < 2 的形态上：' + f.id);
            }
        }

        // 辅助装备的铁律：任何进化都不能消耗槽位
        if (f.kind === 'aux') {
            for (const e of f.evolveTo) {
                if (e.type !== 'upgrade') {
                    errors.push('辅助装备只能走 upgrade 进化：' + f.id + ' → ' + e.to);
                }
            }
        }
    }

    for (const r of recipes) {
        if (!map[r.a]) errors.push('合成配方材料 A 不存在：' + r.a);
        if (!map[r.b]) errors.push('合成配方材料 B 不存在：' + r.b);
        const t = map[r.to];
        if (!t) {
            errors.push('合成产物不存在：' + r.to);
            continue;
        }
        if (t.kind !== 'weapon') errors.push('合成产物必须是武器：' + r.to);
        if (r.a === r.b) errors.push('合成配方两件材料重复：' + r.a);
        if (t.sources.length === 0) errors.push('合成产物没有继承基础伤害：' + r.to);

        // 合成必须是"变强"：产物层级不低于材料，攻击加成高于二者。
        // 光靠边上的深度检查不够 —— 那样只保证不比 A 浅，
        // 会出现"合完之后比 B 还弱"的配置，玩家会觉得被坑了一格。
        const fa = map[r.a];
        const fb = map[r.b];
        if (fa && fb) {
            if (t.depth < Math.max(fa.depth, fb.depth)) {
                errors.push('合成产物层级低于材料：' + r.to);
            }
            if (t.atkPct <= Math.max(fa.atkPct, fb.atkPct)) {
                errors.push('合成产物的攻击加成不高于材料（合完反而更弱）：' + r.to);
            }
        }
    }

    // 每把武器的根形态必须存在
    for (const id of weaponRoots) {
        const f = map[id];
        if (!f) {
            errors.push('武器根形态缺失：' + id);
            continue;
        }
        if (f.depth !== 0) errors.push('武器根形态 depth 必须为 0：' + id);
    }
    for (const id of auxRoots) {
        const f = map[id];
        if (!f) errors.push('辅助根形态缺失：' + id);
    }

    return errors;
}
