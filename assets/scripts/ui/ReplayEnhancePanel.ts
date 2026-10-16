/**
 * 复玩加难面板 —— 重复进入已通关的难度时弹出
 *
 * 【为什么会有这一屏】
 *
 *   玩家原话："重复进入可以让用户选择是否增加难度, 以及选择增加难度百分比"。
 *
 *   已经通关过的难度，如果不加难就直接重进，那只是"再走一遍流程"：
 *   装备全继承、敌人没变强，胜负在进场那一刻就定了，没有任何张力。
 *   加难把这个"重复"变成一次**主动的风险定价**：
 *   玩家自己决定要拿多少敌人强度去换多少收益，这才是复玩的乐趣来源。
 *
 * 【为什么不强制加难】
 *   有些玩家重进只是想补成就、试试新拿到的武器、或者单纯爽一把。
 *   强制加难会把这些人挡在外面，所以第一档永远是"不加难"。
 *
 * 【数值必须提前告知】
 *   加难不是模糊的"更难一点"，而是**明确的百分比**，
 *   并且面板上直接给出每一档的敌人血量/攻击/数量预览。
 *   玩家能看到"+30% 会让血量从 220 涨到 286"，才愿意主动往上加。
 *   把代价藏起来再加难，玩家只会觉得被暗算。
 *
 * 预制体节点结构建议：
 *   ReplayEnhancePanel (本脚本, 默认 active = false)
 *   ├── TitleLabel     Label —— "第 3 关 · 困难　第 4 次挑战"
 *   ├── SubTitleLabel  Label —— "选择本次的加难幅度（装备与形态全部继承）"
 *   ├── Step0 (Button) —— "不加难"
 *   │   └── Label
 *   ├── Step1 (Button) —— "+15%"
 *   │   └── Label
 *   ├── Step2 (Button) —— "+30%"
 *   │   └── Label
 *   ├── Step3 (Button) —— "+50%"
 *   │   └── Label
 *   ├── PreviewLabel   Label —— 当前选中档位的敌人强度预览
 *   ├── StartBtn       Button —— "开始挑战"
 *   └── SkipBtn        Button —— "跳过（沿用上次 +30%）"
 */

import { _decorator, Component, Label, Node, Button } from 'cc';
import { LevelFlow, ReplayBoostPayload } from '../core/LevelFlow';
import { REPLAY_BOOST_STEPS } from '../data/GameTypes';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

/** 每个档位按钮对应的档位下标（与 REPLAY_BOOST_STEPS 一一对应） */
const STEP_NODES = ['Step0', 'Step1', 'Step2', 'Step3'];

@ccclass('ReplayEnhancePanel')
export class ReplayEnhancePanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) subTitleLabel: Label = null!;
    @property(Label) previewLabel: Label = null!;
    @property(Node) startBtn: Node = null!;
    @property(Node) skipBtn: Node = null!;
    /** 档位按钮根节点，顺序与 REPLAY_BOOST_STEPS 对应 */
    @property([Node]) stepButtons: Node[] = [];

    private _payload: ReplayBoostPayload | null = null;
    /** 当前选中的档位下标 */
    private _picked = 0;
    private _busy = false;

    onLoad(): void {
        LevelFlow.inst.onReplayBoost((p) => this.show(p));
        for (let i = 0; i < this.stepButtons.length; i++) {
            this.stepButtons[i]?.on(Node.EventType.TOUCH_END, () => this.onStepClicked(i), this);
        }
        this.startBtn?.on(Node.EventType.TOUCH_END, this.onStartClicked, this);
        this.skipBtn?.on(Node.EventType.TOUCH_END, this.onSkipClicked, this);
        this.node.active = false;
    }

    onDestroy(): void {
        for (let i = 0; i < this.stepButtons.length; i++) {
            this.stepButtons[i]?.off(Node.EventType.TOUCH_END, () => this.onStepClicked(i), this);
        }
        this.startBtn?.off(Node.EventType.TOUCH_END, this.onStartClicked, this);
        this.skipBtn?.off(Node.EventType.TOUCH_END, this.onSkipClicked, this);
    }

    private show(p: ReplayBoostPayload): void {
        this._payload = p;
        this._busy = false;
        this.node.active = true;

        // 第十轮：首次出现复玩加难解释自选加难
        TutorialLayer.showTipById('tip_replay');

        if (this.titleLabel) {
            this.titleLabel.string = '第 ' + p.levelId + ' 关 · ' + p.difficultyName +
                '　第 ' + (p.replayCount + 1) + ' 次挑战';
        }
        if (this.subTitleLabel) {
            this.subTitleLabel.string = '装备、形态与天赋全部继承。选择本次的加难幅度 —— 越难，金币越多';
        }

        // 默认选中上次的选择：玩家的加难意愿是有惯性的，
        // 每次都要重新挑一遍会变成纯粹的点击负担
        const def = p.steps.indexOf(p.current);
        this._picked = def >= 0 ? def : 0;

        this.fillSteps();
        this.applyPreview();
        this.applySkipLabel();

        const sb = this.startBtn?.getComponent(Button);
        if (sb) sb.interactable = true;
    }

    /** 档位按钮文案：把百分比与"有多难"直接写在按钮上，不藏在副标题里 */
    private fillSteps(): void {
        const p = this._payload;
        if (!p) return;
        for (let i = 0; i < this.stepButtons.length; i++) {
            const node = this.stepButtons[i];
            if (!node) continue;
            const step = p.steps[i];
            if (step === undefined) { node.active = false; continue; }
            node.active = true;

            const label = node.getChildByName('Label')?.getComponent(Label);
            if (label) {
                label.string = step <= 0 ? '不加难' : '+' + Math.round(step * 100) + '%';
            }
            // 选中态直接用按钮可用性表达（选中 → 不可再点），
            // 免去额外配一套高亮资源
            const btn = node.getComponent(Button);
            if (btn) btn.interactable = i !== this._picked;
        }
    }

    private applyPreview(): void {
        const p = this._payload;
        if (!p || !this.previewLabel) return;
        const line = p.preview[this._picked];
        const step = p.steps[this._picked];
        this.previewLabel.string = (step <= 0
            ? '本次不加难：与上次完全相同的敌人强度'
            : '本次加难 +' + Math.round(step * 100) + '%：') +
            (line ? '\n' + line : '');
    }

    private applySkipLabel(): void {
        const p = this._payload;
        if (!p) return;
        const label = this.skipBtn?.getChildByName('Label')?.getComponent(Label);
        if (label) {
            label.string = p.current > 0
                ? '沿用上次 +' + Math.round(p.current * 100) + '%'
                : '跳过（不加难）';
        }
    }

    private onStepClicked(index: number): void {
        if (this._busy || !this._payload) return;
        if (this._payload.steps[index] === undefined) return;
        this._picked = index;
        this.fillSteps();
        this.applyPreview();
    }

    private onStartClicked(): void {
        if (this._busy || !this._payload) return;
        this._busy = true;
        const step = this._payload.steps[this._picked] || 0;
        // enabled 与 percent 分开传：0% 是一个合法选择（等于不加难），
        // 不该被当成"没选择"处理
        LevelFlow.inst.confirmReplayBoost(step > 0, step);
        this._payload = null;
    }

    private onSkipClicked(): void {
        if (this._busy || !this._payload) return;
        this._busy = true;
        LevelFlow.inst.skipReplayBoost();
        this._payload = null;
    }

    /** 工具：所有可选档位，UI 布局用 */
    public static steps(): number[] {
        return REPLAY_BOOST_STEPS.slice();
    }

    /** 工具：把加难百分比转成展示文案 */
    public static label(percent: number): string {
        return percent > 0 ? '+' + Math.round(percent * 100) + '%' : '不加难';
    }
}
