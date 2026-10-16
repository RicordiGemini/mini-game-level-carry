/**
 * 锻造面板 —— 突破 / 镶嵌 / 碎片合成 / 防具，主界面手动打开
 *
 * 【为什么这四件事要放在一个面板里】
 *
 *   它们共用同一份资源（材料背包、碎片背包），也共用同一个决策：
 *   "我现在手上这点东西，该先突破铁剑还是先凑十块暗蚀碎片？"
 *   拆成四个面板等于让玩家在四个界面之间来回算账。
 *
 *   面板按这个顺序排布，就是玩家做决策的顺序：
 *     武器突破 → 属性镶嵌 → 碎片合成 → 防具
 *
 * 【这个面板里没有"看广告"按钮】
 *
 *   玩家原话："看广告可以直接拿完整的, 不看广告在每个地图可以有单独属性的材料碎片,
 *             十个合成一个完整的"，以及"不做任何强制性的必须看广告才可以拿到的升级材料"。
 *
 *   所以这里刻意**不提供**广告按钮 —— 属性材料 100% 靠碎片合成，
 *   广告加速只在结算页作为一个可选入口存在。
 *   把广告从"必经流程"里彻底拿掉，是这轮最重要的一条实现约束。
 *
 * 预制体节点结构建议：
 *   ForgePanel (本脚本, 默认 active = false)
 *   ├── TitleLabel       Label —— "锻造台"
 *   ├── WeaponTitleLabel Label —— 当前武器的等阶与槽位
 *   ├── WeaponBodyLabel  Label —— 升级 / 突破需求 / 槽位状态 / 与本关属性的匹配
 *   ├── RankBtn (Button) —— 突破
 *   ├── UpgradeBtn       —— 局外升级（金币）
 *   ├── PrevBtn (Button) —— 上一把武器
 *   ├── NextBtn (Button) —— 下一把武器
 *   ├── ShardTitleLabel  Label —— "属性碎片（10 个合成 1 个完整）"
 *   ├── ShardLabel       Label —— 24 种属性的碎片进度 + 完整材料数
 *   ├── CraftBtn (Button)—— 合成当前选中属性的完整材料
 *   ├── PrevElBtn        —— 上一种属性
 *   ├── NextElBtn        —— 下一种属性
 *   ├── OmniBtn (Button) —— 合成全属性石
 *   ├── ArmorTitleLabel  Label —— "防具"
 *   ├── ArmorLabel       Label —— 已拥有 / 已穿戴的防具与抗性（防具第九轮起改为抽卡获取）
 *   ├── OmniLineRoot (Node)  —— 第十一轮「万象线」区块（★ 隐藏：仅 omniVisible() 时 active）
 *   │   ├── OmniLineLabel Label —— 阶段 / 下一级消耗 / 能否升阶
 *   │   └── OmniLineBtn (Button) —— 升一级万象线（满级的那次发放整套万象套）
 *   └── CloseBtn (Button)—— 关闭
 */

import { _decorator, Component, Label, Node } from 'cc';
import { SaveManager } from '../core/SaveManager';
import { EquipmentManager } from '../core/EquipmentManager';
import {
    advanceOmni,
    armorBonus,
    armorRarityOf,
    armorSlotCap,
    armorSocketsOf,
    ascendArmor,
    ascendArmorPreview,
    ascendWeapon,
    ascendWeaponPreview,
    canCraftOmni,
    canSocketArmor,
    craftElement,
    craftOmni,
    counterBreakOfWeapon,
    currentResist,
    forgeOf,
    materialBag,
    omniPreview,
    openArmorSlot,
    openArmorSlotMaterial,
    ownedArmors,
    shardBag,
    shardsNeededFor,
    shardStone,
    shardElement,
    socketArmorElement,
    socketCapOf,
    stoneBag,
    socketElement,
    unsocket,
    unsocketArmor,
    wearArmorPart,
    unwearArmorPart,
} from '../core/ForgeManager';
import {
    ELEMENT_IDS,
    resistedBy,
    countersOf,
    elementName,
    elementsForLevel,
    getElementDef,
    levelElementText,
    resistText,
    ResistMap,
    ElementBonus,
} from '../data/ElementConfig';
import {
    allArmorPieces,
    ARMOR_PARTS,
    ARMOR_PART_TEXT,
    ARMOR_SETS,
    armorResistText,
    getArmorDef,
    getArmorSet,
    ArmorPart,
    ArmorPieceDef,
} from '../data/ArmorConfig';
import {
    materialForType,
    MYTH_CORE_ID,
    OMNI_STONE_ID,
    omniStoneName,
    mythCoreName,
    SHARDS_PER_STONE,
} from '../data/MaterialConfig';
import {
    ascendCopiesOf, ascendGoldOf, ascendNeedsCore, describeAscend, describeRarity,
    getRarity, isMaxRarity, normalizeRarity, rarityPowerMul, raritySockets, RARITY_COUNT,
} from '../data/RarityConfig';
import { getEquipDef, STARTER_EQUIP_IDS } from '../data/EquipmentConfig';
import { ElementId, OwnedArmor } from '../data/GameTypes';
import { elementDamageMul } from '../data/ElementConfig';
import { elementRelationText } from './CounterPanel';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

/** 面板当前状态（静态，便于测试直接读取而不必走 UI） */
interface ForgePanelState {
    weaponIndex: number;
    elIndex: number;
    toast: string;
}

@ccclass('ForgePanel')
export class ForgePanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) weaponTitleLabel: Label = null!;
    @property(Label) weaponBodyLabel: Label = null!;
    @property(Node) rankBtn: Node = null!;
    @property(Node) upgradeBtn: Node = null!;
    @property(Node) prevBtn: Node = null!;
    @property(Node) nextBtn: Node = null!;
    @property(Label) shardTitleLabel: Label = null!;
    @property(Label) shardLabel: Label = null!;
    @property(Node) craftBtn: Node = null!;
    @property(Node) prevElBtn: Node = null!;
    @property(Node) nextElBtn: Node = null!;
    @property(Node) omniBtn: Node = null!;
    @property(Label) armorTitleLabel: Label = null!;
    @property(Label) armorLabel: Label = null!;
    /** 第十一轮：万象线区块（隐藏线，仅 omniVisible() 时显示） */
    @property(Node) omniLineRoot: Node = null!;
    @property(Label) omniLineLabel: Label = null!;
    @property(Node) omniLineBtn: Node = null!;
    @property(Node) closeBtn: Node = null!;

    private _st: ForgePanelState = { weaponIndex: 0, elIndex: 0, toast: '' };
    /** 连点保护：突破与合成都会写档，重复点击会连续扣材料 */
    private _busy = false;

    // ------------------------------------------------------------ 生命周期

    onLoad(): void {
        this.rankBtn?.on(Node.EventType.TOUCH_END, this.onRank, this);
        this.upgradeBtn?.on(Node.EventType.TOUCH_END, this.onUpgrade, this);
        this.prevBtn?.on(Node.EventType.TOUCH_END, this.onPrevWeapon, this);
        this.nextBtn?.on(Node.EventType.TOUCH_END, this.onNextWeapon, this);
        this.craftBtn?.on(Node.EventType.TOUCH_END, this.onCraft, this);
        this.prevElBtn?.on(Node.EventType.TOUCH_END, this.onPrevElement, this);
        this.nextElBtn?.on(Node.EventType.TOUCH_END, this.onNextElement, this);
        this.omniBtn?.on(Node.EventType.TOUCH_END, this.onCraftOmni, this);
        this.omniLineBtn?.on(Node.EventType.TOUCH_END, this.onAdvanceOmni, this);
        this.closeBtn?.on(Node.EventType.TOUCH_END, this.close, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.rankBtn?.off(Node.EventType.TOUCH_END, this.onRank, this);
        this.upgradeBtn?.off(Node.EventType.TOUCH_END, this.onUpgrade, this);
        this.prevBtn?.off(Node.EventType.TOUCH_END, this.onPrevWeapon, this);
        this.nextBtn?.off(Node.EventType.TOUCH_END, this.onNextWeapon, this);
        this.craftBtn?.off(Node.EventType.TOUCH_END, this.onCraft, this);
        this.prevElBtn?.off(Node.EventType.TOUCH_END, this.onPrevElement, this);
        this.nextElBtn?.off(Node.EventType.TOUCH_END, this.onNextElement, this);
        this.omniBtn?.off(Node.EventType.TOUCH_END, this.onCraftOmni, this);
        this.omniLineBtn?.off(Node.EventType.TOUCH_END, this.onAdvanceOmni, this);
        this.closeBtn?.off(Node.EventType.TOUCH_END, this.close, this);
    }

    public open(startEquipId?: string): void {
        const ids = this.ownedWeaponIds();
        const i = startEquipId ? ids.indexOf(startEquipId) : -1;
        this._st = { weaponIndex: i >= 0 ? i : 0, elIndex: 0, toast: '' };
        this.node.active = true;
        this.refresh();

        // 第十轮：首次打开锻造面板解释突破/镶嵌/合成/防具
        TutorialLayer.showTipById('tip_forge');
    }

    public close(): void {
        this.node.active = false;
    }

    // ------------------------------------------------------------ 交互

    private onPrevWeapon(): void {
        const ids = this.ownedWeaponIds();
        if (ids.length === 0) return;
        this._st.weaponIndex = (this._st.weaponIndex - 1 + ids.length) % ids.length;
        this.refresh();
    }

    private onNextWeapon(): void {
        const ids = this.ownedWeaponIds();
        if (ids.length === 0) return;
        this._st.weaponIndex = (this._st.weaponIndex + 1) % ids.length;
        this.refresh();
    }

    private onPrevElement(): void {
        this._st.elIndex = (this._st.elIndex - 1 + ELEMENT_IDS.length) % ELEMENT_IDS.length;
        this.refresh();
    }

    private onNextElement(): void {
        this._st.elIndex = (this._st.elIndex + 1) % ELEMENT_IDS.length;
        this.refresh();
    }

    /** 升阶当前武器（第八轮起取代"突破"） */
    onRank(): void {
        if (this._busy) return;
        const id = this.currentWeapon();
        if (!id) return;
        const r = ascendWeapon(id);
        this._st.toast = r.ok ? '升阶成功' : ('升阶失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 局外升级（金币）—— 与突破并列，玩家完全可以只升一把 */
    onUpgrade(): void {
        if (this._busy) return;
        const id = this.currentWeapon();
        if (!id) return;
        const ok = EquipmentManager.upgrade(id);
        this._st.toast = ok ? '升级成功' : '升级失败：金币不足或已满级';
        this.refresh();
    }

    /** 合成当前属性的完整材料（10 碎片） */
    onCraft(): void {
        const e = ELEMENT_IDS[this._st.elIndex];
        const r = craftElement(e);
        this._st.toast = r.ok ? ('合成 ' + elementName(e) + '石 成功') : ('合成失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 合成全属性石（24 种碎片各 10） */
    onCraftOmni(): void {
        const r = craftOmni();
        this._st.toast = r.ok ? '全属性石 合成成功' : ('合成失败：' + (r.reason || ''));
        this.refresh();
    }

    /**
     * 升一级「万象线」（第十一轮）。
     * 满级那一次会一次性发放整套万象套，所以升级后顺手把提醒标记掉。
     */
    onAdvanceOmni(): void {
        if (this._busy) return;
        this._busy = true;
        const r = advanceOmni();
        if (r.ok) {
            this._st.toast = omniPreview().owned
                ? '★ 万象套 四件已到手'
                : ('万象线 → ' + omniPreview().name);
        } else {
            this._st.toast = '万象线升级失败：' + (r.reason || '');
        }
        this.refresh();
        this._busy = false;
    }

    /** 把当前选中的属性材料镶进第一个空槽 */
    onSocket(): void {
        const id = this.currentWeapon();
        if (!id) return;
        const e = ELEMENT_IDS[this._st.elIndex];
        const forge = forgeOf(id);
        const slot = forge.sockets.findIndex((s) => !s);
        if (slot < 0) {
            this._st.toast = '没有空槽位了，先突破提升等阶';
            this.refresh();
            return;
        }
        const r = socketElement(id, slot, e);
        this._st.toast = r.ok ? ('镶嵌 ' + elementName(e) + ' 成功') : ('镶嵌失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 卸下第 slot 个镶嵌（退还完整材料） */
    onUnsocket(slot: number): void {
        const id = this.currentWeapon();
        if (!id) return;
        const r = unsocket(id, slot);
        this._st.toast = r.ok ? '已卸下（材料已退还）' : ('卸下失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 穿某部位的防具（uid 必须属于该部位） */
    onWearPart(part: ArmorPart, uid: string): void {
        const r = wearArmorPart(part, uid);
        this._st.toast = r.ok ? '已穿上半部位防具' : ('穿戴失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 脱下某部位 */
    onUnwearPart(part: ArmorPart): void {
        const r = unwearArmorPart(part);
        this._st.toast = r.ok ? '已脱下该部位' : ('脱下失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 升阶某件防具（消耗同阶同部件 + 金币） */
    onAscendArmor(uid: string): void {
        const r = ascendArmor(uid);
        this._st.toast = r.ok ? '防具升阶成功' : ('升阶失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 用许愿水晶开一个额外孔位 */
    onOpenArmorSlot(uid: string): void {
        const r = openArmorSlot(uid);
        this._st.toast = r.ok ? '开孔成功' : ('开孔失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 用突破材料开孔（仅青铜防具） */
    onOpenArmorSlotByMat(uid: string, matId: string): void {
        const r = openArmorSlotMaterial(uid, matId);
        this._st.toast = r.ok ? '材料开孔成功' : ('开孔失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 把当前选中的属性石镶进某件防具的某个空槽 */
    onSocketArmor(uid: string): void {
        const owned = ownedArmors().find((a) => a.uid === uid);
        if (!owned) return;
        const socks = owned.sockets || [];
        const idx = socks.findIndex((s) => !s);
        if (idx < 0) {
            this._st.toast = '该防具没有空槽，先开孔或卸下';
            this.refresh();
            return;
        }
        const e = ELEMENT_IDS[this._st.elIndex];
        const r = socketArmorElement(uid, idx, e);
        this._st.toast = r.ok ? ('镶嵌 ' + elementName(e) + ' 成功') : ('镶嵌失败：' + (r.reason || ''));
        this.refresh();
    }

    // ------------------------------------------------------------ 刷新

    private ownedWeaponIds(): string[] {
        const p = SaveManager.getProfile();
        const ids = p.equipment.map((e) => e.id).filter((id) => !!getEquipDef(id));
        return ids.length > 0 ? ids : STARTER_EQUIP_IDS.slice();
    }

    currentWeapon(): string {
        return this.ownedWeaponIds()[this._st.weaponIndex] || '';
    }

    currentElement(): ElementId {
        return ELEMENT_IDS[this._st.elIndex];
    }

    private refresh(): void {
        const gold = SaveManager.getProfile().gold;

        if (this.titleLabel) {
            this.titleLabel.string = '锻造台　金币 ' + gold +
                (this._st.toast ? '　｜　' + this._st.toast : '');
        }
        this.refreshWeapon(gold);
        this.refreshShards();
        this.refreshArmor();
        this.refreshOmniLine();
    }

    /**
     * 万象线区块（第十一轮）。
     *
     * 【隐藏逻辑】整块由 `omniPreview().visible` 控制：
     *   未开始 / 没有全属性石 / 材料不够合成 → 整块 `active = false`，玩家看不到这条线。
     *   一旦满足条件就永久显示（stage 只增不减）。
     */
    private refreshOmniLine(): void {
        const v = omniPreview();
        if (this.omniLineRoot) this.omniLineRoot.active = v.visible;
        if (!v.visible) return;
        if (this.omniLineLabel) {
            const lines: string[] = [];
            lines.push('万象线　' + v.stage + ' / ' + v.maxStage + '　' + v.name);
            if (v.owned) {
                lines.push('★ 已集齐「万象套」四件（传说 · 24 轴抗性）');
            } else {
                lines.push('下一级需要：全属性石 ×' + v.stoneNeed +
                    '（现有 ' + v.stoneHave + '）　金币 ' + v.goldNeed);
                lines.push(v.canAdvance ? '★ 可以升阶' : ('暂不可升阶：' + v.reason));
            }
            this.omniLineLabel.string = lines.join('\n');
        }
        // 满级后把按钮置灰（Node 的 active 与按钮态由场景决定，这里只保证不会误点）
        if (this.omniLineBtn) this.omniLineBtn.active = !v.owned;
    }

    private refreshWeapon(gold: number): void {
        const ids = this.ownedWeaponIds();
        const id = ids[this._st.weaponIndex] || '';
        const def = getEquipDef(id);

        if (!def) {
            if (this.weaponTitleLabel) this.weaponTitleLabel.string = '还没有武器';
            if (this.weaponBodyLabel) this.weaponBodyLabel.string = '';
            return;
        }

        const forge = forgeOf(id);
        const rarity = normalizeRarity(
            SaveManager.getProfile().equipment.find((e) => e.id === id)?.rarity ?? 0
        );
        const slots = raritySockets(rarity);
        const mat = materialForType(def.type);
        const asc = ascendWeaponPreview(id);
        const have = materialBag()[mat.id] || 0;
        const goldNeed = asc.maxed ? 0 : asc.gold;
        // 入参也叫 gold（玩家当前余额），这里改名避免遮蔽
        const goldNow = SaveManager.getProfile().gold;
        const lv = EquipmentManager.getLevel(id);
        const upCost = EquipmentManager.getUpgradeCost(id);

        if (this.weaponTitleLabel) {
            this.weaponTitleLabel.string =
                def.name + '　(' + (this._st.weaponIndex + 1) + '/' + ids.length + ')' +
                '　Lv.' + lv + '　' + describeRarity(rarity) + '　镶嵌位 ' + slots;
        }

        const lines: string[] = [];

        // 局外升级（金币 + 材料）—— 玩家可以把所有钱砸在这一把上
        lines.push('【局外升级】Lv.' + lv + (upCost < 0 ? '（已满级）' :
            ' → Lv.' + (lv + 1) + '　需金币 ' + upCost + '　← 全部升级给一把武器也支持'));

        if (asc.maxed) {
            lines.push('【升阶】已是最高品阶（传说）　强度 ×' +
                rarityPowerMul(rarity).toFixed(2));
        } else {
            lines.push('【升阶】' + describeRarity(rarity) + ' → ' + describeRarity(rarity + 1));
            lines.push('　需同阶装备 ' + asc.have + '/' + asc.need +
                '　金币 ' + goldNow + '/' + goldNeed);
            if (asc.needCore) {
                lines.push('　还需专属材料：' + mythCoreName() + ' ' +
                    (materialBag()[MYTH_CORE_ID] || 0) + '/1' +
                    '（仅三复合关卡噩梦难度掉落）');
            }
            lines.push('　' + describeAscend(rarity));
        }

        lines.push('【镶嵌】共 ' + slots + ' 个槽位');
        for (let i = 0; i < slots; i++) {
            const s = forge.sockets[i];
            lines.push('　' + (i + 1) + '. ' +
                (s ? getElementDef(s).name + '　' + getElementDef(s).effectText : '（空）'));
        }

        const lvId = SaveManager.getProfile().unlockedLevel;
        lines.push('【第 ' + lvId + ' 关】属性 ' + levelElementText(lvId) +
            '　' + ForgePanel.matchText(id, lvId));

        if (this.weaponBodyLabel) this.weaponBodyLabel.string = lines.join('\n');
    }

    private refreshShards(): void {
        const e = ELEMENT_IDS[this._st.elIndex];
        const def = getElementDef(e);
        const have = shardBag()[shardShardKey(e)] || 0;
        const owned = stoneBag()[shardStoneKey(e)] || 0;
        const need = shardsNeededFor(e);

        if (this.shardTitleLabel) {
            this.shardTitleLabel.string =
                '属性碎片　' + def.name + '　[' + def.group + '组]（' +
                (this._st.elIndex + 1) + '/' + ELEMENT_IDS.length + '）　' + def.desc;
        }

        const lines: string[] = [];
        lines.push('碎片 ' + have + '/' + SHARDS_PER_STONE +
            (need > 0 ? '　还差 ' + need + ' 个' : '　★可以合成') +
            '　完整材料 ×' + owned);
        lines.push('镶嵌效果　' + def.effectText);
        lines.push('克制本关：' + this.matchLine());
        // 24 种属性下把完整的克制/被克名单直接摊开 ——
        // 这个规模已经不可能靠记忆，只能查。
        const cs = countersOf(e);
        const rs = resistedBy(e);
        lines.push('克制：' + (cs.length ? cs.map(elementName).join('、') : '无'));
        lines.push('被克：' + (rs.length ? rs.map(elementName).join('、') : '无'));

        const omni = stoneBag()[OMNI_STONE_ID] || 0;
        lines.push('全属性石 ×' + omni +
            (canCraftOmni() ? '　★可以合成全属性石' : '　需 24 种碎片各 ' + SHARDS_PER_STONE + ' 个'));

        if (this.shardLabel) this.shardLabel.string = lines.join('\n');
    }

    private refreshArmor(): void {
        const p = SaveManager.getProfile();
        const worn = p.armor ? p.armor.worn : null;
        const cur = currentResist();
        const bonus = armorBonus();

        // 第十轮：首次看到防具（四部位套装）时解释套装与专属词条
        TutorialLayer.showTipById('tip_armor');

        if (this.armorTitleLabel) {
            this.armorTitleLabel.string = '防具 · 四部位套装　当前抗性：' + resistText(cur) +
                '　套装增益：' + bonusText(bonus);
        }

        const lines: string[] = [];

        // 四部位当前穿戴
        lines.push('【当前穿戴（头/身/裤/鞋）】');
        let anyWorn = false;
        for (const part of ARMOR_PARTS) {
            const uid = worn ? worn[part] : undefined;
            if (!uid) {
                lines.push('　' + ARMOR_PART_TEXT[part] + '：［空］');
                continue;
            }
            anyWorn = true;
            const o = ownedArmors().find((a) => a.uid === uid);
            const def = o ? getArmorDef(o.id) : null;
            if (!o || !def) {
                lines.push('　' + ARMOR_PART_TEXT[part] + '：［数据异常］');
                continue;
            }
            lines.push('　' + ARMOR_PART_TEXT[part] + '：' + def.name + '　' +
                describeRarity(normalizeRarity(o.rarity)) + '　抗性 ' + armorResistText(def.resist) +
                '　孔 ' + (o.sockets || []).length);
        }
        if (!anyWorn) lines.push('　（暂无穿戴，点已拥有的防具可穿上任一部位）');

        // 已拥有的防具实例
        const owned = ownedArmors();
        if (owned.length > 0) {
            lines.push('【已拥有防具】');
            for (const o of owned) {
                const def = getArmorDef(o.id);
                if (!def) continue;
                const isWorn = worn ? worn[def.part] === o.uid : false;
                const asc = ascendArmorPreview(o.uid);
                const cap = armorSlotCap(o);
                const sockets = o.sockets || [];
                let ascText: string;
                if (asc.maxed) ascText = '　［已至传说］';
                else ascText = '　升阶→' + describeRarity(asc.rarity + 1) +
                    ' 需同阶 ' + asc.have + '/' + asc.need + ' 金币' + asc.gold;
                lines.push((isWorn ? '［穿戴中］' : '［已拥有］') + ' ' + def.name + '　' +
                    describeRarity(normalizeRarity(o.rarity)) +
                    '　抗性 ' + armorResistText(def.resist) + ascText +
                    '\n　　槽位 ' + sockets.length + '/' + cap + '（水晶/材料可开孔）');
            }
        } else {
            lines.push('（防具通过防具抽卡池获取，抽到的重复件可作为升阶燃料）');
        }

        lines.push('双轨：抗性（减伤）＋ 专属词条 ＋ 套装属性（2件小套 / 4件大套）＋ 镶嵌属性石。点条目可穿/脱/升阶/开孔。');

        if (this.armorLabel) this.armorLabel.string = lines.join('\n');
    }

    // ------------------------------------------------------------ 实例工具

    /** 当前镶嵌对"当前进度关卡"的匹配说明（碎片区里那一行） */
    private matchLine(): string {
        const id = this.currentWeapon();
        if (!id) return '—';
        const lv = SaveManager.getProfile().unlockedLevel;
        return ForgePanel.matchText(id, lv);
    }

    // ------------------------------------------------------------ 静态工具（测试直接调）

    /** 当前武器镶嵌的属性对某关属性的匹配说明 */
    static matchText(equipId: string, levelId: number): string {
        const els = socketsOfSafe(equipId);
        const levelEls = elementsForLevel(Math.max(1, levelId));
        if (els.length === 0) return '未镶嵌（全部 ×1.00）';
        const parts: string[] = [];
        for (const le of levelEls) {
            parts.push(elementName(le) + ' ×' + elementDamageMul(els, le).toFixed(2));
        }
        return parts.join('　');
    }

    /** 某关会掉哪些属性的碎片 */
    static levelShardText(levelId: number): string {
        return levelElementText(levelId);
    }

    /** 当前生效的总抗性文案 */
    static resistNow(): string {
        return resistText(currentResist());
    }

    /** 全部 24 种属性的相性速查（锻造台"查看全部相性"） */
    static relationTable(): string[] {
        return elementRelationText();
    }

    /** 某把武器当前的破防比例（无视克制） */
    static breakOf(equipId: string): number {
        return counterBreakOfWeapon(equipId);
    }

    /** 突破 / 合成是否受连点保护（测试用来确认防抖存在） */
    get busy(): boolean {
        return this._busy;
    }
}

// ====================================================================
// 辅助
// ====================================================================

function socketsOfSafe(equipId: string): ElementId[] {
    return forgeOf(equipId).sockets.filter((x): x is ElementId => !!x);
}

/** 把套装增益（ElementBonus）压成一行可读文案 */
function bonusText(b: ElementBonus): string {
    const names: string[] = [];
    if (b.atkPct) names.push('攻+' + Math.round(b.atkPct * 100) + '%');
    if (b.atkSpeedPct) names.push('攻速+' + Math.round(b.atkSpeedPct * 100) + '%');
    if (b.critRate) names.push('暴击+' + Math.round(b.critRate * 100) + '%');
    if (b.critMul) names.push('爆伤+' + Math.round(b.critMul * 100) + '%');
    if (b.extraShots) names.push('连射+' + Math.round(b.extraShots * 100) + '%');
    if (b.lifesteal) names.push('吸血+' + Math.round(b.lifesteal * 100) + '%');
    if (b.moveSpeedPct) names.push('移速+' + Math.round(b.moveSpeedPct * 100) + '%');
    if (b.maxHpFlat) names.push('血+' + Math.round(b.maxHpFlat));
    if (b.pierce) names.push('穿透+' + b.pierce);
    if (b.chain) names.push('连锁+' + b.chain);
    return names.length ? names.join(' ') : '无（未凑齐套装）';
}

/** 碎片袋的 key */
export function shardShardKey(e: ElementId): string {
    return shardElement(e);
}

/** 完整材料袋的 key */
export function shardStoneKey(e: ElementId): string {
    return shardStone(e);
}