/**
 * 辅助装备配置表
 *
 * 【辅助装备与武器的分工】
 *
 *   武器     改变"怎么打" —— 攻击形状（单体/贯穿/范围/全屏）与瞄准方式（前向/锁定/自动）
 *   辅助装备 改变"打得多快多稳" —— 攻速 / 暴击 / 吸血 / 护盾 / 反伤 / 经验 / 弹道数
 *
 * 两者叠加成一份 CombatModifier 交给战斗层，于是新增一件辅助装备
 * 不需要动战斗逻辑一行 —— 这是把效果做成纯数据表的目的。
 *
 * 【关键规则：辅助装备的进化**永远不消耗槽位**】
 *
 *   这是玩家明确要求的："这种就不会消失辅助装备"。
 *   所以本文件里所有进化边都是 'upgrade' 类型，一条 'fusion' 都没有。
 *   槽位消耗只发生在武器侧的合成进化上。
 *
 * 【局外等级】
 *   辅助装备没有局外等级 —— 它是纯局内的 build 组件，
 *   消耗的是"这一局的成长机会"（三选一），而不是永久金币。
 *   于是它的成长曲线可以做得比武器更陡，因为它每局都要重新挣。
 */

import { AttackModeId, AuxEffect, FormNode, InnateAttribute } from './GameTypes';

/**
 * 辅助装备的作用方式统一走"自动攻击最近目标"。
 * 它们本身是挂件而不是主力，所以攻击形状固定为远程单体，
 * 主要价值在 effect 上而不在伤害上。
 */
const AUX_ATTACK_MODE = AttackModeId.SINGLE_RANGED;
const AUX_ATTACK_TEXT = '挂件射击';

function aux(
    id: string,
    name: string,
    depth: number,
    desc: string,
    atkPct: number,
    effect: AuxEffect,
    evolveTo: FormNode['evolveTo'] = [],
    extra?: {
        /** 第八轮：原生品阶（0~6） */
        rarity?: number;
        /** 第八轮：自带复合属性 */
        innate?: InnateAttribute;
    }
): FormNode {
    return {
        id,
        name,
        kind: 'aux',
        desc,
        equipType: 'aux',
        sources: [],
        depth,
        atkPct,
        rangePct: 0,
        attackModeId: AUX_ATTACK_MODE,
        attackModeText: AUX_ATTACK_TEXT,
        effect,
        rarity: extra && extra.rarity !== undefined ? extra.rarity : 0,
        innate: extra ? extra.innate : undefined,
        evolveTo,
    };
}

function up(to: string, label: string, desc: string): FormNode['evolveTo'][number] {
    return { to, type: 'upgrade', label, desc };
}

/** 所有辅助装备的根形态 id —— 这些才是"可以在一局里被抽到"的装备 */
export const AUX_ROOT_IDS: string[] = [
    'aux_thorn', 'aux_blood', 'aux_greaves', 'aux_scope',
    'aux_aegis', 'aux_hourglass', 'aux_tome', 'aux_repeater',
    // 第八轮：高阶专属辅助（直接以高品阶出生）
    'aux_dragonheart', 'aux_astralring',
    'aux_phoenixplume', 'aux_abysseye',
    'aux_origincore', 'aux_chronogear',
];

/**
 * 辅助装备形态表。
 * 每件的 depth 1 有两条分支，depth 2 是终局 —— 和武器一样是树，不是链。
 */
export const AUX_FORMS: FormNode[] = [
    // ---------------------------------------------------------- 荆棘甲
    aux('aux_thorn', '荆棘甲', 0, '被近战击中时反弹伤害，受到伤害时也在输出', 0,
        { thorns: 6, maxHpFlat: 20 }, [
            up('aux_thorn_iron', '玄铁荆棘', '大幅提高反伤与生命上限，站着挨打也能清怪'),
            up('aux_thorn_blaze', '烈焰荆棘', '反伤略低但附带攻击加成，攻守一体'),
        ]),
    aux('aux_thorn_iron', '玄铁荆棘', 1, '荆棘 +15 · 生命 +45', 0.05,
        { thorns: 15, maxHpFlat: 45 }, [
            up('aux_thorn_bastion', '荆棘堡垒', '荆棘 +34 · 生命 +100 · 护盾 +30'),
        ]),
    aux('aux_thorn_blaze', '烈焰荆棘', 1, '荆棘 +14 · 攻击 +8%', 0.08,
        { thorns: 14, atkPct: 0.08 }, [
            up('aux_thorn_inferno', '炼狱荆棘', '荆棘 +32 · 攻击 +18%'),
        ]),
    aux('aux_thorn_bastion', '荆棘堡垒', 2, '荆棘 +34 · 生命 +100 · 护盾 +30', 0.10,
        { thorns: 34, maxHpFlat: 100, shield: 30 }),
    aux('aux_thorn_inferno', '炼狱荆棘', 2, '荆棘 +32 · 攻击 +18%', 0.18,
        { thorns: 32, atkPct: 0.18 }),

    // ---------------------------------------------------------- 泣血戒
    aux('aux_blood', '泣血戒', 0, '造成伤害时按比例回复生命', 0,
        { lifesteal: 0.04 }, [
            up('aux_blood_deep', '深红之戒', '吸血更稳，同时提高攻击'),
            up('aux_blood_frenzy', '狂血之戒', '吸血略低但攻速显著提升'),
        ]),
    aux('aux_blood_deep', '深红之戒', 1, '吸血 9% · 攻击 +6%', 0.06,
        { lifesteal: 0.09, atkPct: 0.06 }, [
            up('aux_blood_eternal', '永恒血契', '吸血 18% · 攻击 +14%'),
        ]),
    aux('aux_blood_frenzy', '狂血之戒', 1, '吸血 7% · 攻速 +12%', 0.04,
        { lifesteal: 0.07, atkSpeedPct: 0.12 }, [
            up('aux_blood_carnage', '屠戮血契', '吸血 14% · 攻速 +28%'),
        ]),
    aux('aux_blood_eternal', '永恒血契', 2, '吸血 18% · 攻击 +14%', 0.14,
        { lifesteal: 0.18, atkPct: 0.14 }),
    aux('aux_blood_carnage', '屠戮血契', 2, '吸血 14% · 攻速 +28%', 0.10,
        { lifesteal: 0.14, atkSpeedPct: 0.28 }),

    // ---------------------------------------------------------- 疾行靴
    aux('aux_greaves', '疾行靴', 0, '提高移动速度，走位更容易拉开距离', 0,
        { moveSpeedPct: 0.08 }, [
            up('aux_greaves_swift', '迅捷之靴', '极致移速，配合射程打游击'),
            up('aux_greaves_phantom', '幻影之靴', '移速与攻速兼顾'),
        ]),
    aux('aux_greaves_swift', '迅捷之靴', 1, '移速 +16%', 0,
        { moveSpeedPct: 0.16 }, [
            up('aux_greaves_gale', '疾风战靴', '移速 +30% · 攻击距离 +10%'),
        ]),
    aux('aux_greaves_phantom', '幻影之靴', 1, '移速 +12% · 攻速 +10%', 0,
        { moveSpeedPct: 0.12, atkSpeedPct: 0.10 }, [
            up('aux_greaves_wraith', '幽影战靴', '移速 +24% · 攻速 +22%'),
        ]),
    aux('aux_greaves_gale', '疾风战靴', 2, '移速 +30% · 攻击距离 +10%', 0,
        { moveSpeedPct: 0.30, rangePct: 0.10 }),
    aux('aux_greaves_wraith', '幽影战靴', 2, '移速 +24% · 攻速 +22%', 0,
        { moveSpeedPct: 0.24, atkSpeedPct: 0.22 }),

    // ---------------------------------------------------------- 鹰眼镜
    aux('aux_scope', '鹰眼镜', 0, '提高暴击率', 0,
        { critRate: 0.06 }, [
            up('aux_scope_falcon', '隼之瞳', '暴击率与暴击伤害同时提升'),
            up('aux_scope_precise', '精准之瞳', '暴击率与基础攻击同时提升，收益更稳'),
        ]),
    aux('aux_scope_falcon', '隼之瞳', 1, '暴击 12% · 暴伤 ×2.2', 0,
        { critRate: 0.12, critMul: 2.2 }, [
            up('aux_scope_doom', '灭世之瞳', '暴击 24% · 暴伤 ×2.8'),
        ]),
    aux('aux_scope_precise', '精准之瞳', 1, '暴击 10% · 攻击 +8%', 0.08,
        { critRate: 0.10, atkPct: 0.08 }, [
            up('aux_scope_omen', '天启之瞳', '暴击 20% · 攻击 +20%'),
        ]),
    aux('aux_scope_doom', '灭世之瞳', 2, '暴击 24% · 暴伤 ×2.8', 0,
        { critRate: 0.24, critMul: 2.8 }),
    aux('aux_scope_omen', '天启之瞳', 2, '暴击 20% · 攻击 +20%', 0.20,
        { critRate: 0.20, atkPct: 0.20 }),

    // ---------------------------------------------------------- 圣盾符
    aux('aux_aegis', '圣盾符', 0, '开局获得护盾，护盾优先承受伤害', 0,
        { shield: 25, maxHpFlat: 20 }, [
            up('aux_aegis_bulwark', '壁垒符', '护盾极厚，适合硬吃伤害的打法'),
            up('aux_aegis_ward', '生灵符', '生命上限大幅提升，续航更稳'),
        ]),
    aux('aux_aegis_bulwark', '壁垒符', 1, '护盾 +70 · 生命 +60', 0,
        { shield: 70, maxHpFlat: 60 }, [
            up('aux_aegis_fortress', '不动堡垒', '护盾 +170 · 生命 +150'),
        ]),
    aux('aux_aegis_ward', '生灵符', 1, '护盾 +45 · 生命 +110', 0,
        { shield: 45, maxHpFlat: 110 }, [
            up('aux_aegis_sanctuary', '圣域', '护盾 +120 · 生命 +280 · 吸血 6%'),
        ]),
    aux('aux_aegis_fortress', '不动堡垒', 2, '护盾 +170 · 生命 +150', 0,
        { shield: 170, maxHpFlat: 150 }),
    aux('aux_aegis_sanctuary', '圣域', 2, '护盾 +120 · 生命 +280 · 吸血 6%', 0,
        { shield: 120, maxHpFlat: 280, lifesteal: 0.06 }),

    // ---------------------------------------------------------- 时砂漏
    aux('aux_hourglass', '时砂漏', 0, '提高攻击速度', 0,
        { atkSpeedPct: 0.10 }, [
            up('aux_hourglass_rapid', '疾时砂漏', '极致攻速，适合高频武器'),
            up('aux_hourglass_steady', '恒时砂漏', '攻速与攻击兼顾，任何武器都不亏'),
        ]),
    aux('aux_hourglass_rapid', '疾时砂漏', 1, '攻速 +22%', 0,
        { atkSpeedPct: 0.22 }, [
            up('aux_hourglass_timeless', '无尽时序', '攻速 +45%'),
        ]),
    aux('aux_hourglass_steady', '恒时砂漏', 1, '攻速 +14% · 攻击 +10%', 0.10,
        { atkSpeedPct: 0.14, atkPct: 0.10 }, [
            up('aux_hourglass_eternal', '永恒时序', '攻速 +30% · 攻击 +22%'),
        ]),
    aux('aux_hourglass_timeless', '无尽时序', 2, '攻速 +45%', 0,
        { atkSpeedPct: 0.45 }),
    aux('aux_hourglass_eternal', '永恒时序', 2, '攻速 +30% · 攻击 +22%', 0.22,
        { atkSpeedPct: 0.30, atkPct: 0.22 }),

    // ---------------------------------------------------------- 智慧书
    aux('aux_tome', '智慧书', 0, '提高经验获取，更快触发三选一', 0,
        { expPct: 0.12 }, [
            up('aux_tome_scholar', '学者之书', '纯经验流，滚雪球最快'),
            up('aux_tome_war', '征伐战记', '经验与攻击兼顾'),
        ]),
    aux('aux_tome_scholar', '学者之书', 1, '经验 +28%', 0,
        { expPct: 0.28 }, [
            up('aux_tome_omniscient', '全知之书', '经验 +60%'),
        ]),
    aux('aux_tome_war', '征伐战记', 1, '经验 +18% · 攻击 +8%', 0.08,
        { expPct: 0.18, atkPct: 0.08 }, [
            up('aux_tome_conquest', '征伐战记·极', '经验 +40% · 攻击 +18%'),
        ]),
    aux('aux_tome_omniscient', '全知之书', 2, '经验 +60%', 0,
        { expPct: 0.60 }),
    aux('aux_tome_conquest', '征伐战记·极', 2, '经验 +40% · 攻击 +18%', 0.18,
        { expPct: 0.40, atkPct: 0.18 }),

    // ---------------------------------------------------------- 连装匣
    aux('aux_repeater', '连装匣', 0, '每次攻击额外发射一条弹道', 0,
        { extraShots: 1 }, [
            up('aux_repeater_double', '双连装匣', '继续堆弹道数量'),
            up('aux_repeater_wide', '广域装匣', '弹道与射程兼顾，覆盖面更广'),
        ]),
    aux('aux_repeater_double', '双连装匣', 1, '额外弹道 +2', 0,
        { extraShots: 2 }, [
            up('aux_repeater_myriad', '万连装匣', '额外弹道 +4'),
        ]),
    aux('aux_repeater_wide', '广域装匣', 1, '额外弹道 +1 · 攻击距离 +15%', 0,
        { extraShots: 1, rangePct: 0.15 }, [
            up('aux_repeater_horizon', '地平装匣', '额外弹道 +3 · 攻击距离 +30%'),
        ]),
    aux('aux_repeater_myriad', '万连装匣', 2, '额外弹道 +4', 0,
        { extraShots: 4 }),
    aux('aux_repeater_horizon', '地平装匣', 2, '额外弹道 +3 · 攻击距离 +30%', 0,
        { extraShots: 3, rangePct: 0.30 }),

    // ================================================================
    // 第八轮：高阶专属辅助装备（钻石 / 史诗 / 神话 各 2 件）
    //
    // 【为什么它们也没有进化线】
    //   与高阶专属武器同一条理由：常规辅助靠 depth 0→2 的形态进化成长，
    //   专属辅助靠**品阶倍率 + 自带复合属性**成长。
    //   再挂一条进化线会让"辅助要不要进化"变成第三个决策，没必要。
    //
    // 【effect 的取值逻辑】
    //   专属辅助给的都是**复合效果**（两三条一起给），
    //   而常规辅助只给一条主效果。这是"高阶"最直观的体感：
    //   一件顶常规两件的覆盖面。
    // ================================================================

    // ---- 钻石 ----
    aux('aux_dragonheart', '龙心坠', 0, '【钻石】龙族心脏凝成的吊坠，搏斗中持续回血', 0.08,
        { lifesteal: 0.06, maxHpFlat: 70, atkPct: 0.08 }, [], {
            rarity: 3,
            innate: { elements: ['dragon', 'combat'], bonus: { lifesteal: 0.02, maxHpFlat: 30 } },
        }),
    aux('aux_astralring', '星轨戒指', 0, '【钻石】环上刻着一整条星轨，攻击自带预判', 0.06,
        { critRate: 0.08, critMul: 2.3, rangePct: 0.10 }, [], {
            rarity: 3,
            innate: { elements: ['space', 'flying'], bonus: { critRate: 0.03, rangePct: 0.05 } },
        }),

    // ---- 史诗 ----
    aux('aux_phoenixplume', '凤凰羽', 0, '【史诗】燃尽的凤凰之羽，受创后反而更强', 0.10,
        { lifesteal: 0.09, atkPct: 0.12, thorns: 12 }, [], {
            rarity: 4,
            innate: { elements: ['fire', 'flying'], bonus: { atkPct: 0.06, thorns: 6 } },
        }),
    aux('aux_abysseye', '深渊之眼', 0, '【史诗】注视着深渊的眼，攻速与经验一同疯长', 0.08,
        { atkSpeedPct: 0.20, expPct: 0.22, critRate: 0.06 }, [], {
            rarity: 4,
            innate: { elements: ['ghost', 'devil'], bonus: { atkSpeedPct: 0.06, critRate: 0.03 } },
        }),

    // ---- 神话 ----
    aux('aux_origincore', '本源核心', 0, '【神话】世界初始凝成的一块，全维度同时提升', 0.15,
        { atkPct: 0.15, atkSpeedPct: 0.15, critRate: 0.10, expPct: 0.20 }, [], {
            rarity: 5,
            innate: { elements: ['normal', 'light'], bonus: { atkPct: 0.08, critRate: 0.04, rangePct: 0.05 } },
        }),
    aux('aux_chronogear', '时序齿轮', 0, '【神话】咬合着时间的齿轮，弹道与连锁同时增加', 0.12,
        { extraShots: 2, chainBonus: 2, atkSpeedPct: 0.18, pierceResist: 0.10 }, [], {
            rarity: 5,
            innate: { elements: ['time', 'machine'], bonus: { extraShots: 1, atkSpeedPct: 0.06 } },
        }),
];
