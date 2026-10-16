/**
 * 通关结算面板
 *
 * 【复玩目标导向：冲分 / 计时 / 挑战更高难度 / 加难再战】
 * 因为继承装备后本局必然变轻松，所以结算页的重点不是"能不能过"，
 * 而是"这一局比上一局强多少"。所有文案都围绕纪录对比来写。
 * 纪录是**按难度分开存**的，所以"刷新纪录"对每一档难度各自成立。
 *
 * 【进化成果必须单独报】
 * 本局养出了什么（进化了几次、合成过没有、最高到第几层形态）是这个玩法
 * 唯一的"养成账本"。玩家看到"进化 3 次 · 合成 1 次"，才会觉得这一局没白打，
 * 也才有动机把这份成果继承下去再来一次。
 *
 * 预制体节点结构建议：
 *   ResultPanel (本脚本, 默认 active = false)
 *   ├── TitleLabel       Label —— "第 3 关 · 困难 通关！"
 *   ├── ScoreLabel       Label —— "得分 1240 · 刷新纪录！" / "得分 1180 · 最高 1240"
 *   ├── TimeLabel        Label —— "42.5s · 最快 38.2s"
 *   ├── EquipLabel       Label —— 本局最终装备与形态
 *   ├── GrowthLabel      Label —— "进化 3 次 · 合成 1 次 · 最高形态层 3 · 加难 +30%"
 *   ├── AchievementLabel Label —— "新成就：剑雨初成　图鉴 18/52"
 *   ├── RewardLabel      Label —— "击杀 12 · 获得金币 +120（含成就 +200）"
 *   ├── NextTierBtn      Button —— "挑战 噩梦 · 继承装备开局"（主按钮，本局刚解锁时最亮）
 *   ├── NextBtn          Button —— "进入下一关"
 *   ├── BoostBtn         Button —— "加难 +45% 再来一局"（复玩上瘾的钩子）
 *   ├── ReplayBtn        Button —— "看视频 · 带装备重刷本难度"（广告位）
 *   │   └── Label
 *   ├── ReplayTipLabel   Label —— "装备 100% 继承，直接以巅峰状态开局冲分"
 *   └── SelectBtn        Button —— "返回关卡选择"
 *
 * 【难度推进是主路径，广告是支线】
 *   首次通关某难度后，最该被推荐的动作是"挑战下一难度"——
 *   那里有更高的金币倍率、下一个出战槽位、以及新的武器。
 *   所以 NextTierBtn 是结算页的主按钮，并且它**不需要看广告**（默认继承装备）。
 *   ReplayBtn 只服务"我要在这一档刷更高纪录"的少数需求，是本页的广告位。
 *   但"进入下一关"必须始终可点 —— 保证不看广告的玩家有顺畅的主路径。
 */

import { _decorator, Component, Label, Node, Button } from 'cc';
import { LevelFlow, SettlePayload } from '../core/LevelFlow';
import { AdReward, AdTag } from '../ad/AdReward';
import { getForm, formLevelOf } from '../data/FormConfig';
import { resolveFormId } from '../core/FormGraph';
import { getDifficulty } from '../data/DifficultyConfig';
import { EquipRunState, ElementId } from '../data/GameTypes';
import { getMaterialDef, SHARDS_PER_STONE } from '../data/MaterialConfig';
import { elementName } from '../data/ElementConfig';
import { shardBag } from '../core/ForgeManager';

const { ccclass, property } = _decorator;

@ccclass('ResultPanel')
export class ResultPanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) scoreLabel: Label = null!;
    @property(Label) timeLabel: Label = null!;
    @property(Label) equipLabel: Label = null!;
    @property(Label) rewardLabel: Label = null!;
    @property(Label) replayTipLabel: Label = null!;
    /** 本局养成账本：进化次数 / 合成次数 / 最高形态层 / 加难百分比 */
    @property(Label) growthLabel: Label = null!;
    /** 新解锁的成就与图鉴收录进度 */
    @property(Label) achievementLabel: Label = null!;
    /**
     * 本局掉落的材料。
     * 必须显眼地展示 —— 玩家要能一眼看出"这一关掉的是哪种突破材料、哪种属性碎片"，
     * 才会形成"下一关我专门去刷那个材料"的主动目标。
     */
    @property(Label) dropLabel: Label = null!;
    @property(Node) nextTierBtn: Node = null!;
    @property(Node) nextBtn: Node = null!;
    @property(Node) replayBtn: Node = null!;
    @property(Node) selectBtn: Node = null!;
    /** 加难重来：在本局加难基础上 +15% 直接再来一局 */
    @property(Node) boostBtn: Node = null!;

    private _busy = false;
    private _levelId = 0;
    private _tier = 1;

    onLoad(): void {
        LevelFlow.inst.onSettle((p) => this.show(p));
        this.nextTierBtn?.on(Node.EventType.TOUCH_END, this.onNextTierClicked, this);
        this.nextBtn?.on(Node.EventType.TOUCH_END, this.onNextClicked, this);
        this.replayBtn?.on(Node.EventType.TOUCH_END, this.onReplayClicked, this);
        this.selectBtn?.on(Node.EventType.TOUCH_END, this.onSelectClicked, this);
        this.boostBtn?.on(Node.EventType.TOUCH_END, this.onBoostClicked, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.nextTierBtn?.off(Node.EventType.TOUCH_END, this.onNextTierClicked, this);
        this.nextBtn?.off(Node.EventType.TOUCH_END, this.onNextClicked, this);
        this.replayBtn?.off(Node.EventType.TOUCH_END, this.onReplayClicked, this);
        this.selectBtn?.off(Node.EventType.TOUCH_END, this.onSelectClicked, this);
        this.boostBtn?.off(Node.EventType.TOUCH_END, this.onBoostClicked, this);
    }

    private show(p: SettlePayload): void {
        this._levelId = p.levelId;
        this._tier = p.difficulty;
        this.node.active = true;

        if (this.titleLabel) {
            this.titleLabel.string = '第 ' + p.levelId + ' 关 · ' + p.difficultyName + ' 通关！';
        }
        // 得分永远显示纪录对比，这是复玩的核心驱动力
        if (this.scoreLabel) {
            if (p.isNewScoreBest && p.clearCount > 1) {
                this.scoreLabel.string = '得分 ' + p.score + ' · 刷新纪录！';
            } else if (p.isNewScoreBest) {
                this.scoreLabel.string = '得分 ' + p.score;
            } else {
                this.scoreLabel.string = '得分 ' + p.score + ' · 最高 ' + p.bestScore;
            }
        }
        if (this.timeLabel) {
            const timeStr = p.elapsed.toFixed(1) + 's';
            this.timeLabel.string = p.isNewTimeBest && p.clearCount > 1
                ? timeStr + ' · 最快纪录！'
                : timeStr + ' · 最快 ' + p.bestTime.toFixed(1) + 's';
        }
        if (this.equipLabel) {
            this.equipLabel.string = '本局装备与形态：\n' + this.buildEquipText(p);
        }
        if (this.growthLabel) {
            this.growthLabel.string = this.buildGrowthText(p);
        }
        if (this.achievementLabel) {
            this.achievementLabel.string = this.buildAchievementText(p);
        }
        if (this.dropLabel) {
            this.dropLabel.string = this.buildDropText(p);
        }
        if (this.rewardLabel) {
            this.rewardLabel.string = '击杀 ' + p.kills + ' · 获得金币 +' + p.goldGained +
                (p.achievementGold > 0 ? '（含成就 +' + p.achievementGold + '）' : '');
        }
        if (this.replayTipLabel) {
            this.replayTipLabel.string = '装备、形态与天赋 100% 继承，直接以巅峰状态开局冲分';
        }

        this.applyNextTier(p);
        this.applyNextLevel(p);
        this.applyBoost(p);

        // 结算页一出现就预加载广告，玩家点下去能立刻播
        AdReward.preload(AdTag.CARRY_OVER);
    }

    /**
     * 「挑战下一难度」按钮。
     * 本局刚解锁下一难度时把文案与可用性拉满 —— 这是结算页最强的引导点。
     */
    private applyNextTier(p: SettlePayload): void {
        const btn = this.nextTierBtn?.getComponent(Button);
        const label = this.nextTierBtn?.getChildByName('Label')?.getComponent(Label);
        if (!this.nextTierBtn) return;

        const unlocked = p.hasNextTier && LevelFlow.inst.isTierUnlocked(p.levelId, p.nextTier);
        this.nextTierBtn.active = unlocked;
        if (!unlocked) return;

        const nextName = getDifficulty(p.nextTier).name;
        if (label) {
            label.string = p.tierJustUnlocked
                ? '挑战 ' + nextName + ' · 已解锁，继承装备开局'
                : '挑战 ' + nextName + ' · 继承装备开局';
        }
        if (btn) btn.interactable = true;
    }

    /** 「进入下一关」按钮：新关卡只解锁普通难度，从初始数据开局 */
    private applyNextLevel(p: SettlePayload): void {
        const nb = this.nextBtn?.getComponent(Button);
        if (nb) nb.interactable = p.hasNext;
    }

    /**
     * 「加难再来一局」。
     *
     * 它是复玩的核心钩子：通关之后如果只有"再来一遍"，玩家很快会腻；
     * 但"我来试试 +45% 能不能过"是一个**永远打开的目标**，
     * 而且它同时抬高了金币收益（见 LevelConfig 的 boost 结算），
     * 所以加难不是纯找苦吃，而是"主动拉高收益曲线"。
     *
     * 首次通关时不显示 —— 那一局的正确引导是"挑战下一难度"或"进下一关"。
     */
    private applyBoost(p: SettlePayload): void {
        if (!this.boostBtn) return;
        const show = p.clearCount > 1;
        this.boostBtn.active = show;
        if (!show) return;

        const label = this.boostBtn.getChildByName('Label')?.getComponent(Label);
        if (label) {
            const next = Math.round((p.boostPercent + 0.15) * 100);
            label.string = '加难 +' + next + '% 再来一局';
        }
    }

    /** 本局养成账本：这是"这一局没白打"的唯一证据 */
    private buildGrowthText(p: SettlePayload): string {
        const parts: string[] = [];
        parts.push('进化 ' + p.evolutions.length + ' 次');
        if (p.fusions > 0) parts.push('合成 ' + p.fusions + ' 次');
        parts.push('最高形态层 ' + p.maxDepth);
        if (p.boostPercent > 0) parts.push('加难 +' + Math.round(p.boostPercent * 100) + '%');
        return parts.join('　·　');
    }

    /** 成就与图鉴进度：给玩家一个"还差多少收满"的长期目标 */
    private buildAchievementText(p: SettlePayload): string {
        const parts: string[] = [];
        if (p.newAchievements.length > 0) {
            parts.push('新成就：' + p.newAchievements.join('、'));
        }
        parts.push(p.collectionText);
        return parts.join('　');
    }

    /**
     * 本局掉落的材料。
     *
     * 分成两行，因为两者的后续动作完全不同：
     *   突破材料 → 去锻造台花金币突破某把武器（决定它能镶几个属性）
     *   属性碎片 → 攒够 10 个合成完整材料（决定能镶什么属性）
     * 混在一起写会让玩家不知道该先做什么。
     *
     * 碎片那一行还会显示"离合成还差几个"，
     * 让"再打两关就凑齐了"这件事可见 —— 这是掉落的意义所在。
     */
    private buildDropText(p: SettlePayload): string {
        const d = p.drops;
        const lines: string[] = [];

        const mats: string[] = [];
        for (const k of Object.keys(d.materials)) {
            const def = getMaterialDef(k);
            mats.push((def ? def.name : k) + ' ×' + d.materials[k]);
        }
        lines.push('突破材料：' + (mats.length ? mats.join('、') : '无'));

        const shards: string[] = [];
        const bag = shardBag();
        for (const k of Object.keys(d.shards)) {
            const el = k.replace('shard_', '') as ElementId;
            const total = bag[k] || 0;
            const need = Math.max(0, SHARDS_PER_STONE - total);
            shards.push(elementName(el) + ' ×' + d.shards[k] +
                '（共 ' + total + '/' + SHARDS_PER_STONE +
                (need > 0 ? '，还差 ' + need : '　★可合成') + '）');
        }
        lines.push('属性碎片：' + (shards.length ? shards.join('、') : '无'));
        lines.push('本关属性：' + d.elements.map((e) => elementName(e as ElementId)).join('·') +
            '　（属性材料全部靠碎片合成，无需看广告）');
        return lines.join('\n');
    }

    /** 展示本局最终装备，强化"这套装备值得继承"的感知 */
    private buildEquipText(p: SettlePayload): string {
        if (!p.equipmentText) return '　无';
        // equipmentText 形如"武器：A（…）、B（…）　辅助：C（…）"
        const groups = p.equipmentText.split('　');
        const lines: string[] = [];
        for (const g of groups) {
            if (!g) continue;
            lines.push('　' + g.replace(/、/g, '\n　　'));
        }
        return lines.join('\n');
    }

    /** HUD / 扩展 UI 用：判断某件装备是否已到当前形态上限（没有后续 upgrade 边） */
    public isMaxForm(equipId: string, formId?: string): boolean {
        const f = getForm(formId || equipId);
        if (!f) return false;
        return f.evolveTo.filter((e) => e.type === 'upgrade').length === 0;
    }

    /** 工具：取某形态在给定经验下的展示名 */
    public formLabelOf(equipId: string, formId?: string, exp = 0): string {
        const f = getForm(formId || equipId);
        if (!f) return '';
        return f.name + ' Lv.' + formLevelOf(exp);
    }

    /** 工具：把槽位列表转成一行文案（其他 UI 复用） */
    public static slotTextOf(states: EquipRunState[]): string {
        const parts: string[] = [];
        for (const st of states) {
            const f = getForm(resolveFormId(st));
            if (f) parts.push(f.name);
        }
        return parts.join('、') || '无';
    }

    // ------------------------------------------------------------ 按钮回调

    /**
     * 挑战本关的下一难度。
     * 不需要看广告 —— 首次进入更高难度默认继承上一难度通关的装备。
     */
    private onNextTierClicked(): void {
        if (this._busy) return;
        this._busy = true;
        this.node.active = false;
        LevelFlow.inst.goNextTier();
        this._busy = false;
    }

    /** 进入下一关：全新关卡，从初始装备开局 */
    private onNextClicked(): void {
        if (this._busy) return;
        this._busy = true;
        this.node.active = false;
        LevelFlow.inst.goNextLevel();
        this._busy = false;
    }

    /** 加难再来一局：在已通关的难度上把复玩加难推高一档 */
    private onBoostClicked(): void {
        if (this._busy) return;
        this._busy = true;
        this.node.active = false;
        LevelFlow.inst.replayWithMoreBoost();
        this._busy = false;
    }

    /** 看广告：带着本难度刚存下的装备与形态，重刷这一难度冲纪录 */
    async onReplayClicked(): Promise<void> {
        if (this._busy) return;
        this._busy = true;
        const replayBtnCmp = this.replayBtn?.getComponent(Button);
        if (replayBtnCmp) replayBtnCmp.interactable = false;

        const ok = await LevelFlow.inst.startWithCarry(this._levelId, this._tier);

        if (ok) {
            this.node.active = false;
        } else {
            // 没看完：留在结算页，提示后允许重试。不清档、不改任何数据。
            const left = LevelFlow.inst.adRetryLeft;
            if (this.replayTipLabel) {
                this.replayTipLabel.string = left > 0
                    ? '视频未看完，还可再试 ' + left + ' 次'
                    : '广告暂不可用，可挑战下一难度或进入下一关';
            }
            if (replayBtnCmp) replayBtnCmp.interactable = left > 0;
        }
        this._busy = false;
    }

    /** 返回关卡选择 */
    private onSelectClicked(): void {
        if (this._busy) return;
        this._busy = true;
        this.node.active = false;
        LevelFlow.inst.backToSelect();
        this._busy = false;
    }
}
