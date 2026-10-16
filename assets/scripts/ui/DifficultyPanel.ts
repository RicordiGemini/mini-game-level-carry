/**
 * 难度选择面板
 *
 * 点击关卡后弹出，列出该关的三档难度。
 *
 * 预制体节点结构建议：
 *   DifficultyPanel (本脚本, 默认 active = false)
 *   ├── TitleLabel   Label —— "第 3 关 · 选择难度"
 *   ├── List         Node（VerticalLayout）
 *   ├── ItemPrefab   Prefab
 *   │   ├── Bg         Sprite
 *   │   ├── NameLabel  Label —— "困难"
 *   │   ├── DescLabel  Label —— 一句话说明
 *   │   ├── RecordLabel Label —— "最高 1240 · 最快 38.2s · 通关 3 次"
 *   │   ├── RewardLabel Label —— "金币 ×1.8 · 出战槽位 +1"
 *   │   └── LockIcon   Node
 *   └── CloseBtn     Button
 *
 * 【锁定态的文案是本面板的关键】
 *   只写"未解锁"是无效反馈 —— 玩家不知道要做什么才能开。
 *   必须写成"通关普通难度后解锁"，把动作和目标绑在一起。
 *
 * 【未通关的难度也会显示奖励预告】
 *   让玩家在还打不到的时候就看见"困难能给 3 个出战槽位"，
 *   这是推着他去打下一档难度的钩子。
 */

import { _decorator, Component, Label, Node, instantiate, Prefab, Button, Sprite, Color } from 'cc';
import { DifficultyPayload, LevelFlow } from '../core/LevelFlow';
import { SaveManager } from '../core/SaveManager';
import { MAX_TIER, describeTierReward, getDifficulty, getEquipSlotCount } from '../data/DifficultyConfig';
import { levelElementHint } from './CounterPanel';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

const COLOR_LOCKED = new Color(120, 124, 138, 255);

@ccclass('DifficultyPanel')
export class DifficultyPanel extends Component {
    @property(Label) titleLabel: Label = null!;
    /** 本关怪物属性（关卡确认处必须显示，24 种属性下不可省） */
    @property(Label) elementLabel: Label = null!;
    @property(Node) list: Node = null!;
    @property(Prefab) itemPrefab: Prefab = null!;
    @property(Node) closeBtn: Node = null!;

    private _levelId = 1;

    onLoad(): void {
        LevelFlow.inst.onDifficultySelect((p) => this.show(p));
        this.closeBtn?.on(Node.EventType.TOUCH_END, this.hide, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.closeBtn?.off(Node.EventType.TOUCH_END, this.hide, this);
    }

    private show(p: DifficultyPayload): void {
        this._levelId = p.levelId;
        this.node.active = true;

        // 第十轮：首次打开难度选择解释三档难度
        TutorialLayer.showTipById('tip_difficulty');

        if (this.titleLabel) {
            this.titleLabel.string = '第 ' + p.levelId + ' 关 · 选择难度';
        }
        // ★ 关卡确认处直接列出怪物属性 ——
        // 24 种属性下玩家不可能自己猜这一关是什么属性，必须提前告知。
        if (this.elementLabel) {
            this.elementLabel.string = levelElementHint(p.levelId);
        }
        this.rebuildItems(p);
    }

    private hide(): void {
        this.node.active = false;
        LevelFlow.inst.backToSelect();
    }

    /** 重建难度列表 */
    public rebuildItems(p?: DifficultyPayload): void {
        if (!this.list || !this.itemPrefab) return;

        const levelId = p ? p.levelId : this._levelId;
        const maxTier = LevelFlow.inst.getMaxTier(levelId);
        const profile = SaveManager.getProfile();

        this.list.removeAllChildren();

        for (let tier = 1; tier <= MAX_TIER; tier++) {
            const def = getDifficulty(tier);
            const unlocked = tier <= maxTier;

            const node = instantiate(this.itemPrefab);
            node.name = 'Tier_' + tier;
            this.list.addChild(node);

            const nameLabel = node.getChildByName('NameLabel')?.getComponent(Label);
            if (nameLabel) nameLabel.string = def.name;

            const descLabel = node.getChildByName('DescLabel')?.getComponent(Label);
            if (descLabel) descLabel.string = def.desc;

            const key = SaveManager.statKey(levelId, tier);
            const cleared = SaveManager.hasArchive(levelId, tier);
            const best = profile.bestScores[key] ?? 0;
            const bestTime = profile.bestTimes[key] ?? 0;
            const times = profile.clearCounts[key] ?? 0;

            const recordLabel = node.getChildByName('RecordLabel')?.getComponent(Label);
            if (recordLabel) {
                if (!unlocked) {
                    // 锁定时唯一有用的信息是"怎么开"
                    const prev = getDifficulty(tier - 1).name;
                    recordLabel.string = '通关「' + prev + '」难度后解锁';
                } else if (cleared) {
                    recordLabel.string = '最高 ' + best + '　最快 ' + bestTime.toFixed(1) +
                        's　通关 ' + times + ' 次';
                } else {
                    recordLabel.string = '尚未通关　' +
                        (tier > 1 ? '进入时默认继承上一难度的装备' : '从初始装备开打');
                }
            }

            const rewardLabel = node.getChildByName('RewardLabel')?.getComponent(Label);
            if (rewardLabel) {
                const slots = getEquipSlotCount(tier);
                rewardLabel.string = '金币 ×' + def.goldMul +
                    '　得分 ×' + def.scoreMul +
                    '　出战 ' + slots + ' 件' +
                    '　敌人血量 ×' + def.hpMul;
                if (def.rangedRatio > 0) {
                    rewardLabel.string += '　远程小怪 ' + Math.round(def.rangedRatio * 100) + '%';
                }
                if (!unlocked) {
                    // 锁定时额外把"解锁它能多给什么"说清楚，这是最强的驱动力
                    rewardLabel.string = '解锁后可获得：' +
                        describeTierReward(tier) + '　' + rewardLabel.string;
                }
            }

            const lockIcon = node.getChildByName('LockIcon');
            if (lockIcon) lockIcon.active = !unlocked;

            const sprite = node.getChildByName('Bg')?.getComponent(Sprite);
            if (sprite) {
                sprite.color = unlocked
                    ? new Color(def.color[0], def.color[1], def.color[2], 255)
                    : COLOR_LOCKED;
            }

            const btn = node.getComponent(Button);
            if (btn) {
                btn.interactable = unlocked;
                btn.node.off(Node.EventType.TOUCH_END);
                if (unlocked) {
                    btn.node.on(Node.EventType.TOUCH_END, () => this.onTierClicked(tier), this);
                }
            }
        }
    }

    /** 选定难度 → 交给 LevelFlow 决定是弹继承面板还是直接开局 */
    private onTierClicked(tier: number): void {
        this.node.active = false;
        LevelFlow.inst.openLevel(this._levelId, tier);
    }
}
