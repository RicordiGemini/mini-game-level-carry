/**
 * 装备管理器 —— 局外等级 + 局内形态 + 战力计算
 *
 * 【两层状态的生命周期】
 *
 *   局外等级（OwnedEquipment，存 PlayerProfile）
 *     └ 永久。消耗 gold 升级，不随关卡重置消失，也永远不需要看广告。
 *       它只作用于**武器**：辅助装备与天赋是纯局内的，没有局外等级。
 *
 *   局内形态（EquipRunState，存 RunLoadoutState）
 *     └ 只在本次闯关内产生。开局按"是否继承"决定初始形态，
 *       打怪累积经验推动形态进化（由 RunLoadout 负责），通关后随档案封存。
 *
 * 【战力为什么分两个口子算】
 *
 *   computePower()  汇总成**一份**给 HUD 看的数字（总伤害、主攻击方式）
 *   buildWeapons()  **每件武器独立**开火，各自带自己的瞄准方式与打的形状
 *
 * 两件武器同时按各自的瞄准方式攻击（前向挥砍 + 锁定射击 + 全屏横扫），
 * 手感是叠加的，所以真正的战力必须按武器分别算，
 * HUD 那个数字只是给玩家一个粗略的强弱感知。
 *
 * 【关卡适配乘在哪里】
 *   适配倍率乘在**单件武器**的伤害上，而不是乘总值 ——
 *   这样"带一把推荐 + 一把克制"才会正确地互相抵消，
 *   而不是让整队一起吃惩罚。
 */

import {
    AimModeId,
    AIM_MODE_TEXT,
    AttackModeId,
    AttrMap,
    CombatModifier,
    CombatPower,
    EquipRunState,
    EquipmentDef,
    InnateBonus,
    OwnedEquipment,
    RunLoadoutState,
} from '../data/GameTypes';
import {
    EQUIPMENT_TABLE,
    EQUIP_TYPE_TEXT,
    STARTER_EQUIP_IDS,
    getBaseInterval,
    getBasePierce,
    getBaseRange,
    getEquipDef,
    getLevelConf,
    getUnlockedEquipIds,
    getUpgradeCost,
    isEquipUnlocked,
} from '../data/EquipmentConfig';
import { ATTACK_MODE_TEXT, formLevelOf, getForm, getRootForm } from '../data/FormConfig';
import { EQUIP_SLOT_LIMIT, getEquipSlotCount } from '../data/DifficultyConfig';
import { normalizeRarity, rarityPowerMul } from '../data/RarityConfig';
import { WeaponSpec } from '../battle/BattleTypes';
import { SaveManager } from './SaveManager';
import { socketBonusOf, socketsOf } from './ForgeManager';
import { aimOf, resolveFormId } from './FormGraph';
import { formLevelAtkPct } from './RunLoadout';

/**
 * 局外可同时出战的武器数量上限。
 *
 * 随全局最高难度增长：普通 2 件 / 困难 3 件 / 噩梦 4 件。
 * 注意它和**局内武器槽上限**（RunConfig.WEAPON_SLOT_BASE = 6）是两回事：
 *   局外 2~4 件 = 你带着什么武器进场
 *   局内 6~8 槽 = 你在一局里最多能攒到几件
 * 前者是难度回报，后者是局内成长空间，两者相乘才是一局的完整规模。
 */
export function getMaxEquipped(): number {
    return getEquipSlotCount(SaveManager.getGlobalMaxTier());
}

/** 槽位是否已全部解锁（用于 UI 提示"提升难度可解锁更多槽位"） */
export function isSlotMaxed(): boolean {
    return getMaxEquipped() >= EQUIP_SLOT_LIMIT;
}

/** 模块内取品阶（避免每次写 SaveManager 样板） */
function ownedRarityOf(equipId: string): number {
    return EquipmentManager.rarityOf(equipId);
}

/** 模块内取自带属性加成 */
function innateBonusOfWeapon(equipId: string): InnateBonus {
    return EquipmentManager.innateBonusOf(equipId);
}

/** 模块内取自带属性元素列表 */
function innateElementsOfWeapon(equipId: string): string[] {
    return EquipmentManager.innateElementsOf(equipId);
}

export class EquipmentManager {
    // ================================================================
    // 局外：武器持有与升级（永久）
    // ================================================================

    /**
     * 校准玩家武器列表。
     * 每次启动、以及每次难度/关卡解锁后调用一次：
     *   1. 新号赠送唯一一把初始武器（blade）
     *   2. **不再按进度自动发放** —— 其余武器一律靠抽卡获得（见 GachaManager）
     *   3. 保证 equippedIds 有效且不超上限（上限随难度增长）
     *
     * 【第七轮的语义变化：从"解锁即发放"到"解锁只是进池条件"】
     *
     *   以前这里会调getUnlockedEquipIds(unlockedLevel, globalMaxTier)
     *   把满足条件的武器全部 push 进档案。现在**这一步被整条删掉了** ——
     *   武器的唯一来源是抽卡。
     *
     *   为什么可以安全删除，而不是留个开关：
     *     -老玩家档案里已有的武器会原样保留（这行代码只增不减，
     *       删除的是"新增"逻辑，不碰存量）
     *     - 自动发放与抽卡并存会导致玩家永远抽到重复件：
     *       打一关自动得长枪，再抽又得长枪，抽卡系统当场失去意义
     *
     *   所以现在 getUnlockedEquipIds 仍然保留，但用途变成了
     *   "展示解锁条件"（见 describeUnlock），不再驱动发放。
     */
    static syncProfile(): void {
        const p = SaveManager.getProfile();
        if (!p.equipment) p.equipment = [];
        if (!p.equippedIds) p.equippedIds = [];

        const ownedIds = p.equipment.map((e) => e.id);
        const grant = (id: string) => {
            if (ownedIds.indexOf(id) >= 0) return;
            p.equipment.push({ id, level: 1 });
            ownedIds.push(id);
            console.log('[Equip] 获得新武器:', id);
        };

        const slotMax = getMaxEquipped();

        for (const id of STARTER_EQUIP_IDS) grant(id);

        // 过滤掉配置表里已删除的武器，避免老存档报错
        p.equipment = p.equipment.filter((e) => getEquipDef(e.id) !== null);
        if (p.equipment.length === 0) {
            p.equipment.push({ id: STARTER_EQUIP_IDS[0], level: 1 });
        }

        p.equippedIds = p.equippedIds.filter(
            (id) => getEquipDef(id) !== null && p.equipment.some((e) => e.id === id)
        );
        if (p.equippedIds.length === 0) {
            p.equippedIds = p.equipment.slice(0, slotMax).map((e) => e.id);
        }
        // 解锁了更多槽位时自动补满，让玩家立刻感受到"难度推进的回报"
        if (p.equippedIds.length < slotMax) {
            for (const e of p.equipment) {
                if (p.equippedIds.length >= slotMax) break;
                if (p.equippedIds.indexOf(e.id) < 0) p.equippedIds.push(e.id);
            }
        }
        if (p.equippedIds.length > slotMax) {
            p.equippedIds = p.equippedIds.slice(0, slotMax);
        }

        SaveManager.saveProfile(p);
    }

    static getOwnedList(): OwnedEquipment[] {
        return SaveManager.getProfile().equipment;
    }

    static getLevel(equipId: string): number {
        const owned = SaveManager.getProfile().equipment.find((e) => e.id === equipId);
        return owned ? owned.level : 1;
    }

    /** 升到下一级需要的金币，-1 表示已满级 */
    static getUpgradeCost(equipId: string): number {
        const def = getEquipDef(equipId);
        if (!def) return -1;
        return getUpgradeCost(def, this.getLevel(equipId));
    }

    static canUpgrade(equipId: string): boolean {
        const cost = this.getUpgradeCost(equipId);
        if (cost < 0) return false;
        return SaveManager.getProfile().gold >= cost;
    }

    /**
     * 消耗永久金币升级武器。
     * 这是"局外加基础伤害"的实现点 —— 升级后所有用到这条武器线的形态
     * （含它的进化形态与合成产物）基础伤害都会变大。
     */
    static upgrade(equipId: string): boolean {
        const def = getEquipDef(equipId);
        if (!def) return false;
        const cost = this.getUpgradeCost(equipId);
        if (cost < 0) return false;

        const p = SaveManager.getProfile();
        if (p.gold < cost) return false;

        const owned = p.equipment.find((e) => e.id === equipId);
        if (!owned) return false;

        p.gold -= cost;
        owned.level += 1;
        SaveManager.saveProfile(p);

        const conf = getLevelConf(def, owned.level);
        console.log('[Equip] ' + def.name + ' 升级到 Lv.' + owned.level +
            '，基础伤害 ' + conf.baseDamage);
        return true;
    }

    /** 全部已拥有武器的基础伤害总和（不含关卡内加成） */
    static getOutGameBaseDamage(): number {
        let sum = 0;
        for (const e of SaveManager.getProfile().equipment) {
            const def = getEquipDef(e.id);
            if (!def) continue;
            sum += getLevelConf(def, e.level).baseDamage;
        }
        return sum;
    }

    /**
     * 取某件局外武器当前的基础伤害。
     * 合成形态会用 sources 里的每一件分别求和，所以这里只负责单件。
     */
    static baseDamageOf(equipId: string): number {
        const def = getEquipDef(equipId);
        if (!def) return 0;
        return getLevelConf(def, this.getLevel(equipId)).baseDamage;
    }

    /** 一个形态的基础伤害 = 它所有来源武器的基础伤害之和 */
    static baseDamageOfForm(sources: string[]): number {
        let sum = 0;
        for (const id of sources) sum += this.baseDamageOf(id);
        return sum;
    }

    static getEquippedIds(): string[] {
        return SaveManager.getProfile().equippedIds.slice();
    }

    /** 切换出战武器，件数上限随全局最高难度增长 */
    static setEquipped(ids: string[]): void {
        const p = SaveManager.getProfile();
        const valid = ids.filter(
            (id) => getEquipDef(id) !== null && p.equipment.some((e) => e.id === id)
        );
        p.equippedIds = valid.slice(0, getMaxEquipped());
        SaveManager.saveProfile(p);
    }

    /** 判断一件武器是否已解锁（关卡进度 AND 难度进度） */
    static isUnlocked(equipId: string): boolean {
        const def = getEquipDef(equipId);
        if (!def) return false;
        const p = SaveManager.getProfile();
        return isEquipUnlocked(def, p.unlockedLevel, SaveManager.getGlobalMaxTier());
    }

    // ================================================================
    // 局内：战斗参数生成
    // ================================================================

    /**
     * 生成本局的每件武器战斗参数。
     *
     * 只有武器形态开火 —— 辅助装备只通过 CombatModifier 生效，
     * 它们不消耗弹药也不占打击节奏，这是"辅助"两个字的字面意思。
     *
     * @param levelStats  关卡内属性表，其中的 atk 作为 flat 加成平摊到各武器
     * @param mod         天赋 + 辅助装备汇总出来的战斗修正
     * @param affinityMul 关卡武器适配倍率（推荐 ×1.25 / 克制 ×0.8）
     */
    static buildWeapons(
        loadout: RunLoadoutState,
        levelStats: AttrMap,
        mod: CombatModifier,
        affinityMul = 1
    ): WeaponSpec[] {
        const weapons = loadout.weapons || [];
        const n = Math.max(1, weapons.length);
        const levelFlatAtk = levelStats['atk'] ?? 0;
        const out: WeaponSpec[] = [];

        for (const st of weapons) {
            const form = getForm(resolveFormId(st));
            if (!form || form.kind !== 'weapon') continue;

            // 合成产物继承**材料第一件**的镶嵌属性。
            // 因为它吃的是两把武器的局外等级收益，属性也该跟着材料走 ——
            // 否则玩家精心镶的属性会在合成那一刻凭空消失。
            const rootId = form.sources.length > 0 ? form.sources[0] : form.id;
            const elements = socketBonusOf(rootId);
            const elAtkPct = elements.atkPct || 0;
            const elSpeedPct = elements.atkSpeedPct || 0;
            const elRangePct = elements.rangePct || 0;
            const elExtraShots = elements.extraShots || 0;
            const elPierce = elements.pierce || 0;
            const elChain = elements.chain || 0;
            const elPierceResist = elements.pierceResist || 0;
            const elHighHp = elements.highHpDmg || 0;

            /**
             * 第八轮：品阶倍率与自带复合属性。
             *
             * 品阶倍率乘在**基础伤害**上而不是最终伤害上 ——
             * 乘基础伤害意味着它与形态 atkPct、天赋、镶嵌全部是乘算关系，
             * 任何一条线变强都能正确叠加；若乘在最终值上会出现
             * "暴击吃两次倍率"这类难以解释的复合。
             *
             * 自带属性（钻石及以上专属装备才有）与镶嵌属性**分开求和**：
             * 一个是装备天生的、升阶自动继承；一个是玩家自己镶的、可以卸下。
             * 两者都是 atkPct 类的加值，所以直接相加，但语义上必须分清来源 ——
             * UI 上要能分别显示"自带"和"镶嵌"，否则玩家卸下镶嵌后会困惑
             * "为什么属性没归零"。
             */
            const rarity = ownedRarityOf(rootId);
            const rarityMul = rarityPowerMul(rarity);
            const innate = innateBonusOfWeapon(rootId);

            const base = (this.baseDamageOfForm(form.sources) + levelFlatAtk / n) * rarityMul;
            const atkPct = form.atkPct + formLevelAtkPct(st.exp) + mod.atkPct +
                elAtkPct + (innate.atkPct || 0);
            const damage = Math.max(1, Math.round(base * (1 + atkPct) * affinityMul));

            const rangeMul = 1 + form.rangePct + mod.rangePct + elRangePct +
                (innate.rangePct || 0);
            const speedMul = 1 + mod.atkSpeedPct + elSpeedPct + (innate.atkSpeedPct || 0);
            const aim = aimOf(form);

            out.push({
                equipId: rootId,
                formId: form.id,
                name: form.name,
                type: form.equipType === 'aux' ? 'blade' : form.equipType,
                depth: form.depth,
                aimMode: aim,
                attackModeId: form.attackModeId,
                damage,
                range: Math.round(getBaseRange(form.equipType) * rangeMul),
                interval: getBaseInterval(form.equipType) / Math.max(0.2, speedMul),
                // 金属 / 龙 属性让贯穿武器多穿一个（镶嵌 + 自带）
                pierce: getBasePierce(form.equipType) + elPierce,
                // 虫属性增加连锁跳数
                chainBonus: elChain,
                // 石 / 时间属性无视目标抗性（对玩家侧也生效，见 BattleSetup）
                pierceResist: elPierceResist + (innate.pierceResist || 0),
                // 龙属性对高血量敌人加伤
                highHpDmg: elHighHp + (innate.highHpDmg || 0),
                aimText: form.aimModeText || AIM_MODE_TEXT[aim],
                critRate: mod.critRate + (elements.critRate || 0) + (innate.critRate || 0),
                critMul: mod.critMul,
                lifesteal: mod.lifesteal + (elements.lifesteal || 0) + (innate.lifesteal || 0),
                extraShots: mod.extraShots + elExtraShots + (innate.extraShots || 0),
                elements: socketsOf(rootId),
                // 第八轮：品阶与自带属性的元素列表（UI 与克制面板展示用）
                rarity,
                innateElements: innateElementsOfWeapon(rootId),
            });
        }
        return out;
    }

    /**
     * 汇总成一份给 HUD 看的战力。
     *
     * 与 buildWeapons 的区别：这里把全部武器的伤害加总成一个数字，
     * 攻击方式取"层级最高"的那件（玩家最直观的那把）。
     * 注意攻击方式取的是**方式文案**（近战单体 / 全屏剑雨），不是武器名 ——
     * 这个字段会被 HUD 与结算页直接读去做"我这一局是怎么打的"的说明。
     */
    static computePower(
        loadout: RunLoadoutState,
        levelStats: AttrMap,
        mod: CombatModifier,
        affinityMul = 1
    ): CombatPower {
        const weapons = this.buildWeapons(loadout, levelStats, mod, affinityMul);

        let totalDamage = 0;
        let bestDepth = -1;
        let bestModeId: AttackModeId = weapons.length > 0
            ? weapons[0].attackModeId : AttackModeId.SINGLE_MELEE;
        let bestAim: AimModeId = weapons.length > 0 ? weapons[0].aimMode : AimModeId.FRONT;
        let baseSum = 0;

        for (const w of weapons) {
            totalDamage += w.damage;
            baseSum += this.baseDamageOfForm(
                (getForm(w.formId) || { sources: [] }).sources
            );
            if (w.depth > bestDepth) {
                bestDepth = w.depth;
                bestModeId = w.attackModeId;
                bestAim = w.aimMode;
            }
        }

        return {
            baseDamage: Math.round(baseSum),
            atkPct: Number(mod.atkPct.toFixed(4)),
            rangeMul: Number((1 + mod.rangePct).toFixed(4)),
            finalDamage: totalDamage,
            attackModeId: bestModeId,
            attackModeText: ATTACK_MODE_TEXT[bestModeId] || '近战单体',
            aimModeId: bestAim,
            aimModeText: AIM_MODE_TEXT[bestAim],
        };
    }

    // ================================================================
    // UI 辅助
    // ================================================================

    /**
     * 取某把武器的自带复合属性加成（第八轮）。
     *
     * 【与镶嵌属性的分工】
     *   innate  装备天生就有，来自配置表，升阶自动继承，不需要材料
     *   sockets 玩家自己镶的，可以卸下退还
     * 两者在战斗里都是加值，但来源必须分清 —— UI 上分开显示，
     * 否则玩家卸下镶嵌后会困惑"为什么属性没归零"。
     *
     * 注意这里**不乘品阶倍率**：自带属性的数值已经在配置表里按品阶配好了
     * （钻石给 0.12、神话给 0.20），再乘一次倍率会双重放大。
     */
    static innateBonusOf(equipId: string): InnateBonus {
        const f = getRootForm(equipId);
        if (!f || !f.innate) return {};
        return f.innate.bonus;
    }

    /** 某把武器自带的属性元素列表（展示与克制面板用） */
    static innateElementsOf(equipId: string): string[] {
        const f = getRootForm(equipId);
        if (!f || !f.innate) return [];
        return f.innate.elements.slice();
    }

    /** 某把武器的品阶（未持有返回 0） */
    static rarityOf(equipId: string): number {
        const owned = SaveManager.getProfile().equipment.find((e) => e.id === equipId);
        return owned ? normalizeRarity(owned.rarity === undefined ? 0 : owned.rarity) : 0;
    }

    /** 生成"淬锋剑（攻击 +60% · 前向 · Lv.2）"这类展示文案 */
    static describeSlot(st: EquipRunState): string {
        const form = getForm(resolveFormId(st));
        if (!form) return st.id;
        const lv = formLevelOf(st.exp);
        const aim = AIM_MODE_TEXT[aimOf(form)];
        const parts: string[] = [];
        if (form.atkPct) parts.push('攻击 +' + Math.round(form.atkPct * 100) + '%');
        parts.push(aim);
        if (lv > 1) parts.push('Lv.' + lv);
        return form.name + '（' + parts.join(' · ') + '）';
    }

    /** 全部武器定义（装备界面遍历用） */
    static allDefs(): EquipmentDef[] {
        return EQUIPMENT_TABLE;
    }

    /** 武器类型的中文名 */
    static typeText(t: string): string {
        return (EQUIP_TYPE_TEXT as Record<string, string>)[t] || t;
    }
}
