/**
 * 三选一面板 —— 局内成长的唯一决策点
 *
 * 【规则来源】
 *   玩家原话："在对局里面选武器或者选天赋以及选辅助装备都是固定三选一"
 *   所以这一屏恒为三张卡，不多不少（候选池的组装见 RewardPicker）。
 *
 * 【为什么战斗层不隐藏】
 *   这个面板出现时战斗是**冻结**的（LevelFlow.paused → GameEntry.update 直接 return），
 *   但战场画面留在背后。玩家能看着刚打出来的战况做选择，
 *   比切到一个空白的黑底界面再切回来要连贯得多 ——
 *   而且"怪已经贴到脸上了"这种紧迫感本身就是决策的一部分。
 *
 * 【合成补选必须讲清楚】
 *   合成型进化会吃掉一个武器槽（两件武器并成一件），
 *   面板会连开两次：第一次告诉玩家"合成了什么、少了一个格子"，
 *   第二次标题变成"补选一件武器"，让玩家知道刚才的空位现在可以填回来。
 *   如果不区分这两次的文案，玩家会以为"我的武器莫名其妙少了一个"。
 *
 * 预制体节点结构建议：
 *   RewardPanel (本脚本, 默认 active = false)
 *   ├── TitleLabel     Label —— "升级！选择强化" / "合成完成 · 补选一件武器"
 *   ├── SlotLabel      Label —— "武器 3/6　辅助 1/6"
 *   ├── AffinityLabel  Label —— "本关推荐 铁剑 · 短弓（伤害 ×1.25）"
 *   ├── Card0 (Button)
 *   │   ├── RarityLabel   Label —— "传说"
 *   │   ├── NameLabel     Label —— "裂空剑"
 *   │   ├── SubTitleLabel Label —— "进化 · 巨镰 → 裂空剑"
 *   │   ├── DescLabel     Label —— 效果说明
 *   │   └── TagLabel      Label —— "★复玩解锁" / "消耗 1 武器槽" / "已满层"
 *   ├── Card1 (Button)    —— 结构同上
 *   └── Card2 (Button)    —— 结构同上
 */

import { _decorator, Component, Label, Node, Button, Color } from 'cc';
import { LevelFlow, RewardPayload } from '../core/LevelFlow';
import { RewardKind, RewardOption } from '../data/GameTypes';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

/** 品质配色：0 普通 / 1 稀有 / 2 史诗 / 3 传说 */
const RARITY_COLOR: Color[] = [
    new Color(210, 214, 222, 255),
    new Color(96, 190, 255, 255),
    new Color(186, 122, 255, 255),
    new Color(255, 176, 64, 255),
];
const RARITY_TEXT = ['普通', '稀有', '史诗', '传说'];

/** 卡片左侧的类别色条 / 标题前缀，让玩家一眼分清三类成长资源 */
const KIND_TAG: Record<string, string> = {
    weapon_new: '新武器',
    weapon_upgrade: '武器强化',
    weapon_evolve: '武器进化',
    weapon_fusion: '武器合成',
    aux_new: '新辅助',
    aux_evolve: '辅助进化',
    talent: '天赋',
};

@ccclass('RewardPanel')
export class RewardPanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) slotLabel: Label = null!;
    @property(Label) affinityLabel: Label = null!;
    /** 三张卡片的根节点，顺序与候选一一对应 */
    @property([Node]) cards: Node[] = [];

    private _busy = false;

    onLoad(): void {
        LevelFlow.inst.onReward((p) => this.show(p));
        for (let i = 0; i < this.cards.length; i++) {
            this.cards[i]?.on(Node.EventType.TOUCH_END, () => this.onCardClicked(i), this);
        }
        const payload = LevelFlow.inst.phase === 'REWARD' ? LevelFlow.inst.getRewardPayload() : null;
        if (payload) this.show(payload);
        else this.node.active = false;
    }

    onDestroy(): void {
        for (let i = 0; i < this.cards.length; i++) {
            this.cards[i]?.off(Node.EventType.TOUCH_END, () => this.onCardClicked(i), this);
        }
    }

    onEnable(): void {
        // 组件首次启用可能晚于续玩事件，直接从流程状态恢复面板。
        if (LevelFlow.inst.phase === 'REWARD') {
            const payload = LevelFlow.inst.getRewardPayload();
            if (payload) this.show(payload);
        }
    }

    private show(p: RewardPayload): void {
        this._busy = false;
        this.node.active = true;

        // 第十轮：首次弹出三选一解释变强来源
        TutorialLayer.showTipById('tip_reward');

        if (this.titleLabel) {
            this.titleLabel.string = p.refill
                ? '合成消耗了一个武器槽 · 补选一件武器'
                : '升级！三选一（Lv.' + p.level + '）';
        }
        if (this.slotLabel) {
            this.slotLabel.string = p.slotText;
        }
        if (this.affinityLabel) {
            // 三选一里也提示本关推荐，帮玩家在"补宽度"和"补适配"之间做取舍
            this.affinityLabel.string = p.affinityText ? '本关推荐：' + p.affinityText : '';
        }

        for (let i = 0; i < this.cards.length; i++) {
            const card = this.cards[i];
            if (!card) continue;
            const opt = p.options[i];
            card.active = !!opt;
            if (opt) this.fillCard(card, opt);
        }
    }

    private fillCard(card: Node, opt: RewardOption): void {
        const rarity = Math.max(0, Math.min(3, opt.rarity | 0));

        const rarityLabel = card.getChildByName('RarityLabel')?.getComponent(Label);
        if (rarityLabel) {
            rarityLabel.string = RARITY_TEXT[rarity];
            rarityLabel.color = RARITY_COLOR[rarity];
        }

        const nameLabel = card.getChildByName('NameLabel')?.getComponent(Label);
        if (nameLabel) {
            nameLabel.string = opt.title;
            nameLabel.color = RARITY_COLOR[rarity];
        }

        const sub = card.getChildByName('SubTitleLabel')?.getComponent(Label);
        if (sub) {
            // 副标题以类别开头，玩家扫一眼就知道这是一张什么卡
            const tag = KIND_TAG[opt.kind] || '';
            sub.string = tag + (opt.subtitle ? '　' + opt.subtitle : '');
        }

        const desc = card.getChildByName('DescLabel')?.getComponent(Label);
        if (desc) desc.string = opt.desc;

        const tag = card.getChildByName('TagLabel')?.getComponent(Label);
        if (tag) {
            const marks: string[] = [];
            // 合成的"代价"必须写在卡上，否则玩家点完才发现少了一个格子
            if (opt.kind === 'weapon_fusion' || opt.consumesSlot) {
                marks.push('消耗 1 武器槽');
                if (opt.needName) marks.push('需要 ' + opt.needName);
            }
            // 高级进化是复玩限定的最稀有奖励，必须给足标注
            if (opt.advanced) marks.push('★ 复玩解锁');
            if (opt.kind === 'talent') marks.push('不占槽位');
            tag.string = marks.join('　');
        }

        const btn = card.getComponent(Button);
        if (btn) btn.interactable = true;
    }

    private onCardClicked(index: number): void {
        if (this._busy) return;
        const opt = LevelFlow.inst.getPendingRewards()[index];
        if (!opt) return;
        this._busy = true;
        // 卡片按钮禁用，避免连点两次把同一张卡结算两遍
        const btn = this.cards[index]?.getComponent(Button);
        if (btn) btn.interactable = false;
        const result = LevelFlow.inst.chooseReward(index);
        if (!result?.ok) {
            this._busy = false;
            if (btn) btn.interactable = true;
        }
        // 阶段由 LevelFlow 决定：可能再开一次（合成补选），也可能回到 PLAYING。
        // 选择回调是同步执行的，因此这里立即跟随阶段更新显隐，避免等到
        // 下一帧 GameEntry.update 才关闭面板；合成补选仍会保持面板显示。
        this.node.active = LevelFlow.inst.phase === 'REWARD';
    }

    /** 供外部（GameEntry 的兜底逻辑）判断当前是否正在等玩家选择 */
    public static isChoosing(): boolean {
        return LevelFlow.inst.phase === 'REWARD';
    }
}
