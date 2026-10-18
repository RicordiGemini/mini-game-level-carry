/**
 * 关卡装备继承选择面板
 *
 * 挂在 LoadoutPanel 预制体根节点上。
 *
 * 【什么时候弹这个面板】
 *   只在"玩家点进一个**该难度已经通关过**的关卡"时弹出 —— 这时存档里有该难度的档案。
 *
 *   进入更高难度是**不弹**这个面板的：那条路径默认免费继承低难度通关的装备，
 *   直接开局（见 LevelFlow.openLevel）。理由是高难度敌人更硬，
 *   不给继承就是纯劝退；广告的价值留在"同难度冲更高纪录"这个场景。
 *
 * 预制体节点结构建议：
 *   LoadoutPanel (本脚本, 默认 active = false)
 *   ├── TitleLabel      Label —— "第 3 关 · 困难 · 已通关 2 次"
 *   ├── EquipLabel      Label —— 装备继承预览，逐件列出
 *   ├── LoadoutLabel    Label —— "可继承数据：金币 320 · 生命 165"
 *   ├── RecordLabel     Label —— "历史最高分 1240 · 最快 38.2s"
 *   ├── CarryBtn        Button —— "看视频 · 继承装备开局"
 *   │   └── Label
 *   ├── CarryTipLabel   Label —— "完整观看激励视频后，以上装备与进化阶段将带入本局"
 *   ├── FreshBtn        Button —— "重新开始"
 *   └── FreshTipLabel   Label —— "从初始装备开始，该难度档案仍会保留"
 *
 * 【提审合规要点】
 *   - 「重新开始」必须正常可见、可点击，不能置灰或藏起来，否则会被判定为强制观看广告。
 *   - 广告只能在玩家点击 CarryBtn 之后播放，禁止面板弹出时自动播放。
 *   - 广告未播完时不能清空任何数据，要允许玩家重新选择。
 */

import { _decorator, Component, Label, Node, Button, Tween, tween, Vec3 } from 'cc';
import { LevelFlow, LoadoutPayload } from '../core/LevelFlow';
import { AdReward, AdTag } from '../ad/AdReward';
import { getForm } from '../data/FormConfig';
import { getTalentDef } from '../data/TalentConfig';
import { resolveFormId } from '../core/FormGraph';
import { EquipRunState } from '../data/GameTypes';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

@ccclass('LoadoutPanel')
export class LoadoutPanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) equipLabel: Label = null!;
    @property(Label) loadoutLabel: Label = null!;
    @property(Label) recordLabel: Label = null!;
    @property(Label) carryTipLabel: Label = null!;
    @property(Label) freshTipLabel: Label = null!;
    @property(Node) carryBtn: Node = null!;
    @property(Node) freshBtn: Node = null!;

    private _busy = false;
    private _levelId = 0;
    private _tier = 1;

    onLoad(): void {
        LevelFlow.inst.onLoadoutChoice((p) => this.show(p));
        this.carryBtn?.on(Node.EventType.TOUCH_END, this.onCarryClicked, this);
        this.freshBtn?.on(Node.EventType.TOUCH_END, this.onFreshClicked, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.carryBtn?.off(Node.EventType.TOUCH_END, this.onCarryClicked, this);
        this.freshBtn?.off(Node.EventType.TOUCH_END, this.onFreshClicked, this);
        Tween.stopAllByTarget(this.node);
    }

    private show(p: LoadoutPayload): void {
        this._levelId = p.levelId;
        this._tier = p.difficulty;
        this.node.active = true;

        // 第十轮：首次出现继承选择解释看广告带装备
        TutorialLayer.showTipById('tip_loadout');

        if (this.titleLabel) {
            this.titleLabel.string = '第 ' + p.levelId + ' 关 · ' + p.difficultyName +
                ' · 已通关 ' + p.archive.clearCount + ' 次';
        }
        if (this.equipLabel) {
            this.equipLabel.string = this.buildEquipPreview(p.archive.loadout.equipment, p.archive.loadout.talents);
        }
        if (this.loadoutLabel) {
            this.loadoutLabel.string = '可继承数据：' + p.summary;
        }
        if (this.recordLabel) {
            this.recordLabel.string =
                '历史最高分 ' + p.archive.bestScore + ' · 最快 ' + p.archive.bestTime.toFixed(1) + 's';
        }
        if (this.freshTipLabel) {
            // 默认策略下"重新开始"不删档，文案必须如实说明，不能拿删档来吓唬玩家
            this.freshTipLabel.string = '从初始装备开始，该难度档案仍会保留';
        }

        this.setCarryEnabled(p.adRetryLeft > 0);
        if (this.carryTipLabel) {
            this.carryTipLabel.string = '看完视频后，以上装备与进化阶段将全部带入本关';
        }

        // 预加载广告，减少玩家点击后的等待
        AdReward.preload(AdTag.CARRY_OVER);

        // 刚通关立刻重玩是转化率最高的场景，按钮做轻微呼吸动画强化引导
        if (p.justCleared && this.carryBtn) {
            Tween.stopAllByTarget(this.carryBtn);
            tween(this.carryBtn)
                .to(0.6, { scale: new Vec3(1.04, 1.04, 1) })
                .to(0.6, { scale: new Vec3(1, 1, 1) })
                .union()
                .repeatForever()
                .start();
        }
    }

    /**
     * 逐件列出可继承的武器 / 辅助装备与它们已经到的形态，
     * 让玩家直观看到"继承能省掉多少成长"。
     *
     * 武器与辅助分开列 —— 两者的价值完全不同：
     * 武器决定"怎么打"，辅助决定"打得多狠"，混在一起玩家读不出重点。
     */
    private buildEquipPreview(states?: EquipRunState[], talents?: Record<string, number>): string {
        const weapons: string[] = [];
        const auxes: string[] = [];

        if (states) {
            for (const st of states) {
                const f = getForm(resolveFormId(st));
                if (!f) continue;
                const txt = f.depth > 0
                    ? f.name + '（攻击 +' + Math.round(f.atkPct * 100) + '%' +
                        (f.attackModeText ? ' · ' + f.attackModeText : '') + '）'
                    : f.name + '（未进化）';
                if (st.kind === 'aux') auxes.push(txt);
                else weapons.push(txt);
            }
        }

        const lines: string[] = [];
        lines.push('武器：' + (weapons.length > 0 ? weapons.join('、') : '无'));
        lines.push('辅助：' + (auxes.length > 0 ? auxes.join('、') : '无'));

        // 天赋不占槽位、可以叠层，是最容易被玩家忽略的一份资产，必须显式列出来
        if (talents) {
            const parts: string[] = [];
            for (const k of Object.keys(talents)) {
                const n = talents[k];
                if (n <= 0) continue;
                const def = getTalentDef(k);
                parts.push((def ? def.name : k) + ' ×' + n);
            }
            if (parts.length > 0) lines.push('天赋：' + parts.join('、'));
        }

        return lines.join('\n');
    }

    private setCarryEnabled(on: boolean): void {
        const btn = this.carryBtn?.getComponent(Button);
        if (btn) btn.interactable = on;
    }

    // ------------------------------------------------------------ 按钮回调

    /** 看广告 → 继承装备与进化阶段开局 */
    async onCarryClicked(): Promise<void> {
        if (this._busy) return;
        this._busy = true;
        this.setCarryEnabled(false);

        const ok = await LevelFlow.inst.startWithCarry(this._levelId, this._tier);

        if (ok) {
            this.node.active = false;
        } else {
            // 没看完 / 广告拉取失败：留在面板刷新剩余次数。
            // 绝对不要在这里替玩家执行"重新开始"——那是未经同意的数据变更。
            const left = LevelFlow.inst.adRetryLeft;
            this.setCarryEnabled(left > 0);
            if (this.carryTipLabel) {
                this.carryTipLabel.string = left > 0
                    ? '视频未看完，还可再试 ' + left + ' 次'
                    : '广告暂不可用，可选择重新开始';
            }
        }
        this._busy = false;
    }

    /** 重新开始 → 本难度从初始装备开打，档案保留 */
    private onFreshClicked(): void {
        if (this._busy) return;
        this._busy = true;
        this.node.active = false;
        LevelFlow.inst.startFresh(this._levelId, this._tier);
        this._busy = false;
    }
}
