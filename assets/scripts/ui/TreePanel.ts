/**
 * 进化图鉴 / 合成配方面板 —— 主界面手动打开
 *
 * 【为什么这个面板是必须的】
 *
 *   玩家原话："关于进化路线, 需要在主界面显示哪些武器可以合成"。
 *
 *   局内三选一是**机会性**的：合成配方出现的前提是"你手上正好有那两件"，
 *   所以玩家在局内根本不知道自己错过了什么。
 *   必须有地方把完整的图谱摊开给他看 ——
 *   否则"两把武器能合成"这件事永远只是运气，而不是一个可以主动规划的目标。
 *
 *   这个面板同时承担另外两个作用：
 *     1. 给"重复进入"一个明确的理由（★ 标记的进化只有带老档才能拿到）
 *     2. 让"我还没见过的形态"变成一个可见的清单（图鉴收集欲）
 *
 * 【为什么按武器分栏而不是画一张大网】
 *   13 把武器 × 5 层 + 7 条合成配方画成一张图会在手机屏上糊成一团。
 *   按武器分栏后，一栏就是一个"这个武器能长成什么样"的完整故事，
 *   左右/上下滑动切换，阅读成本最低。
 *
 * 预制体节点结构建议：
 *   TreePanel (本脚本, 默认 active = false)
 *   ├── TitleLabel      Label —— "进化图鉴　收录 18/52"
 *   ├── BodyLabel       Label —— 逐行列出当前选中武器的主线 / 分支 / 合成 / 复玩路线
 *   ├── FusionTitleLabel Label —— "合成配方"
 *   ├── FusionLabel     Label —— 全部配方，已解锁的两件材料用实色，未见的用问号
 *   ├── PrevBtn (Button) —— 上一把武器
 *   ├── NextBtn (Button) —— 下一把武器
 *   └── CloseBtn (Button) —— 关闭
 */

import { _decorator, Component, Label, Node } from 'cc';
import { LevelFlow } from '../core/LevelFlow';
import { SaveManager } from '../core/SaveManager';
import {
    ALL_FORMS, FORM_MAX_DEPTH, FUSION_RECIPES, WEAPON_ROOT_IDS,
    FusionRecipe, getForm,
} from '../data/FormConfig';
import {
    advancedTailOf, branchesOf, fusionsInvolving, mainLineOf,
} from '../core/FormGraph';
import { TutorialLayer } from './TutorialLayer';

const { ccclass, property } = _decorator;

/** 未见过的形态用问号遮住名字 —— 图鉴的收集欲全靠它 */
const UNKNOWN = '？？？';

/**
 * 某把武器的**全部血脉**：主线 + 每条分支自己的主线 + 分支的分支，一路收到底。
 *
 * 【为什么不能用 getRecipesFor(rootId) 查合成配方】
 *
 *   getRecipesFor 是按**精确形态 id** 匹配的，而合成配方写的是进化后的形态
 *   （"裂空剑 + 暴雨弩 → 剑雨风暴"，不是"铁剑 + 短弓"）。
 *   于是玩家点进「铁剑」这一栏时什么配方都查不到 ——
 *   而他点进来恰恰就是想知道"我这把武器以后能合成什么"。
 *
 *   按血脉查就没有这个问题：铁剑 → 淬锋剑 → 裂空剑 都在血脉里，
 *   裂空剑参与的配方自然就被捞出来了。
 */
function lineageOf(rootId: string): string[] {
    const out: string[] = [];
    const push = (id: string) => { if (id && out.indexOf(id) < 0) out.push(id); };

    const walkLine = (id: string) => {
        push(id);
        const f = getForm(id);
        if (!f) return;
        for (const e of f.evolveTo) {
            if (e.type !== 'upgrade') continue;
            walkLine(e.to);
        }
    };
    walkLine(rootId);
    return out;
}

@ccclass('TreePanel')
export class TreePanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) bodyLabel: Label = null!;
    @property(Label) fusionTitleLabel: Label = null!;
    @property(Label) fusionLabel: Label = null!;
    @property(Node) prevBtn: Node = null!;
    @property(Node) nextBtn: Node = null!;
    @property(Node) closeBtn: Node = null!;

    private _index = 0;

    onLoad(): void {
        // 关掉面板不需要经过 LevelFlow（它属于"主界面工具"，不属于流程阶段），
        // 所以关闭按钮直接自己收起来。
        this.closeBtn?.on(Node.EventType.TOUCH_END, this.close, this);
        this.prevBtn?.on(Node.EventType.TOUCH_END, this.onPrev, this);
        this.nextBtn?.on(Node.EventType.TOUCH_END, this.onNext, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.closeBtn?.off(Node.EventType.TOUCH_END, this.close, this);
        this.prevBtn?.off(Node.EventType.TOUCH_END, this.onPrev, this);
        this.nextBtn?.off(Node.EventType.TOUCH_END, this.onNext, this);
    }

    /** 打开面板。默认从玩家当前出战的第一把武器开始，最贴近他关心的内容。 */
    public open(startEquipId?: string): void {
        const equipped = SaveManager.getProfile().equippedIds || [];
        const wanted = startEquipId || equipped[0];
        const i = wanted ? WEAPON_ROOT_IDS.indexOf(wanted) : -1;
        this._index = i >= 0 ? i : 0;
        this.node.active = true;
        this.refresh();

        // 第十轮：首次打开进化图鉴解释合成/进化路线
        TutorialLayer.showTipById('tip_tree');
    }

    public close(): void {
        this.node.active = false;
    }

    private onPrev(): void {
        // 循环切换：到最后一把再往后会回到第一把，避免玩家在边缘点不动
        this._index = (this._index - 1 + WEAPON_ROOT_IDS.length) % WEAPON_ROOT_IDS.length;
        this.refresh();
    }

    private onNext(): void {
        this._index = (this._index + 1) % WEAPON_ROOT_IDS.length;
        this.refresh();
    }

    private refresh(): void {
        const rootId = WEAPON_ROOT_IDS[this._index];
        const root = getForm(rootId);
        if (!root) return;

        const seen = SaveManager.getSeenForms();
        const isSeen = (id: string) => seen.indexOf(id) >= 0;
        const lineage = lineageOf(rootId);
        const mine = fusionsInvolving(lineage);

        if (this.titleLabel) {
            this.titleLabel.string =
                '进化图鉴　' + root.name + '　(' + (this._index + 1) + '/' +
                WEAPON_ROOT_IDS.length + ')　收录 ' + seen.length + '/' + ALL_FORMS.length;
        }

        if (this.bodyLabel) {
            this.bodyLabel.string = this.buildRouteText(rootId, isSeen, mine);
        }

        if (this.fusionTitleLabel) {
            this.fusionTitleLabel.string = mine.length > 0
                ? '合成配方（' + root.name + ' 这条线相关 ' + mine.length + ' 条）'
                : '合成配方（' + root.name + ' 这条线不参与合成）';
        }

        if (this.fusionLabel) {
            this.fusionLabel.string = this.buildFusionText(mine, isSeen);
        }
    }

    /**
     * 本武器的一整条路线：
     *   主线（depth 0→4）→ 分支 → 与谁合成 → 复玩限定的更上级
     */
    private buildRouteText(
        rootId: string,
        isSeen: (id: string) => boolean,
        mine: FusionRecipe[]
    ): string {
        const lines: string[] = [];
        const line = mainLineOf(rootId);

        lines.push('【主线】');
        for (const id of line) {
            const f = getForm(id);
            if (!f) continue;
            lines.push('　' + '·'.repeat(f.depth) + ' ' +
                this.nameOf(id, isSeen) +
                '　depth ' + f.depth + '/' + FORM_MAX_DEPTH +
                '　' + f.attackModeText +
                (f.atkPct > 0 ? '　攻击 +' + Math.round(f.atkPct * 100) + '%' : ''));
        }

        const branches = branchesOf(rootId);
        if (branches.length > 0) {
            lines.push('');
            lines.push('【分支路线】');
            for (const e of branches) {
                const f = getForm(e.to);
                if (!f) continue;
                lines.push('　· ' + this.nameOf(e.to, isSeen) + ' —— ' + e.label);
                if (e.desc) lines.push('　　' + e.desc);
                // 分支自己也有一条主线，一起摊开，否则玩家不知道分支能走到哪
                const sub = mainLineOf(e.to).slice(1);
                if (sub.length > 0) {
                    lines.push('　　　→ ' + sub.map((x) => this.nameOf(x, isSeen)).join(' → '));
                }
            }
        }

        // 【可合成】的判定用**血脉**而不是精确 id，
        // 否则玩家在"铁剑"这一栏里看不到"裂空剑 + 暴雨弩"这条配方
        if (mine.length > 0) {
            lines.push('');
            lines.push('【可合成（需要集齐两件材料）】');
            for (const r of mine) {
                lines.push('　· ' + this.nameOf(r.a, isSeen) + ' + ' + this.nameOf(r.b, isSeen) +
                    ' → ' + this.nameOf(r.to, isSeen) + (r.advanced ? '　★复玩限定' : ''));
                if (r.desc) lines.push('　　' + r.desc);
            }
        }

        const adv = advancedTailOf(rootId);
        lines.push('');
        // 这一句是"重复进入"的核心卖点，文案要说清楚"只有带老档才有"
        lines.push('【★ 复玩解锁的更上级进化】');
        if (adv) {
            lines.push('　' + this.nameOf(adv.to, isSeen) + ' —— ' + adv.label);
            if (adv.desc) lines.push('　' + adv.desc);
            lines.push('　※ 只有携带上次通关的装备（老档）重新进入时，这条路线才会出现在三选一里');
        } else {
            lines.push('　这条线暂时没有更上级进化');
        }

        return lines.join('\n');
    }

    /** 全部合成配方；未见过材料的配方用问号遮住，保留"还有东西没解锁"的悬念 */
    private buildFusionText(mine: FusionRecipe[], isSeen: (id: string) => boolean): string {
        const lines: string[] = [];
        const ordered = mine.concat(FUSION_RECIPES.filter((r) => mine.indexOf(r) < 0));

        for (const r of ordered) {
            const known = isSeen(r.a) || isSeen(r.b);
            const head = known
                ? this.nameOf(r.a, isSeen) + ' + ' + this.nameOf(r.b, isSeen) +
                  ' → ' + this.nameOf(r.to, isSeen)
                : UNKNOWN + ' + ' + UNKNOWN + ' → ' + UNKNOWN;
            lines.push((mine.indexOf(r) >= 0 ? '★ ' : '　') + head +
                (r.advanced ? '　[复玩]' : ''));
        }
        return lines.join('\n');
    }

    /** 没见过的形态显示问号；主线首项（初始形态）永远可见，避免整栏全是问号 */
    private nameOf(id: string, isSeen: (id: string) => boolean): string {
        const f = getForm(id);
        if (!f) return UNKNOWN;
        if (f.depth === 0 || isSeen(id)) return f.name;
        return UNKNOWN;
    }

    /** 图鉴进度文案，其他 UI（结算页等）复用 */
    public static collectionText(): string {
        const seen = SaveManager.getSeenForms().length;
        return '图鉴 ' + seen + '/' + ALL_FORMS.length;
    }

    /** 工具：本局是否可以打开图鉴（主界面阶段才允许） */
    public static canOpen(): boolean {
        const p = LevelFlow.inst.phase;
        return p === 'SELECT' || p === 'DIFFICULTY' || p === 'LOADOUT';
    }
}
