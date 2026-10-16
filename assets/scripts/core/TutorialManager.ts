/**
 * 教学管理器（纯逻辑，可单测）。
 *
 * 只负责两件事：
 *   1. 记录/查询「某条教学是否已看过」（持久化进 PlayerProfile.tutorials）；
 *   2. 提供内容查询（新手引导步骤、首通教学文案）。
 *
 * 不负责任何 UI —— UI 交给 ui/TutorialLayer.ts。
 * 这样 e2e 测试可以在 Node 里只验逻辑，不需要 Cocos 运行时。
 */

import { SaveManager } from './SaveManager';
import {
    FIRST_TIME_TIPS, NEWBIE_KEY, NEWBIE_STEPS, TutorialStep, TutorialTip,
} from '../data/TutorialConfig';

export class TutorialManager {
    /** 某条教学是否已看过（看过 = 存档里有这条 key） */
    static hasSeen(id: string): boolean {
        const p = SaveManager.getProfile();
        return !!(p.tutorials && p.tutorials[id]);
    }

    /** 标记某条教学已看过，并写档 */
    static markSeen(id: string): void {
        const p = SaveManager.getProfile();
        if (!p.tutorials) p.tutorials = {};
        if (p.tutorials[id]) return;
        p.tutorials[id] = true;
        SaveManager.saveProfile(p);
    }

    /** 新手引导是否还需要播放（未看过 = 需要） */
    static needNewbie(): boolean {
        return !this.hasSeen(NEWBIE_KEY);
    }

    /** 新手引导全部步骤 */
    static newbieSteps(): TutorialStep[] {
        return NEWBIE_STEPS.slice();
    }

    /** 首通教学：按 id 取文案（不存在返回 null） */
    static getTip(id: string): TutorialTip | null {
        return FIRST_TIME_TIPS[id] || null;
    }

    /** 所有首通教学 id（用于自检/测试） */
    static allTipIds(): string[] {
        return Object.keys(FIRST_TIME_TIPS);
    }

    /**
     * 是否应该弹某条首通教学。
     * 已看过 → false；未看过 → true（并顺手标记，保证"弹过即不再弹"）。
     *
     * @returns 应显示则返回文案，否则返回 null。
     */
    static consumeTip(id: string): TutorialTip | null {
        if (this.hasSeen(id)) return null;
        const tip = FIRST_TIME_TIPS[id];
        if (!tip) return null;
        this.markSeen(id);
        return tip;
    }
}
