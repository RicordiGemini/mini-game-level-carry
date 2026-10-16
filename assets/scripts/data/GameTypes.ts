/**
 * 全局数据类型定义
 *
 * 【存档分层】
 *
 *   PlayerProfile（全局永久）—— 解锁进度、永久货币 gold、装备的局外等级
 *     局外等级是永久投资，不随关卡重置消失，也不需要看广告。
 *
 *   LevelArchive（关卡 × 难度 档案）—— 通关时的完整快照
 *     键 = (levelId, difficulty)。包含装备的「局内进化阶段」。
 *
 *   LevelState（单局运行态）—— 本次开局的实时数据
 *
 * 【难度体系】
 *   每一关都有 3 档难度（普通 / 困难 / 噩梦），互相独立：
 *     - 同一关通关难度 N 后解锁该关的难度 N+1
 *     - 难度越高，敌人血量 / 攻击 / 速度 / 数量越高，远程怪比例越大
 *     - 首次进入更高难度时**默认免费继承**低难度通关时的装备（无需广告）
 *     - 难度本身还驱动全局解锁：出战槽位数量、新装备的开放
 *
 * 【装备双轨成长】
 *   局外：装备等级 → 基础伤害（flat，永久生效，不需要继承）
 *   局内：装备进化 → 攻击百分比 / 攻击距离 / 攻击方式（只在本局内产生，随档案封存）
 *
 * 【第三轮重构：进化链 → 形态图】
 *
 *   原来每件装备是一条**线性**进化链（stage 0→1→2→3），玩家没有选择权。
 *   现在改成**形态图（FormNode + EvolutionEdge）**：
 *
 *     - 分支进化：同一层形态可以有多个下一形态，进三选一时由玩家选路线
 *     - 合成进化：两件武器合成一件更强的武器（消耗一个武器槽，之后可补选）
 *     - 高级进化：标记 advanced 的边**只在携带老档（复玩继承）时出现**，
 *                 这是"重复进入才有新进化路线"的落点
 *
 * 【局内三种成长，分别占不同资源】
 *
 *   武器       占武器槽（基准 6 个，复玩 +2），有局外等级，可进化/合成
 *   辅助装备   占辅助槽（基准 6 个，复玩 +2），**进化不消耗槽位**，纯局内
 *   天赋       不占任何槽位，可叠加层数，纯局内
 *
 *   三者在局内都通过**固定三选一**获得（见 core/RewardPicker）。
 */

/** 通用数值表 */
export interface AttrMap {
    [key: string]: number;
}

// ====================================================================
// 装备系统
// ====================================================================

/**
 * 武器原型 —— 决定这件武器的**基础射程与攻击间隔档位**。
 *
 * 用户需求里的"攻击类型根据武器类型来定"落在两处：
 *   1. 这里（原型 → 射程/攻速档位）
 *   2. EquipmentDef.aimMode / FormNode.aimModeId（原型 → 瞄准方式）
 * 两者合起来才是玩家感觉到的那套手感。
 *
 * 从 5 种扩到 12 种是为了满足"每个关卡最合适的武器都不一样"：
 * 只有当武器在**射程、攻速、打击形状**三个维度上真正错开，
 * 关卡设计才能靠"敌人生成阵型"去偏爱其中某几把，
 * 否则推荐武器只是一句写给玩家看的空话。
 */
export type EquipType =
    | 'blade'     // 铁剑：短射程 / 中攻速，前向单体
    | 'bow'       // 短弓：长射程 / 慢攻速，锁定单体
    | 'orb'       // 冰晶球：中射程 / 中攻速，自动锁最近
    | 'hammer'    // 铁锤：短射程 / 慢攻速，震荡波范围
    | 'wheel'     // 回旋轮：超长射程 / 最慢攻速，全屏横扫
    | 'spear'     // 长枪：长射程 / 中攻速，贯穿直线
    | 'dagger'    // 飞刃：中射程 / 极快攻速，移动向三连
    | 'staff'     // 雷杖：中长射程 / 慢攻速，连锁闪电
    | 'scythe'    // 巨镰：短射程 / 中攻速，大扇形横扫
    | 'cannon'    // 重炮：长射程 / 极慢攻速，锁定后砸落
    | 'shuriken'  // 手里剑：中射程 / 快攻速，移动向撒网
    | 'lance';    // 光矛：长射程 / 中攻速，锁定贯穿

/**
 * 敌人类型 —— 决定小怪的 AI 与攻击手段。
 *
 *   melee  近战：一路贴脸，靠数量制造压力（最初的唯一类型）
 *   ranged 远程：始终保持一段距离并投掷弹丸，逼玩家主动绕过去近身击杀
 *
 * 远程怪是难度提升的主要手段之一：它把"站着不动就能赢"这件事直接废掉。
 */
/**
 * 敌人种类（决定了 AI、外观、与场上威胁）。
 *
 * 历史上是 melee / ranged 二分。
 * 第六轮给噩梦档加了三种：**elite / swift / charger**，
 * 它们**只在噩梦难度出现**，普通 / 困难完全不会刷出 —— 这是
 * 把"噩梦难度更强"从单纯的"怪更硬更多"升级成"怪有种类与个性"。
 *
 * 设计意图：
 *   - elite：高血低速 + 护盾，需要先打护盾再打血，是"持续压力源"
 *   - swift：高速贴脸，一口气贴到玩家身边没时间反应，是"短期爆发"
 *   - charger：蓄力 0.8 秒后朝玩家方向冲刺，撞到就高伤，是"地形控制"
 *
 * 三种 AI **各自把玩家逼向不同的应对动作**：精英逼你"打硬目标"、
 * 高速逼你"走位反应"、冲锋逼你"读招预判"。三种同时出现时，
 * 玩家不可能靠单套走位套路撑过去 —— 这正是把"必须主动"从一句口号
 * 变成可玩性约束的关键。
 */
export type EnemyKind = 'melee' | 'ranged' | 'elite' | 'swift' | 'charger';

/**
 * 敌人生成阵型 —— 决定刷怪时敌人怎么摆，这是"每关最合适的武器不同"的物理基础。
 *
 *   只改推荐文案而不改阵型，等于在骗玩家：散兵关带范围武器照样能过，
 *   因为敌人其实还是扎堆刷的。只有让敌人的**位置分布**真的不同，
 *   武器之间的取舍才有依据。
 */
export type FormationKind =
    | 'scatter'   // 零散：从各个方向分散刷出，彼此距离远
    | 'line'      // 成列：倾向于排成一列推进
    | 'cluster'   // 扎堆：挤成一团出现
    | 'swarm';    // 人海：数量多、各自为战、满场乱窜

/**
 * 元素属性 —— 关卡属性、武器镶嵌属性、防具抗性三者共用的键。
 *
 * 刻意定义在这个文件（而不是 ElementConfig）里：
 *   GameTypes 是全局类型中心，它不 import 任何模块；
 *   如果 ElementId 定义在 ElementConfig，GameTypes 就得反向 import 它，
 *   而 ElementConfig 又要 import GameTypes 的 AttrMap —— 形成循环依赖。
 *
 * 24 种（洛克 18 + 金属/剑/木/风/空间/时间），具体克制关系见 data/ElementConfig.ts。
 */
export type ElementId =
    // ---- 洛克 18 种 ----
    | 'normal' | 'fire' | 'water' | 'grass' | 'electric' | 'ice' | 'stone'
    | 'earth' | 'machine' | 'flying' | 'combat' | 'poison' | 'bug'
    | 'ghost' | 'dragon' | 'devil' | 'light' | 'cute'
    // ---- 补充的 6 种 ----
    | 'metal' | 'sword' | 'wood' | 'wind' | 'space' | 'time';

/** 局外等级配置：每一级提供的基础伤害与升级消耗 */
export interface EquipLevelConf {
    level: number;
    /** 局外提供的基础伤害（flat，永久） */
    baseDamage: number;
    /** 从上一级升到本级需要的金币，1 级为 0 */
    upgradeCost: number;
}

/** 攻击方式枚举 —— 决定战斗表现分支 */
export enum AttackModeId {
    /** 单体近战 */
    SINGLE_MELEE = 0,
    /** 单体远程 */
    SINGLE_RANGED = 1,
    /** 三连射 */
    TRIPLE_SHOT = 2,
    /** 范围剑气 */
    SWEEP = 3,
    /** 穿透 */
    PIERCE = 4,
    /** 震荡波 */
    SHOCKWAVE = 5,
    /** 剑雨 / 箭雨 */
    RAIN = 6,
    /** 连锁闪电 */
    CHAIN = 7,
    /** 陨石 */
    METEOR = 8,
    /** 全屏横扫（滚轮类武器的专属形态） */
    FULL_SWEEP = 9,
}

/**
 * 瞄准方式 —— 决定「这一击朝哪打、打谁」。
 *
 * 【与 AttackModeId 的分工】
 *   AttackModeId 管「打出去是什么形状」——单体 / 三连 / 范围 / 穿透 / 剑雨…
 *   AimModeId    管「怎么取方向和目标」——前向 / 锁定 / 移动向 / 最近 / 全屏
 * 两者正交，组合起来才是这件武器完整的战斗手感。
 *
 * 基础瞄准方式由武器类型决定（EquipmentDef.aimMode）。
 * 进化阶段可以覆盖它（EquipEvolutionStage.aimModeId），
 * 于是"终局进化后变成全屏割草"这类设计也能直接配出来。
 */
export enum AimModeId {
    /** 前向攻击：只打面朝方向，完全不索敌。走位对准是唯一命中手段 */
    FRONT = 0,
    /** 锁定：锁住一个目标持续追踪，目标死亡或超出射程才换目标 */
    LOCK_ON = 1,
    /** 移动方向：攻击方向 = 当前拖动方向，边走边打 */
    MOVE_DIR = 2,
    /** 最近距离：每次攻击都重新取最近的敌人，无锁定状态 */
    NEAREST = 3,
    /** 全屏滚动：既不取方向也不索敌，直接横扫整个战场 */
    SCREEN_ROLL = 4,
}

/** 瞄准方式的界面文案 */
export const AIM_MODE_TEXT: Record<AimModeId, string> = {
    [AimModeId.FRONT]: '前向',
    [AimModeId.LOCK_ON]: '锁定',
    [AimModeId.MOVE_DIR]: '移动向',
    [AimModeId.NEAREST]: '最近',
    [AimModeId.SCREEN_ROLL]: '全屏',
};

/** 瞄准方式的一句话说明，装备面板上给玩家看 */
export const AIM_MODE_DESC: Record<AimModeId, string> = {
    [AimModeId.FRONT]: '只朝面朝方向攻击，靠走位对准敌人',
    [AimModeId.LOCK_ON]: '锁定一个目标持续追踪，直到目标倒下',
    [AimModeId.MOVE_DIR]: '朝你拖动的方向攻击，走哪打哪',
    [AimModeId.NEAREST]: '自动攻击最近的敌人，无需瞄准',
    [AimModeId.SCREEN_ROLL]: '横扫整个战场，无需瞄准',
};

/**
 * 槽位种类。
 *
 * 武器与辅助装备共用同一套「形态图」结构，唯一区别就是占哪个槽：
 *   weapon → 武器槽（基准 6，复玩 +2），有局外等级，可合成
 *   aux    → 辅助槽（基准 6，复玩 +2），没有局外等级，**进化从不消耗槽位**
 */
export type SlotKind = 'weapon' | 'aux';

/**
 * 进化边的类型 —— 这是玩家需求里"两种进化"的直接映射。
 *
 *   upgrade  升级型进化：同一条武器线内升阶（铁剑 → 淬锋剑）。
 *            不消耗槽位，也永远不改变槽位数量。
 *            武器与辅助装备都可以走这一类。
 *
 *   fusion   合成型进化：两件武器合成一件（铁剑 + 短弓 → 剑雨风暴）。
 *            **消耗一个武器槽**（两个变一个），合成完成后释放出的槽位
 *            会让 `pendingPicks +1`，玩家可以再选一件武器补进来。
 */
export type EvolutionEdgeType = 'upgrade' | 'fusion';

/** 一条进化边 */
export interface EvolutionEdge {
    /** 目标形态 id */
    to: string;
    type: EvolutionEdgeType;
    /** 合成型进化需要的另一个形态 id（type === 'fusion' 时必填） */
    need?: string;
    /** 按钮上的短文案，如"剑雨覆盖" */
    label: string;
    /** 一句话说明 */
    desc: string;
    /**
     * 更上级进化 —— 只有**携带老档（复玩继承）**进入本局时才出现。
     *
     * 这就是玩家说的"重复进入的时候添加新的进化路线"：
     * 首次开荒拿不到，只有带着上次通关的装备回来才能继续往上走。
     * 它让复玩有明确的、可见的新目标，而不只是"再打一遍"。
     */
    advanced?: boolean;
}

/**
 * 辅助装备的机制效果。
 *
 * 与武器的区别：武器改变"怎么打"（攻击方式 + 瞄准方式），
 * 辅助装备改变"打得多快多稳"（攻速 / 暴击 / 吸血 / 护盾 / 反伤…）。
 * 两者叠加成最终的 CombatModifier，交给战斗层消费。
 */
export interface AuxEffect {
    /** 额外攻击百分比 */
    atkPct?: number;
    /** 攻速加成，0.2 = 攻击间隔 × 1/1.2 */
    atkSpeedPct?: number;
    /** 暴击率 0~1 */
    critRate?: number;
    /** 暴击伤害倍率，默认 2.0 */
    critMul?: number;
    /** 吸血：造成伤害的百分比回复玩家生命 */
    lifesteal?: number;
    /** 移速加成 */
    moveSpeedPct?: number;
    /** 生命上限加成（flat） */
    maxHpFlat?: number;
    /** 护盾：抵挡固定伤害，每关开局重置 */
    shield?: number;
    /** 经验加成 */
    expPct?: number;
    /** 荆棘：受到近战伤害时反弹的固定伤害 */
    thorns?: number;
    /** 额外攻击距离百分比 */
    rangePct?: number;
    /** 每次攻击额外发射的弹道数 */
    extraShots?: number;
    /** 连锁闪电的额外跳数（CHAIN 专用） */
    chainBonus?: number;
    /** 无视目标属性抗性的比例 0~1 —— 石 / 时间 属性带来 */
    pierceResist?: number;
    /** 对血量高于上限 30% 的敌人加伤 —— 龙属性带来 */
    highHpDmg?: number;
}

/**
 * 形态节点 —— 形态图的基本单位。
 *
 * 【为什么不是"每件装备一条链"】
 * 线性链无法表达分支与合成。改成图之后，
 * "同一把武器可以走两条不同的终局路线"和"两把武器合成一件"这两件事
 * 才能用同一套数据结构描述，奖励生成也只需要一遍逻辑。
 */
export interface FormNode {
    /** 唯一 id。根形态的 id 同时就是局外装备 id */
    id: string;
    name: string;
    kind: SlotKind;
    /** 一句话描述 */
    desc: string;
    /** 武器类型，决定基础射程与攻击间隔（辅助装备用 'aux' 占位语义） */
    equipType: EquipType | 'aux';
    /**
     * 组成这条形态的全部局外装备 id。
     * 根形态 = [自己]；合成形态 = [材料A, 材料B]。
     * 用来累计基础伤害：合成后两把的基础伤害汇成一份，玩家不会因为合成而掉伤害。
     */
    sources: string[];
    /** 层级，0 = 初始形态。UI 按它排序，战力汇总按它取"最靠前"的形态 */
    depth: number;
    /** 攻击百分比加成 */
    atkPct: number;
    /** 攻击距离百分比加成 */
    rangePct: number;
    attackModeId: AttackModeId;
    /** UI 展示的攻击方式文案 */
    attackModeText: string;
    /** 覆盖默认瞄准方式；不填 = 沿用武器类型的基础值 */
    aimModeId?: AimModeId;
    aimModeText?: string;
    /** 辅助装备的机制效果 */
    effect?: AuxEffect;
    /**
     * 第八轮：这件装备的原生品阶（0~6）。
     *
     * 根形态携带它 —— 玩家抽到/打造出来的那一刻就知道这是几阶装备。
     * 进化**不改变品阶**：品阶是局外品质轴，进化是局内形态轴，两者正交。
     * 不填 = 0（青铜），于是所有既有配置无需改动。
     */
    rarity?: number;
    /**
     * 第八轮：钻石及以上品阶专属装备的**自带复合属性**。
     *
     * 与"材料镶进去的属性"（镶嵌槽）是两回事：
     *   innate    装备天生就有，升阶自动继承，不需要任何材料
     *   sockets   玩家自己镶的，可以卸下退还
     *
     * `elements` 只是给 UI 与克制面板展示"这件自带哪几种属性"，
     * 真正生效的是 `bonus`。
     */
    innate?: InnateAttribute;
    /** 出边：本形态可以进化成哪些形态 */
    evolveTo: EvolutionEdge[];
}

/**
 * 复合属性加成向量（第八轮：高阶专属装备的"自带属性"）。
 *
 * 【为什么在这里再定义一份而不是 import ElementConfig.ElementBonus】
 *   ElementConfig 反向 import 了本文件的 EquipType，再让本文件 import 它会形成循环依赖。
 *   类型层面的循环在 TS 里通常能编译，但会让模块加载顺序变脆 ——
 *   而本文件是纯类型定义，不该依赖任何实现模块。
 *   所以这里定义一份结构相同的接口，两者赋值时完全兼容。
 */
export interface InnateBonus {
    /** 额外攻击百分比 */
    atkPct?: number;
    /** 攻速加成 */
    atkSpeedPct?: number;
    /** 暴击率 0~1 */
    critRate?: number;
    /** 吸血比例 */
    lifesteal?: number;
    /** 生命上限加成（flat） */
    maxHpFlat?: number;
    /** 护盾值 */
    shield?: number;
    /** 荆棘反伤 */
    thorns?: number;
    /** 额外攻击距离百分比 */
    rangePct?: number;
    /** 每次攻击额外弹道数 */
    extraShots?: number;
    /** 无视目标属性抗性的比例 */
    pierceResist?: number;
    /** 对高血量敌人加伤 */
    highHpDmg?: number;
}

/** 一件装备的自带复合属性 */
export interface InnateAttribute {
    /** 自带哪几种属性（UI 与克制面板展示用） */
    elements: ElementId[];
    /** 实际生效的加成 */
    bonus: InnateBonus;
}

/**
 * 局内进化阶段配置。
 *
 * @deprecated 已被 FormNode 取代，仅用于把 v2 存档里的 (装备 id, stage)
 * 反查成 formId。新代码一律用 FormConfig 的形态图。
 */
export interface EquipEvolutionStage {
    stage: number;
    name: string;
    expToReach: number;
    atkPct: number;
    rangePct: number;
    attackModeId: AttackModeId;
    attackModeText: string;
    aimModeId?: AimModeId;
    aimModeText?: string;
}

/**
 * 局外装备定义 —— 玩家在主界面看到并升级的那张脸。
 *
 * 它只负责"永久投资"这一半：解锁条件、升级消耗、每级的基础伤害。
 * 局内的战斗表现（攻击方式 / 瞄准方式 / 形态名）全部由形态图负责，
 * 入口是 `FormConfig.getRootForm(def.id)` —— **装备 id 就是它的根形态 id**。
 *
 * 辅助装备没有局外等级，因此没有对应的 EquipmentDef（只在形态图里）。
 */
export interface EquipmentDef {
    id: string;
    name: string;
    type: EquipType;
    /** 一句话描述 */
    desc: string;
    /**
     * 这件武器的**基础瞄准方式**，由武器类型决定。
     * 玩家需求里的"有的只有前攻击、有的可以锁定、有的根据移动方向…"就是这一项。
     */
    aimMode: AimModeId;
    maxLevel: number;
    /**
     * 解锁所需关卡：玩家解锁到该关时自动获得这件装备。
     * 与 unlockDifficulty 是**与**关系，两个条件都满足才会发放。
     */
    unlockLevel: number;
    /**
     * 解锁所需难度：玩家在任意关卡通关到该难度后才发放这件装备。
     * 不填 = 1（普通难度即可获得）。
     *
     * 这就是玩家说的"然后再开放新的装备"—— 难度是装备开放的闸门，
     * 于是推进难度本身就有明确回报，而不只是"怪更硬"。
     */
    unlockDifficulty?: number;
    /**
     * 第八轮：这件武器的原生品阶（0~6）。
     *
     * 0~2 是常规武器（青铜/白银/黄金），3~5 是钻石及以上的**专属武器**。
     * 抽奖抽到的武器直接就是这个品阶 —— 不需要从青铜开始爬。
     * 不填 = 0。
     */
    rarity?: number;
    /** 局外等级表，索引 0 对应 1 级 */
    levels: EquipLevelConf[];
}

/** 装备的局外持有状态（永久，存 PlayerProfile） */
export interface OwnedEquipment {
    id: string;
    /** 局外等级，从 1 开始 */
    level: number;
    /**
     * 第八轮：这件装备的品阶（0~6，青铜→传说）。
     * 由升阶提升，决定强度倍率、镶嵌槽位数与是否参与自带属性。
     * 不填 = 0（青铜），于是所有既有配置与老存档无需改动。
     */
    rarity?: number;
    /**
     * 锻造状态：已镶嵌的属性。
     *
     * 【第八轮起这里没有 rank 了】
     * 原来还有一个 `rank`（1~5）决定镶嵌槽位数。现在品阶（见 RarityConfig）
     * 接管了这个职责，两套阶梯并存会让玩家面对
     * "先突破还是先升阶"这种没有意义的问题。
     * 老存档的 rank 在 migrateToV6 里映射成品阶。
     */
    forge?: {
        /** 已镶嵌的属性数组，长度 = 该品阶的槽位数，null = 空槽 */
        sockets: (ElementId | null)[];
    };
}

/**
 * 一个装备槽的局内运行时状态（随关卡重置，通关后进入档案）。
 *
 * 【id 与 formId 的分工】
 *   id      局外装备 id —— 决定基础伤害从哪来。**进化永远不改它**
 *   formId  当前形态 id —— 决定攻击方式与瞄准方式。进化改的是它
 *
 * 分开的原因：合成进化会让"铁剑"这个槽变成"剑雨风暴"，
 * 但它依然吃两把材料武器的局外等级收益，所以基础伤害来源必须独立于形态。
 */
export interface EquipRunState {
    /** 局外装备 id（合成形态为材料列表里的第一件） */
    id: string;
    /**
     * 当前形态 id。
     * 不填（v2 老档案）时由 (id, stage) 反查 —— 见 FormConfig.legacyFormId。
     */
    formId?: string;
    /** 占哪个槽 */
    kind: SlotKind;
    /** 当前形态层级。冗余存一份，便于排序与展示 */
    stage: number;
    /** 本关内累计经验 */
    exp: number;
}

/** 一次进化事件，用于播放特效与飘字 */
export interface EvolutionEvent {
    slotIndex: number;
    kind: SlotKind;
    equipName: string;
    fromFormId: string;
    toFormId: string;
    fromName: string;
    /** 进化后形态名 */
    toName: string;
    /** 是升级型还是合成型 —— UI 用不同特效 */
    type: EvolutionEdgeType;
    /** 被消耗掉的另一件武器名（合成型才有） */
    consumedName?: string;
    atkPct: number;
    attackModeText: string;
}

// ====================================================================
// 局内长线成长：三选一奖励
// ====================================================================

/**
 * 奖励类别 —— 玩家说的"选武器或者选天赋以及选辅助装备"就是前三项，
 * 后三项是它们各自的进化分支。
 */
export type RewardKind =
    | 'weapon_new'
    | 'weapon_evolve'
    | 'weapon_fusion'
    | 'aux_new'
    | 'aux_evolve'
    | 'talent';

/** 一个候选奖励（三选一里的一张卡） */
export interface RewardOption {
    kind: RewardKind;
    /** 稳定 key，测试与埋点用；同一轮内不重复 */
    key: string;
    title: string;
    /** 副标题：形态名 / 层数 */
    subtitle: string;
    desc: string;
    /** 品质 0~3，UI 配色（0 普通 / 1 稀有 / 2 史诗 / 3 传说） */
    rarity: number;
    /** 目标形态（武器 / 辅助类） */
    formId?: string;
    /** 天赋 id */
    talentId?: string;
    /** 进化作用在哪个槽位。-1 = 新增槽位 */
    slotIndex: number;
    /** 合成型进化需要玩家已拥有的另一件形态 */
    needFormId?: string;
    needName?: string;
    /** 是否消耗一个槽位（合成型为 true：两格变一格） */
    consumesSlot?: boolean;
    /** 高级进化（仅复玩继承时出现），UI 上给个标记 */
    advanced?: boolean;
}

/**
 * 局内的完整 build 状态。
 *
 * 【为什么武器和辅助用数组而不是固定长度的槽位数组】
 * 槽位上限是动态的（基准 6，复玩 +2），而"空槽"就是 length < cap。
 * 这样合成时"两格变一格"只需要删一个元素，不需要维护空洞。
 */
export interface RunLoadoutState {
    weapons: EquipRunState[];
    auxes: EquipRunState[];
    /** 天赋层数 { talentId: count } */
    talents: Record<string, number>;
    /** 当前关卡等级，每升一级触发一次三选一 */
    level: number;
    /** 当前等级内已累积的经验 */
    pendingExp: number;
    /** 待补选的武器数（合成消耗槽位后 +1，补选完成后归零） */
    pendingPicks: number;
    /** 当前待选的三张卡（为空表示没有待选） */
    pending: RewardOption[];
}

/** 计算后的最终战力，战斗逻辑只读这个 */
export interface CombatPower {
    /** 总基础伤害（来自局外等级 + 关卡内 flat 攻击） */
    baseDamage: number;
    /** 总攻击百分比加成 */
    atkPct: number;
    /** 攻击距离倍率，1.0 = 原始距离 */
    rangeMul: number;
    /** 最终伤害 = baseDamage * (1 + atkPct) */
    finalDamage: number;
    /** 主武器当前攻击方式 */
    attackModeId: AttackModeId;
    attackModeText: string;
    /** 主武器当前的瞄准方式 */
    aimModeId: AimModeId;
    aimModeText: string;
}

// ====================================================================
// 局内长线成长：天赋
// ====================================================================

/**
 * 天赋定义 —— 第三类局内成长。
 *
 * 与武器 / 辅助装备的区别：**不占任何槽位**，可以叠层。
 * 它承担的是"三选一里最稳的那一档收益"：抽到武器可能因为槽满而没用，
 * 但天赋永远生效，所以候选池永远保底有它，不会出现"三个都不能选"。
 */
export interface TalentDef {
    id: string;
    name: string;
    desc: string;
    /** 品质 0~3，UI 配色 */
    rarity: number;
    /** 最大层数。1 = 唯一型，拿过一次就不再出现在候选池 */
    maxStacks: number;
    /** 分类：进攻 / 防御 / 机动 / 经济 */
    group: string;
    /** 每层提供的效果 */
    effect: AuxEffect;
    /** 每层效果的说明后缀，UI 拼在 desc 后面，如"+8% 攻击" */
    perStackText?: string;
}

/**
 * 战斗修正汇总 —— 天赋与辅助装备的最终产物。
 *
 * 战斗层只认这一个结构，不认识"天赋""辅助装备""形态"这些概念，
 * 于是新增一件辅助装备不需要改战斗逻辑一行。
 */
export interface CombatModifier {
    /** 额外攻击百分比 */
    atkPct: number;
    /** 攻速加成 */
    atkSpeedPct: number;
    /** 暴击率 0~1 */
    critRate: number;
    /** 暴击伤害倍率 */
    critMul: number;
    /**
     * 运行时记账：critMul 里"由绝对倍率决定的那一层"。
     *
     * 存在的唯一原因是 `addEffect` 遇到绝对倍率（辅助 2.2 / 2.3 / 2.8）时
     * 不能直接对 `critMul` 取 max —— 那会把此前由增量（天赋 0.15 / 幽属性 0.35）
     * 累加出来的那部分直接抹掉。有了这个字段就能把两层分开算。
     *
     * ⚠️ 可选字段，**不参与存档序列化与 UI 展示**，缺失时按基准 2.0 处理。
     */
    _critMulAbs?: number;
    /** 吸血比例 */
    lifesteal: number;
    /** 移速加成 */
    moveSpeedPct: number;
    /** 生命上限加成 */
    maxHpFlat: number;
    /** 护盾值 */
    shield: number;
    /** 经验加成 */
    expPct: number;
    /** 荆棘反伤 */
    thorns: number;
    /** 额外攻击距离百分比 */
    rangePct: number;
    /** 每次攻击额外弹道数 */
    extraShots: number;
    /** 连锁闪电额外跳数 */
    chainBonus: number;
    /** 无视属性抗性的比例 0~1 */
    pierceResist: number;
    /** 对高血量敌人加伤 */
    highHpDmg: number;
}

/** 暴击伤害倍率的基准值：暴击默认打 2 倍伤害 */
export const CRIT_MUL_BASE = 2.0;

/** 一份空修正，作为累加的起点 */
export function emptyModifier(): CombatModifier {
    return {
        atkPct: 0, atkSpeedPct: 0, critRate: 0, critMul: CRIT_MUL_BASE, lifesteal: 0,
        moveSpeedPct: 0, maxHpFlat: 0, shield: 0, expPct: 0, thorns: 0,
        rangePct: 0, extraShots: 0, chainBonus: 0, pierceResist: 0, highHpDmg: 0,
    };
}

/**
 * 把一个 AuxEffect 累加进 CombatModifier。
 *
 * 【critMul 的两种语义与处理（2026-10-16 修复）】
 *   `critMul` 在这套工程里有**两种写法**，而它们的含义完全不同：
 *     绝对值：辅助装备给 `critMul: 2.2` →「暴击伤害 2.2 倍」（鹰眼镜 2.2 / 灭世之瞳 2.8）
 *     增量值：天赋给 `critMul: 0.15` →「暴击伤害 +0.15 倍」（破甲印记）
 *             属性给 `critMul: 0.35` →「暴击伤害 +0.35 倍」（幽属性镶嵌）
 *
 *   原来的实现无条件取 `Math.max(mod.critMul, e.critMul)`，
 *   于是增量语义的天赋与属性**全部被丢弃** ——
 *   `Math.max(2.0, 0.15) = 2.0`，破甲印记与幽属性都是死条目。
 *
 *   现在按数值分档判定：
 *     e.critMul >= 2 → 视为**绝对倍率**，取max（沿用原语义）
 *     e.critMul <  2 → 视为**增量**，加到"当前值 - 基准 2.0"上
 *   阈值取 2.0 是因为它是 `emptyModifier()` 的起点，也是
 *   `BattleWorld` 里`Math.max(1.1, critMul || 2)` 的兜底值 ——
 *   任何合法的暴击倍率都必须 ≥ 1.1，所以 2.0 是安全的分界。
 */
export function addEffect(mod: CombatModifier, e: AuxEffect | undefined, scale = 1): CombatModifier {
    if (!e) return mod;
    const add = (cur: number | undefined, delta: number | undefined): number =>
        (cur || 0) + (delta || 0) * scale;
    mod.atkPct = add(mod.atkPct, e.atkPct);
    mod.atkSpeedPct = add(mod.atkSpeedPct, e.atkSpeedPct);
    mod.critRate = add(mod.critRate, e.critRate);
    if (e.critMul !== undefined) {
        if (e.critMul < CRIT_MUL_BASE) {
            // 增量语义（天赋 0.15 / 幽属性 0.35）：直接累加，满层也生效
            mod.critMul = mod.critMul + e.critMul * scale;
        } else {
            // 绝对倍率语义（辅助装备 2.2 / 2.3 / 2.8）：只抬「基准层」，保留「增量层」
            //
            // 为什么必须拆成两层 —— 直接对当前值取 max 会出两种错：
            //   ① Math.max(2.0 + 0.35, 2.5) = 2.5，绝对倍率把已累加的增量吃掉了，
            //      于是"幽属性 + 破甲印记 + 灭世之瞳"三件同穿时前两件白穿；
            //   ② 若改成累加，则两件 2.2 会变成 4.4，暴击倍率失控。
            //
            // _critMulAbs 记住"当前基准层是多少"，增量 = 当前值 - 基准层。
            // 它是运行时记账字段，不参与任何 UI 展示与存档序列化。
            const abs = mod._critMulAbs || CRIT_MUL_BASE;
            const inc = mod.critMul - abs;
            mod._critMulAbs = Math.max(abs, e.critMul * scale);
            mod.critMul = mod._critMulAbs + inc;
        }
    }
    mod.lifesteal = add(mod.lifesteal, e.lifesteal);
    mod.moveSpeedPct = add(mod.moveSpeedPct, e.moveSpeedPct);
    mod.maxHpFlat = add(mod.maxHpFlat, e.maxHpFlat);
    mod.shield = add(mod.shield, e.shield);
    mod.expPct = add(mod.expPct, e.expPct);
    mod.thorns = add(mod.thorns, e.thorns);
    mod.rangePct = add(mod.rangePct, e.rangePct);
    mod.extraShots = add(mod.extraShots, e.extraShots);
    mod.chainBonus = add(mod.chainBonus, e.chainBonus);
    mod.pierceResist = add(mod.pierceResist, e.pierceResist);
    mod.highHpDmg = add(mod.highHpDmg, e.highHpDmg);
    return mod;
}

// ====================================================================
// 复玩强化：可选的加难
// ====================================================================

/**
 * 复玩加难设置 —— 玩家重复进入同一关同一难度时可自选的额外难度。
 *
 * 与三档难度的关系是**乘算叠加**：
 *   最终倍率 = 档位倍率 × (1 + percent)
 * 每复玩通关一次就可以再加码一点，于是"同一关"能一直有新的挑战上限，
 * 而不用去动三档难度的固定数值（那会破坏新手体验）。
 */
export interface ReplayBoost {
    enabled: boolean;
    /** 加难百分比，0.3 = 敌人血量与攻击 +30% */
    percent: number;
}

/** 复玩加难的可选档位（UI 上的刻度） */
export const REPLAY_BOOST_STEPS: number[] = [0, 0.15, 0.3, 0.5, 0.8, 1.2];

/**
 * 允许的最大加难百分比。
 *
 * ⚠️ **它比 `REPLAY_BOOST_STEPS` 的上限（1.2）大得多，这是有意的**：
 *   1.2 是**UI 刻度**（玩家只能从这 6 档里选）；
 *   3.0 是**存档兜底**（`setReplayBoost` 收敛到这个值）——
 *   本地存档可被改，若把上限设成 1.2，被改成 1.2 以上的档位会在读档时被夹回，
 *   玩家的选择就"变了"；给一个宽裕的兜底值，改档与读档行为才一致。
 *
 * 别把这两个数"对齐"—— 对齐反而会让防注入的收敛失去意义。
 */
export const REPLAY_BOOST_MAX = 3.0;

// ====================================================================
// 成就
// ====================================================================

/**
 * 成就条件类型。
 *
 * 刻意覆盖了所有新增系统：合成、图鉴、复玩加难、深度进化、
 * 这样成就就成了"把所有系统都玩一遍"的引导，而不是孤立的收集品。
 */
export type AchievementKind =
    | 'clearLevel'      // 通关指定关卡（任意难度）
    | 'clearTier'       // 通关指定难度档（任意关卡）
    | 'noDamageClear'   // 无伤通关
    | 'affinityClear'   // 用该关推荐武器通关
    | 'firstFusion'     // 首次触发合成进化
    | 'fusionCount'     // 累计合成次数
    | 'collectForms'    // 图鉴收录形态数
    | 'reachDepth'      // 单局内把某条线推到指定形态层级
    | 'boostClear'      // 启用复玩加难并通关，且百分比不低于 target
    | 'killTotal'       // 累计击杀
    | 'formCountInRun'  // 单局同时持有指定数量的形态
    | 'talentStacks'    // 单个天赋叠到指定层数
    | 'breakRank'       // 任一武器突破到指定等阶
    | 'socketCount'     // 单把武器镶嵌的属性数量
    | 'elementMasters'  // 拥有的完整属性材料种类数
    | 'craftStone'      // 累计合成过完整属性材料的次数
    | 'armorOwned'      // 拥有的防具数量
    | 'omniArmor'       // 集齐任意一套完整的四部位防具（头/身/裤/鞋）
    | 'elementCounter'  // 用属性克制打出的累计伤害
    | 'elementResist'   // 累计被属性抗性减免的伤害

export interface AchievementDef {
    id: string;
    name: string;
    desc: string;
    kind: AchievementKind;
    /** 数值门槛 */
    target: number;
    /** 目标 id：武器 id / 形态 id / 天赋 id */
    targetId?: string;
    /** 奖励永久金币 */
    gold: number;
    /** 面板分组 */
    group: string;
    /** 隐藏成就：达成前只显示 ??? */
    secret?: boolean;
}

export interface AchievementRecord {
    id: string;
    at: number;
}

/**
 * 一次通关（或失败）的统计快照。
 *
 * 成就判定只读这个结构，不直接读运行时状态 ——
 * 这样成就逻辑可以在 Node 里用构造出来的快照完整测试，
 * 不需要真的跑一场战斗。
 */
export interface RunSummary {
    levelId: number;
    tier: number;
    cleared: boolean;
    noDamage: boolean;
    score: number;
    time: number;
    kills: number;
    goldEarned: number;
    /** 本局是否使用了该关的推荐武器 */
    usedAffinity: boolean;
    /** 本局是否启用了复玩加难 */
    boosted: boolean;
    boostPercent: number;
    /** 本局触发的合成次数 */
    fusions: number;
    /** 本局持有的最高形态层级 */
    maxDepth: number;
    /** 本局持有的形态 id 列表（含初始形态） */
    forms: string[];
    /** 本局的天赋层数 */
    talents: Record<string, number>;
    weaponCount: number;
    auxCount: number;
    /** 本局用属性克制打出的累计伤害（成就是累计型，所以取本局值累加到档案） */
    elementDamage?: number;
    /** 本局被属性抗性减免的累计伤害 */
    resistReduced?: number;
    /**
     * 本局通关获得的许愿水晶（第七轮新增）。
     * 与 goldEarned 并列，但**不打折** —— 它的速率由"通关"这个硬门槛锁死。
     */
    crystalsGained?: number;
}

// ====================================================================
// 难度体系
// ====================================================================

/**
 * 一档难度的完整定义。
 *
 * 设计取向：难度提升必须是**可感知的多维度**，而不是单纯把血量乘一个大数。
 * 只加血量会让战斗变成"磨"，玩家体感是变累而不是变难；
 * 所以这里同时抬高攻击、移速、数量，并用远程怪比例改变战斗结构。
 */
export interface DifficultyDef {
    /** 难度层级，从 1 开始，同时是玩家看到的"第几档难度" */
    tier: number;
    /** 稳定标识，用于存档与埋点 */
    id: string;
    /** 显示名：普通 / 困难 / 噩梦 */
    name: string;
    /** 敌人血量倍率 */
    hpMul: number;
    /** 敌人攻击倍率（近战接触伤害与远程弹丸伤害同时生效） */
    atkMul: number;
    /** 敌人移速倍率。刻意保持远低于玩家移速，避免走位失去意义 */
    speedMul: number;
    /** 敌人数量倍率 */
    countMul: number;
    /** 永久金币产出倍率 —— 高难度必须给得出回报，否则没人愿意打 */
    goldMul: number;
    /** 通关得分倍率，让不同难度的高分可比但不混淆 */
    scoreMul: number;
    /** 远程怪占全部敌人的比例，0 = 全近战 */
    rangedRatio: number;
    /** 远程怪保持的间距（像素），小于它会后撤 */
    kiteRange: number;
    /** 远程弹丸飞行速度 */
    shotSpeed: number;
    /** 远程射击间隔（秒） */
    shotInterval: number;
    /** 一句话说明，难度选择面板上给玩家看 */
    desc: string;
    /** UI 主色 RGB */
    color: [number, number, number];
}

// ====================================================================
// 玩家与关卡
// ====================================================================

/** 全局玩家档案：只记进度、永久货币与装备的局外等级 */
export interface PlayerProfile {
    version: number;
    unlockedLevel: number;
    clearedLevels: number[];
    /**
     * 每关已解锁的最高难度 { "3": 2 } —— 即第 3 关已解锁到困难。
     * 难度解锁是**每关独立**的：第 3 关打到困难，不会让第 5 关也解锁困难。
     */
    maxTiers: Record<string, number>;
    /**
     * 全局最高已解锁难度。取所有关卡 maxTiers 的最大值。
     * 它驱动的是"跨关卡"的东西：出战槽位数量、新装备开放。
     */
    globalMaxTier: number;
    /** 每关每难度通关次数 { "3_2": 2 } */
    clearCounts: Record<string, number>;
    /** 每关每难度历史最高分 */
    bestScores: Record<string, number>;
    /** 每关每难度历史最快通关秒数 */
    bestTimes: Record<string, number>;
    /** 永久货币，用于局外升级装备（不会因关卡重置而消失） */
    gold: number;
    /** 永久持有的装备及其局外等级 */
    equipment: OwnedEquipment[];
    /** 当前出战装备 id */
    equippedIds: string[];
    totalAdViews: number;
    totalRestarts: number;

    // ---- 第三轮新增：成就 / 图鉴 / 复玩 ----

    /** 已解锁的成就 */
    achievements: AchievementRecord[];
    /**
     * 已见过的形态 id（进化图鉴）。
     * 无论是"在局内进化到过"还是"在主界面预览过"，只要见过就记一笔。
     * 主界面的进化图鉴靠它决定哪些分支显示为已解锁、哪些还盖着问号。
     */
    seenForms: string[];
    /** 累计触发合成进化的次数 */
    fusionCount: number;
    /** 累计击杀数 */
    totalKills: number;
    /** 累计"带着该关推荐武器通关"的次数 */
    affinityClearCount: number;
    /** 每关每难度的复玩次数 { "3_2": 4 } */
    replayCounts: Record<string, number>;
    /** 每关每难度已选定的复玩加难百分比 { "3_2": 0.3 } */
    replayBoosts: Record<string, number>;
    /** 累计用属性克制打出的伤害（成就 elementCounter 用） */
    elementDamageTotal?: number;
    /** 累计被属性抗性减免的伤害（成就 elementResist 用） */
    resistReducedTotal?: number;
    /** 累计合成过完整属性材料的次数 */
    craftStoneCount?: number;

    // ---- 第四轮新增：突破 / 属性材料 / 防具 ----

    /** 突破材料背包 { "mat_blade": 12 } */
    materials?: Record<string, number>;
    /** 属性碎片背包 { "shard_light": 7 } —— 10 个碎片合成 1 个完整 */
    shards?: Record<string, number>;
    /** 完整属性材料 { "stone_light": 2 } */
    stones?: Record<string, number>;
    /** 防具持有与穿戴（第九轮起为四部位套装，见 OwnedArmor / ArmorWorn） */
    armor?: {
        owned: OwnedArmor[];
        /** 四部位穿戴，值为 OwnedArmor.uid；缺失=该部位空 */
        worn: ArmorWorn | null;
    };

    // ---- 第七轮新增：许愿抽卡 ----

    /**
     * 许愿水晶余额（抽卡货币）。
     * 按通关难度发放：普通 10 / 困难 30 / 噩梦 100，10 个水晶抽一次。
     *
     * 它是纯局外货币，不会随关卡重置清零 ——
     * 攒到 100 意味着玩家可以一次十连，这是打高难度最实在的回报。
     */
    crystals?: number;
    /**
     * 辅助装备的局外持有与阶数。
     *
     * 辅助装备原本是纯局内的（打一局扔一局），这一轮给了它局外阶数，
     * 于是它成为与武器对等的长期养成线：抽到 → 升阶 → 每局带着它进场时效果更强。
     * 阶数放大基础加成的方式是**倍率**而非固定加值，见 GachaConfig.AUX_RANK_MUL。
     */
    auxOwned?: OwnedAux[];
    /**
     * 武器池保底计数：连续抽到"已拥有"的次数。
     * 达到阈值时下一次必给未收集项，抽到新东西即清零。
     */
    pityWeapon?: number;
    /** 辅助池保底计数（与武器池分开累计，抽武器不会消耗抽辅助的进度） */
    pityAux?: number;
    /** 装备池（防具）保底计数 —— 三个池子各自独立 */
    pityArmor?: number;
    /** 累计抽卡次数，统计与成就用 */
    gachaTotal?: number;

    // ---- 第八轮新增：高阶碎片 / 祝福值 ----

    /**
     * 高阶碎片 —— 兑换专属装备的通用货币。
     * 25 个可任选一件高阶（钻石）武器 / 防具 / 辅助装备。
     * 它是"抽不到也不被卡死"的保底：纯随机有长尾，
     * 碎片让玩家永远有一条确定的路走到高阶。
     */
    fragHigh?: number;
    /**
     * 祝福值。
     * 来源：献祭水晶（10 水晶 = 1 点）或看激励视频（+3 点）。
     * 作用：每次抽卡消耗 1 点，使本次**钻石及以上品阶的权重翻倍**。
     *
     * 上限 30 —— 不给无限叠，否则高品阶概率会被彻底稀释掉随机性。
     * 祝福值 0 时游戏完全正常，它不是必需品，只是加速器。
     */
    blessing?: number;
    /** 累计献祭过的水晶数（统计用） */
    totalSacrificed?: number;
    /** 累计升阶次数（统计用） */
    totalAscends?: number;

    // ---- 第十轮新增：新手引导 / 首通教学 ----

    /**
     * 已看过的教学（新手引导 / 首通教学）。
     * key = 教学 id（'newbie' 对应新手引导；'tip_xxx' 对应首通教学），存在即"已看"。
     * 只新增、不删减：跳过或关闭都算"看过"，之后不再打扰。
     */
    tutorials?: Record<string, boolean>;

    // ---- 第十一轮新增：万象线（隐藏的防具终局养成线）----

    /**
     * 「万象线」进度。
     *
     * 0 = 未开始（UI 完全隐藏）；1~3 = 中间阶段（万象·碎片之核 / 镜胚 / 镜甲）；
     * 4 = 已完成，四件「万象套」已发放。
     *
     * 它是一条**只增不减**的进度：不跟随"清档"以外的任何操作回退。
     * 缺省视为 `{ stage: 0 }`（v8 迁移补齐），见 docs/防具套装系统设计.md §10。
     */
    omni?: {
        stage: number;
    };

    createdAt: number;
}

/**
 * 辅助装备的局外持有状态。
 *
 * 它挂在 PlayerProfile 上而不是 OwnedEquipment 上，
 * 因为辅助装备没有 EquipmentDef（也就没有局外等级与升级曲线）——
 * 它的永久成长只有一条线：阶数。
 */
export interface OwnedAux {
    /** 辅助根形态 id，如 aux_thorn */
    id: string;
    /** 阶数 1~5，放大 effect 的倍率 */
    rank: number;
    /**
     * 第八轮：这件辅助的品阶（0~6）。
     * 与武器的品阶同一条轴，决定 effect 的品质倍率与镶嵌槽位。
     * 不填 = 0（青铜）。
     */
    rarity?: number;
}

/**
 * 防具的局外持有状态（第九轮起为四部位套装的单体部件）。
 *
 * 【为什么加 uid】
 * 玩家可能同时持有两件同 id、不同品阶的同一部件
 * （一件穿着、一件当升阶材料），必须能用实例区分。
 * 穿戴槽（ArmorWorn）指向的就是这个 uid。
 */
export interface OwnedArmor {
    /** 实例唯一 id（迁移时生成，新获取时生成） */
    uid: string;
    /** 防具部件定义 id，如 armor_lieyan_head */
    id: string;
    /** 品阶 0~6 */
    rarity: number;
    /**
     * 已镶嵌的属性石：长度 = 当前可用孔数，null = 空孔。
     * 孔来源 = 品阶基础孔 + 升阶每次 +3 + 青铜材料开孔 + 水晶开孔。
     */
    sockets?: (ElementId | null)[];
    /** 已用水晶开出的额外孔数（用于 UI 显示与上限判断） */
    openedSlots?: number;
}

/**
 * 四部位穿戴状态：每个部位指向一个 OwnedArmor.uid。
 * 缺失的字段 = 该部位未穿戴。
 */
export interface ArmorWorn {
    head?: string;
    body?: string;
    pants?: string;
    shoes?: string;
}

/**
 * 关卡档案 —— 继承机制的载体。
 * 键 = (levelId, difficulty)，通关时用当次结束数据覆盖写入。
 */
export interface LevelArchive {
    levelId: number;
    /** 这份档案属于哪一档难度 */
    difficulty: number;
    loadout: {
        /** 通关时的关卡内资源 */
        resources: AttrMap;
        /** 通关时的关卡内属性 */
        stats: AttrMap;
        /**
         * 通关时的全部装备（武器 + 辅助装备）与局内进化形态。
         * 每一项的 kind 区分武器槽还是辅助槽，formId 记录进化到了哪个形态。
         *
         * 注意：进化本身"只在局内发生"，它的结果通过档案被封存下来，
         * 复玩时看广告即可恢复到当时的状态；
         * 而进入更高难度时会被**默认免费继承**（见 LevelFlow.openLevel）。
         */
        equipment: EquipRunState[];
        /**
         * 通关时的天赋层数。
         * 天赋也随档案封存 —— 否则复玩要重新点二十次天赋，那不是挑战是折磨。
         */
        talents?: Record<string, number>;
    };
    /**
     * 这份档案是在多少复玩加难百分比下打出来的。
     * 它的意义是：玩家看到自己的纪录时，知道那是"加了 50% 难度"拿到的，
     * 而不是误以为自己变强了。
     */
    boostPercent?: number;
    lastScore: number;
    bestScore: number;
    lastTime: number;
    bestTime: number;
    clearCount: number;
    clearedAt: number;
}

/** 单局运行态 */
export interface LevelState {
    levelId: number;
    /** 本次开局选择的难度层级 */
    difficulty: number;
    runId: string;
    resources: AttrMap;
    stats: AttrMap;
    /**
     * 本局的完整 build：武器槽 / 辅助槽 / 天赋 / 待补选 / 待选三张卡。
     *
     * 上一版这里是扁平的 `equipment: EquipRunState[]`，
     * 因为当时只有武器一种东西要管；现在有三类成长，必须分开装。
     */
    loadout: RunLoadoutState;
    /** 本局启用的复玩加难设置 */
    replay: ReplayBoost;
    score: number;
    elapsed: number;
    /** 击杀数 */
    kills: number;
    cleared: boolean;
    /** 本次开局是否继承了装备 */
    carried: boolean;
    /**
     * 继承来源：
     *   'archive'  同难度的档案（看广告继承）
     *   'lowerTier' 更低难度通关时的数据（默认免费继承）
     *   'none'      没有继承
     */
    carrySource: 'none' | 'archive' | 'lowerTier';
    updatedAt: number;
}

/** 关卡配置（策划表一行，已按难度缩放） */
export interface LevelConfigItem {
    levelId: number;
    /** 本次配置对应的难度层级 */
    difficulty: number;
    /** 该难度的完整定义，方便 UI 直接读名字与配色 */
    diff: DifficultyDef;
    /** 本局应用的复玩加难百分比，0 = 未加难。已并入下面的血量/攻击数值 */
    replayBoost: number;
    /** 该关的刷怪阵型 */
    formation: FormationKind;
    /**
     * 该关的属性池：前期 1 种，越往后复合的属性越多。
     * 每只敌人从这里按轮转取一个属性，于是同一关会出现多种属性的敌人。
     */
    elements: ElementId[];
    /** 该关的推荐武器 id（用它们打有伤害与金币加成） */
    affinityWeaponIds: string[];
    /** 该关的克制武器 id（用它们打会被削弱） */
    weakWeaponIds: string[];
    enemies: number;
    baseEnemyHp: number;
    baseEnemyAtk: number;
    /** 每只敌人提供的经验值 */
    expPerEnemy: number;
    /** 通关后发放的永久金币，用于局外升级装备（已乘难度倍率） */
    goldReward: number;
    reward: AttrMap;
    initialResources: AttrMap;
    initialStats: AttrMap;

    // ---- 战斗层参数（拖动走位玩法需要）----
    /** 敌人移动速度（像素/秒） */
    enemySpeed: number;
    /** 敌人攻击间隔（秒） */
    enemyAtkInterval: number;
    /** 敌人碰撞半径 */
    enemyRadius: number;
    /** 每批生成多少只 */
    batchSize: number;
    /** 每批之间的间隔秒数 */
    batchInterval: number;

    // ---- 远程怪参数（难度越高越多）----
    /** 远程怪占全部敌人的比例 */
    rangedRatio: number;
    /** 远程怪血量倍率（比近战脆，鼓励优先点掉） */
    rangedHpMul: number;
    /** 远程怪移速倍率 */
    rangedSpeedMul: number;
    /** 远程怪保持间距 */
    kiteRange: number;
    /** 远程弹丸速度 */
    shotSpeed: number;
    /** 远程弹丸伤害（绝对值） */
    shotAtk: number;
    /** 远程射击间隔（秒） */
    shotInterval: number;

    // ---- 噩梦专有三种（普通 / 困难 为 0，所以不会刷出）----
    /** 精英怪比例：高血低速 + 护盾，是持续压力源 */
    eliteRatio: number;
    /** 高速突进怪比例：贴脸比 melee 还快，是短期爆发 */
    swiftRatio: number;
    /** 冲锋怪比例：蓄力后朝玩家方向冲刺 */
    chargerRatio: number;
}

/** 带签名的存档封装 */
export interface SignedPayload<T> {
    data: T;
    sig: string;
    ts: number;
}
