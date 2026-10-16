/**
 * 成就面板 —— 主界面手动打开
 *
 * 【成就的定位是"引导"，不是"墙"】
 *
 *   这一轮加了太多新系统（合成、辅助装备、天赋、复玩加难、每关适配、图鉴），
 *   玩家不可能自己都试一遍。成就表刻意覆盖了每一个新系统
 *   （见 AchievementConfig 的注释），所以"冲成就"等于"把游戏玩明白"。
 *
 *   因此这个面板的重点不是"已完成 N 个"，而是**未完成的那些还差多少** ——
 *   进度条与"还差 3 次"这种文案才是行动指引。
 *   已解锁的排在后面当荣誉墙，未解锁的排前面当待办清单。
 *
 * 【进度怎么算出来的】
 *
 *   通关时用的是**真实的本局数据**（judgeAchievements）。
 *   但主界面上没有"本局"，所以这里用一个**档案最佳值**拼出来的
 *   合成 RunSummary 来估进度：
 *     已通关的最高关 / 全局最高难度 / 最高形态层 / 是否加难过
 *   少数几条成就（单局内同时持有 N 件装备、某个天赋叠 N 层）
 *   本质上是"单局属性"，无法从档案反推 —— 它们在这里会显示 0 进度，
 *   这是可接受的：真正的解锁判定只发生在通关时，用的是真实数据。
 *
 * 预制体节点结构建议：
 *   AchievementPanel (本脚本, 默认 active = false)
 *   ├── TitleLabel  Label —— "成就　12/24　累计奖励 3200 金币"
 *   ├── BodyLabel   Label —— 逐行列出未完成成就与进度
 *   ├── DoneLabel   Label —— 已解锁成就列表
 *   └── CloseBtn (Button)
 */

import { _decorator, Component, Label, Node } from 'cc';
import { SaveManager } from '../core/SaveManager';
import { achievementProgress, contextFromProfile } from '../core/AchievementManager';
import { ACHIEVEMENT_TABLE, totalAchievementGold } from '../data/AchievementConfig';
import { ALL_FORMS, FORM_MAX_DEPTH, getForm } from '../data/FormConfig';
import { RunSummary } from '../data/GameTypes';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

@ccclass('AchievementPanel')
export class AchievementPanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) bodyLabel: Label = null!;
    @property(Label) doneLabel: Label = null!;
    @property(Node) closeBtn: Node = null!;

    onLoad(): void {
        this.closeBtn?.on(Node.EventType.TOUCH_END, this.close, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.closeBtn?.off(Node.EventType.TOUCH_END, this.close, this);
    }

    public open(): void {
        this.node.active = true;
        this.refresh();

        // 第十轮：首次打开成就面板解释成就体系
        TutorialLayer.showTipById('tip_achievement');
    }

    public close(): void {
        this.node.active = false;
    }

    public refresh(): void {
        const profile = SaveManager.getProfile();
        const ctx = contextFromProfile(profile, bestEverSummary(), ALL_FORMS.length);

        if (this.titleLabel) {
            const unlocked = profile.achievements.length;
            const earned = profile.achievements.reduce((sum, r) => {
                const def = ACHIEVEMENT_TABLE.filter((d) => d.id === r.id)[0];
                return sum + (def ? def.gold : 0);
            }, 0);
            this.titleLabel.string = '成就　' + unlocked + '/' + ACHIEVEMENT_TABLE.length +
                '　已获金币 ' + earned + '　全解锁可得 ' + totalAchievementGold();
        }

        const rows = achievementProgress(ctx);
        const todo: string[] = [];
        const done: string[] = [];

        for (const r of rows) {
            if (r.unlocked) {
                done.push('　✔ ' + r.def.name + '（+' + r.def.gold + '）　' + r.def.desc);
                continue;
            }
            // 未完成的排在前面，并给出"还差多少" —— 这才是行动指引
            const ratio = Math.max(0, Math.min(1, r.ratio));
            const bar = progressBar(ratio);
            const gap = r.target > r.cur ? '　还差 ' + (r.target - r.cur) : '';
            todo.push('　✐ ' + r.def.name + '　' + bar + ' ' +
                Math.round(ratio * 100) + '%' + gap +
                '\n　　' + r.def.desc + '　+' + r.def.gold + ' 金币');
        }

        if (this.bodyLabel) {
            this.bodyLabel.string = todo.length > 0
                ? '【待完成 ' + todo.length + ' 项】\n' + todo.join('\n')
                : '【待完成 0 项】全部成就已解锁！';
        }
        if (this.doneLabel) {
            this.doneLabel.string = done.length > 0
                ? '【已解锁 ' + done.length + ' 项】\n' + done.join('\n')
                : '【已解锁 0 项】';
        }
    }

    /** 供其他 UI 复用的一行摘要 */
    public static summaryText(): string {
        const profile = SaveManager.getProfile();
        return '成就 ' + profile.achievements.length + '/' + ACHIEVEMENT_TABLE.length;
    }
}

/** 用可见字符拼一条进度条：工程里不引额外资源，纯文本最省事也最稳 */
function progressBar(ratio: number, width = 10): string {
    const filled = Math.round(ratio * width);
    let s = '[';
    for (let i = 0; i < width; i++) s += i < filled ? '█' : '░';
    return s + ']';
}

/**
 * 用档案里的"历史最佳"拼一份 RunSummary，让主界面也能显示成就进度。
 *
 * 取的都是**最大/最好**值，所以得到的是"按历史最佳推算的进度"，
 * 与通关时的真实判定可能略有出入（比如单局内持装数无法反推），
 * 但用于展示"还差多少"已经足够，且永远不会让玩家看到进度倒退。
 */
function bestEverSummary(): RunSummary {
    const profile = SaveManager.getProfile();
    const cleared = profile.clearedLevels || [];
    const seen = profile.seenForms || [];

    let bestLevel = 0;
    for (const l of cleared) if (l > bestLevel) bestLevel = l;

    // 最高形态层从图鉴反推：见过的形态里 depth 最大的那个
    let maxDepth = 0;
    for (const id of seen) {
        const f = getForm(id);
        if (f && f.depth > maxDepth) maxDepth = f.depth;
    }
    if (maxDepth > FORM_MAX_DEPTH) maxDepth = FORM_MAX_DEPTH;

    // 是否曾经带加难通过（取历史最大加难百分比）
    let bestBoost = 0;
    const boosts = profile.replayBoosts || {};
    for (const k of Object.keys(boosts)) {
        if (boosts[k] > bestBoost) bestBoost = boosts[k];
    }

    return {
        levelId: bestLevel,
        tier: profile.globalMaxTier || 1,
        cleared: cleared.length > 0,
        // 无伤通关没有被持久化（它只在结算那一刻有意义），这里保守地报 false，
        // 对应成就只能靠真实通关来解锁
        noDamage: false,
        score: 0,
        time: 0,
        kills: profile.totalKills || 0,
        goldEarned: 0,
        usedAffinity: (profile.affinityClearCount || 0) > 0,
        boosted: bestBoost > 0,
        boostPercent: bestBoost,
        fusions: profile.fusionCount || 0,
        maxDepth,
        forms: seen,
        // 天赋层数没有持久化到档案（它属于单局状态），这里给空表，
        // talentStacks 成就在面板上显示 0 进度，靠通关解锁
        talents: {},
        // 单局持装数无法从档案反推，同理
        weaponCount: 0,
        auxCount: 0,
    };
}
