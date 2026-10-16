/**
 * 关卡选择界面
 *
 * 预制体节点结构建议：
 *   LevelSelectPanel (本脚本)
 *   ├── ScrollView
 *   │   └── Content                (GridLayout 或 HorizontalLayout)
 *   ├── LevelButtonPrefab          Prefab（不入场景，作为模板引用）
 *   │   ├── Bg        Sprite
 *   │   ├── NumLabel  Label  —— 关卡号
 *   │   ├── StateLabel Label —— 状态文案（难度进度 + 纪录）
 *   │   └── LockIcon  Node
 *   └── TipLabel      Label  —— 提示"点击关卡后选择难度"
 *
 * 【交互路由】
 *   点击已解锁关卡 → LevelFlow.openDifficultySelect() → DIFFICULTY 状态，
 *   由 DifficultyPanel 列出该关的 3 档难度（未解锁的置灰）。
 *   玩家选定难度后才真正开局，路由逻辑全部交给 LevelFlow，本界面不做判断。
 *
 * 【为什么关卡按钮上要显示"难度 x/3"】
 *   难度是每关独立的，玩家很容易忘记"第 6 关我只打了普通"。
 *   把难度进度压在关卡按钮上，"哪里还能再挖一次"一眼可见，
 *   这是本作最主要的内容消耗方向。
 */

import { _decorator, Component, Label, Node, instantiate, Prefab, Button, Sprite, Color } from 'cc';
import { LevelFlow } from '../core/LevelFlow';
import { SaveManager } from '../core/SaveManager';
import { MAX_TIER, getDifficulty } from '../data/DifficultyConfig';

const { ccclass, property } = _decorator;

/** 单关按钮上的状态表现 */
const COLOR_LOCKED = new Color(140, 140, 140, 255);
const COLOR_OPEN = new Color(58, 120, 200, 255);
const COLOR_CLEARED = new Color(30, 150, 110, 255);
const COLOR_FULL = new Color(168, 108, 214, 255);

@ccclass('LevelSelectPanel')
export class LevelSelectPanel extends Component {
    @property(Node) content: Node = null!;
    @property(Prefab) levelButtonPrefab: Prefab = null!;
    @property(Label) tipLabel: Label = null!;

    onEnable(): void {
        this.rebuild();
        if (this.tipLabel) {
            this.tipLabel.string =
                '每关有 3 档难度（普通 / 困难 / 噩梦）。通关一档即解锁下一档，' +
                '并默认继承本局装备直接开打';
        }
    }

    /** 重建关卡列表 */
    rebuild(): void {
        if (!this.content || !this.levelButtonPrefab) return;
        this.content.removeAllChildren();

        const unlocked = LevelFlow.inst.unlockedLevel;
        // 只铺到"已解锁 + 2"关，关卡多时避免一次性实例化上百个节点
        const total = Math.min(unlocked + 2, 200);

        for (let i = 1; i <= total; i++) {
            const node = instantiate(this.levelButtonPrefab);
            node.name = 'Level_' + i;
            this.applyLevelButton(node, i);
            this.content.addChild(node);

            node.on(Node.EventType.TOUCH_END, () => this.onLevelClicked(i), this);
        }
    }

    private applyLevelButton(node: Node, levelId: number): void {
        const unlocked = LevelFlow.inst.isUnlocked(levelId);
        const clearedTiers = LevelFlow.inst.clearedTierCount(levelId);

        const numLabel = node.getChildByName('NumLabel')?.getComponent(Label);
        if (numLabel) numLabel.string = String(levelId);

        const stateLabel = node.getChildByName('StateLabel')?.getComponent(Label);
        const lockIcon = node.getChildByName('LockIcon');
        if (lockIcon) lockIcon.active = !unlocked;

        if (stateLabel) {
            if (!unlocked) {
                stateLabel.string = '未解锁';
            } else if (clearedTiers > 0) {
                // 已通关：难度进度 + 最高那档的纪录（纪录是按难度分开存的）
                // 难度是顺序解锁的，所以"已通关的难度"必然是 1..clearedTiers 这一段连续区间
                const profile = SaveManager.getProfile();
                const key = SaveManager.statKey(levelId, clearedTiers);
                const best = profile.bestScores[key] ?? 0;
                const bestTime = profile.bestTimes[key] ?? 0;
                stateLabel.string = '难度 ' + clearedTiers + '/' + MAX_TIER +
                    '　最高 ' + best + ' · 最快 ' + bestTime.toFixed(1) + 's';
            } else {
                stateLabel.string = '挑战 · ' + getDifficulty(1).name;
            }
        }

        const btn = node.getComponent(Button);
        if (btn) btn.interactable = unlocked;

        const sprite = node.getChildByName('Bg')?.getComponent(Sprite);
        if (sprite) {
            if (!unlocked) {
                sprite.color = COLOR_LOCKED;
            } else if (clearedTiers >= MAX_TIER) {
                // 全部难度通关 —— 用一个明显不同的颜色标出来，是"通了"的勋章
                sprite.color = COLOR_FULL;
            } else if (clearedTiers > 0) {
                sprite.color = COLOR_CLEARED;
            } else {
                sprite.color = COLOR_OPEN;
            }
        }
    }

    /** 点击关卡 → 打开难度选择面板 */
    private onLevelClicked(levelId: number): void {
        if (!LevelFlow.inst.isUnlocked(levelId)) return;
        LevelFlow.inst.openDifficultySelect(levelId);
        this.node.active = false;
    }

    /**
     * 长按关卡按钮时可调用：手动重置该关所有难度的档案。
     * 对应玩家主动"重新开始把数据重置"的诉求，建议在关卡按钮上放一个小图标入口。
     */
    public onResetLevel(levelId: number): void {
        LevelFlow.inst.resetArchive(levelId);
        this.rebuild();
    }
}
