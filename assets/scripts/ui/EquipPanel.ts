/**
 * 局外装备面板（背包 / 主界面）
 *
 * 【这一层负责什么】
 *   - 展示每件装备的局外等级与基础伤害
 *   - 消耗永久金币升级装备 → 直接抬高 computePower 的 baseDamage
 *   - 切换出战装备（决定关卡内哪些装备会获得经验、参与进化）
 *
 * 【出战槽位随难度增长】
 *   普通 2 件 / 困难 3 件 / 噩梦 4 件（见 DifficultyConfig.getEquipSlotCount）。
 *   槽位不是单纯的数值增长 —— 多带一件等于多一种瞄准方式同时生效，
 *   所以面板上必须把"还差什么才能解锁下一个槽位"说清楚。
 *
 * 【这一层不负责什么】
 *   进化。进化只发生在关卡内（由局内三选一触发），这里只做"路线预览"：
 *   告诉玩家这件武器在关卡里能变成什么、能跟谁合成，制造进关期待。
 *
 * 预制体节点结构建议：
 *   EquipPanel (本脚本)
 *   ├── GoldLabel   Label —— "金币 1240"
 *   ├── SlotLabel   Label —— "出战 2 / 3　通关更高难度可解锁第 3 个槽位"
 *   ├── List        Node（VerticalLayout）
 *   ├── ItemPrefab  Prefab
 *   │   ├── NameLabel    Label
 *   │   ├── LevelLabel   Label —— "Lv.3 · 基础伤害 22"
 *   │   ├── EvolveLabel  Label —— 局内路线 + 可参与的合成
 *   │   ├── UpgradeBtn   Button
 *   │   │   └── CostLabel Label —— "升级 500"
 *   │   └── SelectBtn    Button
 *   │       └── StateLabel Label —— "出战" / "已出战"
 *   └── CloseBtn    Button
 *
 * 【升级消耗参考】每关发放的永久金币约 (90 + 关卡×22) × 难度倍率，
 * 复玩时按 60% 折算，所以升满一件装备需要反复刷几关 —— 这是复玩的另一个动机。
 */

import { _decorator, Component, Label, Node, instantiate, Prefab, Button } from 'cc';
import { EquipmentManager, getMaxEquipped, isSlotMaxed } from '../core/EquipmentManager';
import { SaveManager } from '../core/SaveManager';
import { describeUnlock, getEquipDef, getLevelConf } from '../data/EquipmentConfig';
import {
    advancedTailOf, branchesOf, fusionsInvolving, mainLineOf,
} from '../core/FormGraph';
import { getForm } from '../data/FormConfig';
import { EQUIP_SLOT_LIMIT } from '../data/DifficultyConfig';
import { OwnedEquipment } from '../data/GameTypes';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

@ccclass('EquipPanel')
export class EquipPanel extends Component {
    @property(Label) goldLabel: Label = null!;
    @property(Node) list: Node = null!;
    @property(Prefab) itemPrefab: Prefab = null!;
    @property(Node) closeBtn: Node = null!;
    /** 出战槽位提示，如"出战 2/3 · 通关困难可解锁第 3 槽位" */
    @property(Label) slotLabel: Label = null!;

    onLoad(): void {
        this.closeBtn?.on(Node.EventType.TOUCH_END, this.hide, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.closeBtn?.off(Node.EventType.TOUCH_END, this.hide, this);
    }

    public show(): void {
        this.node.active = true;
        this.rebuild();

        // 第十轮：首次打开装备面板解释局外升级
        TutorialLayer.showTipById('tip_equip');
    }

    private hide(): void {
        this.node.active = false;
    }

    /** 重建整个装备列表 */
    public rebuild(): void {
        if (!this.list || !this.itemPrefab) return;

        const p = SaveManager.getProfile();
        const slotMax = getMaxEquipped();
        if (this.goldLabel) {
            this.goldLabel.string = '金币 ' + p.gold;
        }
        if (this.slotLabel) {
            this.slotLabel.string = '出战 ' + p.equippedIds.length + ' / ' + slotMax +
                (isSlotMaxed()
                    ? '　槽位已全部解锁'
                    : '　通关更高难度可解锁第 ' + (slotMax + 1) + ' 个槽位（上限 ' + EQUIP_SLOT_LIMIT + '）');
        }

        this.list.removeAllChildren();
        for (const owned of p.equipment) {
            const node = instantiate(this.itemPrefab);
            node.name = 'Equip_' + owned.id;
            this.applyItem(node, owned);
            this.list.addChild(node);
        }
    }

    private applyItem(node: Node, owned: OwnedEquipment): void {
        const def = getEquipDef(owned.id);
        if (!def) return;

        const conf = getLevelConf(def, owned.level);
        const aimName = def.aimMode !== undefined ? '　' + describeAim(def.aimMode) : '';

        const nameLabel = node.getChildByName('NameLabel')?.getComponent(Label);
        if (nameLabel) nameLabel.string = def.name + aimName;

        const levelLabel = node.getChildByName('LevelLabel')?.getComponent(Label);
        if (levelLabel) {
            levelLabel.string = 'Lv.' + owned.level + ' / ' + def.maxLevel +
                '　基础伤害 ' + conf.baseDamage;
        }

        // 路线预览：让玩家知道"这件武器在关卡里能变成什么、能跟谁合成"
        const evolveLabel = node.getChildByName('EvolveLabel')?.getComponent(Label);
        if (evolveLabel) {
            evolveLabel.string = this.buildRouteText(owned.id) + '　' + describeUnlock(def);
        }

        // 升级按钮
        const upgradeBtn = node.getChildByName('UpgradeBtn')?.getComponent(Button);
        const costLabel = node
            .getChildByName('UpgradeBtn')?.getChildByName('CostLabel')?.getComponent(Label);
        if (upgradeBtn) {
            const cost = EquipmentManager.getUpgradeCost(owned.id);
            const isMax = cost < 0;
            const affordable = !isMax && SaveManager.getProfile().gold >= cost;

            upgradeBtn.interactable = affordable;
            if (costLabel) {
                costLabel.string = isMax ? '已满级' : '升级 ' + cost;
            }
            upgradeBtn.node.off(Node.EventType.TOUCH_END);
            upgradeBtn.node.on(Node.EventType.TOUCH_END, () => {
                if (EquipmentManager.upgrade(owned.id)) {
                    this.rebuild();   // 升级成功后整表刷新（金币、伤害、消耗都变了）
                }
            }, this);
        }

        // 出战切换
        const selectBtn = node.getChildByName('SelectBtn')?.getComponent(Button);
        const stateLabel = node
            .getChildByName('SelectBtn')?.getChildByName('StateLabel')?.getComponent(Label);
        if (selectBtn) {
            const equipped = SaveManager.getProfile().equippedIds;
            const isOn = equipped.indexOf(owned.id) >= 0;
            if (stateLabel) stateLabel.string = isOn ? '已出战' : '出战';

            selectBtn.node.off(Node.EventType.TOUCH_END);
            selectBtn.node.on(Node.EventType.TOUCH_END, () => {
                this.toggleEquip(owned.id, isOn);
            }, this);
        }
    }

    /**
     * 切换出战状态。
     * 出战上限随全局最高难度增长（普通 2 / 困难 3 / 噩梦 4），
     * 超出的自动顶掉最早的一件。
     */
    private toggleEquip(equipId: string, isOn: boolean): void {
        const cur = EquipmentManager.getEquippedIds();
        const max = getMaxEquipped();
        let next: string[];

        if (isOn) {
            // 取消出战：至少要留一件，否则进关后连攻击手段都没有
            if (cur.length <= 1) {
                console.warn('[Equip] 至少需要保留一件出战装备');
                return;
            }
            next = cur.filter((id) => id !== equipId);
        } else {
            next = cur.concat([equipId]);
            if (next.length > max) {
                // 超出上限则顶掉最早出战的那件
                next = next.slice(next.length - max);
            }
        }

        EquipmentManager.setEquipped(next);
        this.rebuild();
    }

    /**
     * 生成这件武器的局内路线预览：
     *   "局内路线：铁剑 → 裂空剑 → 剑雨风暴　合成：铁剑 + 短弓 = 剑雨风暴"
     *
     * 只报**名称**，不报逐层百分比 —— 面板上数字太多反而没人看，
     * 玩家真正需要知道的是"这条路通到哪、能跟谁合"。
     */
    private buildRouteText(equipId: string): string {
        const line = mainLineOf(equipId);
        const names: string[] = [];
        for (const id of line) {
            const f = getForm(id);
            if (f) names.push(f.name);
        }

        const parts: string[] = [];
        if (names.length > 1) parts.push('局内路线：' + names.join(' → '));

        // depth 1 的分支（同层另一条线），玩家看得到才会去尝试
        const branchNames: string[] = [];
        for (const e of branchesOf(equipId)) {
            const f = getForm(e.to);
            if (f) branchNames.push(f.name);
        }
        if (branchNames.length > 0) parts.push('分支：' + branchNames.join(' / '));

        // 这条线上任何一层能参与的合成，全都列出来（含它是材料 B 的情况）
        const recipes: string[] = [];
        for (const r of fusionsInvolving(line)) {
            const a = getForm(r.a);
            const b = getForm(r.b);
            const t = getForm(r.to);
            if (!a || !b || !t) continue;
            recipes.push(a.name + ' + ' + b.name + ' = ' + t.name + (r.advanced ? '（复玩）' : ''));
        }
        if (recipes.length > 0) parts.push('合成：' + recipes.join('，'));

        // 复玩限定：主线末端还挂着更上级进化，这是"再打一次"的最好理由
        const tail = advancedTailOf(equipId);
        if (tail) {
            const t = getForm(tail.to);
            if (t) parts.push('★复玩（带老档）解锁更上级：' + t.name);
        }

        return parts.join('　');
    }
}

/** 瞄准方式中文名（避免为了一个字符串再引一次 GameTypes 枚举表） */
function describeAim(mode: number): string {
    const names = ['前向', '锁定', '移动向', '最近', '全屏'];
    return names[mode] || '未知';
}
