/**
 * 许愿抽卡面板 —— 主界面手动打开
 *
 * 【面板要回答的三个问题】
 *
 *   1. 我有多少水晶？          → 顶部余额 + 能抽几次
 *   2. 我还差多久出新东西？    → 保底进度条
 *   3. 抽到的重复件去哪了？    → 单抽立即弹提示，十连进结果列表
 *
 * 【为什么两个池子用 Tab 切换而不是并排摆两个列表】
 *
 *   武器池 12 项、辅助池 8 项，并排要 20 行，竖屏放不下。
 *   而两个池子的**决策逻辑完全不同**：
 *     武器池抽到 → 影响基础伤害与攻击方式
 *     辅助池抽到 → 影响每局的战斗修正，且要额外花金币升阶
 *   玩家在"这一百水晶花在哪边"上是二选一，不是同时看两个列表。
 *   所以做成切换而不是并列 —— 一次只呈现一个决策。
 *
 * 【与其它面板一致的写法】
 *
 *   静态 _st 存 UI 状态 + refresh() 全量重绘 + 可选链式调用，
 *   这样 ui_e2e 可以在 Node 里直接实例化并驱动事件流，不需要真引擎。
 *
 * 预制体节点结构建议：
 *   GachaPanel (本脚本, 默认 active = false)
 *   ├── TitleLabel       Label —— "许愿祭坛"
 *   ├── CrystalLabel     Label —— 水晶余额 + 单抽/十连花费
 *   ├── WeaponTabBtn (Button) —— 切到武器池
 *   ├── AuxTabBtn (Button)    —— 切到辅助池
 *   ├── PityLabel        Label —— 保底进度
 *   ├── ListLabel        Label —— 池内全部条目与持有状态
 *   ├── SingleBtn (Button)—— 单抽
 *   ├── BatchBtn (Button) —— 十连
 *   ├── ResultLabel      Label —— 最近一次抽卡结果
 *   ├── AuxTitleLabel    Label —— 辅助升阶区
 *   ├── AuxLabel         Label —— 当前辅助的阶数与加成
 *   ├── RankUpBtn (Button)—— 升阶
 *   ├── AdBtn (Button)   —— 看广告补 10 水晶（可选，非必经）
 *   └── CloseBtn (Button)—— 关闭
 */

import { _decorator, Component, Label, Node } from 'cc';
import { SaveManager } from '../core/SaveManager';
import {
    addBlessingByAd, auxRankMulOf, auxRankOf, auxRankUp, auxRankUpCost, blessing,
    buildGachaPanelData, canAuxRankUp, crystals, exchangeHighEquip, fragHigh,
    GachaPanelData, grantCrystalByAd, ownedAuxList, poolIds, pull, sacrificeCrystals,
    sacrificePreview,
} from '../core/GachaManager';
import {
    AUX_MAX_RANK, BLESSING_MAX, CRYSTAL_PER_BLESSING, CRYSTAL_PER_PULL,
    EXCHANGE_RARITY, FRAGS_PER_HIGH_EQUIP, GACHA_POOL_DESC, GACHA_POOL_TEXT,
    GachaPool, MAX_PULL_BATCH, RARITY_WEIGHTS,
} from '../data/GachaConfig';
import { GACHA_MAX_RARITY, rarityName } from '../data/RarityConfig';
import { getForm } from '../data/FormConfig';
import { getEquipDef } from '../data/EquipmentConfig';
import { getArmorDef } from '../data/ArmorConfig';
import { AdReward, AdTag } from '../ad/AdReward';
import { TutorialLayer } from './TutorialLayer';

/** 面板静态状态，测试可直接读取而不必走 UI */
interface GachaPanelState {
    pool: GachaPool;
    /** 升阶区当前选中的辅助 */
    auxIndex: number;
    /** 最近一次抽卡结果的多行文案 */
    resultText: string;
    /** 最近一次的 toast（成功/失败） */
    toast: string;
    /** 碎片兑换区当前选中的装备 id */
    exchangeId: string;
}

const { ccclass, property } = _decorator;

@ccclass('GachaPanel')
export class GachaPanel extends Component {
    @property(Label) titleLabel: Label = null!;
    @property(Label) crystalLabel: Label = null!;
    @property(Node) weaponTabBtn: Node = null!;
    @property(Node) auxTabBtn: Node = null!;
    /** 第八轮：装备池 Tab */
    @property(Node) armorTabBtn: Node = null!;
    /** 第八轮：装备池 Tab */
    @property(Label) pityLabel: Label = null!;
    @property(Label) listLabel: Label = null!;
    @property(Node) singleBtn: Node = null!;
    @property(Node) batchBtn: Node = null!;
    @property(Label) resultLabel: Label = null!;
    @property(Label) auxTitleLabel: Label = null!;
    @property(Label) auxLabel: Label = null!;
    @property(Node) rankUpBtn: Node = null!;
    @property(Node) adBtn: Node = null!;
    @property(Node) closeBtn: Node = null!;

    // ---- 第八轮新增：祝福值 / 碎片兑换 ----
    @property(Label) blessingLabel: Label = null!;
    @property(Node) sacrificeBtn: Node = null!;
    @property(Node) blessAdBtn: Node = null!;
    @property(Label) exchangeTitleLabel: Label = null!;
    @property(Label) exchangeLabel: Label = null!;
    @property(Node) exchangeBtn: Node = null!;
    @property(Node) nextExchangeBtn: Node = null!;

    private _st: GachaPanelState = {
        pool: 'weapon', auxIndex: 0, resultText: '', toast: '', exchangeId: '',
    };
    /** 连点保护：抽卡会扣水晶并写档 */
    private _busy = false;
    /** 测试与结算页入口用：注入确定性 rng */
    public rng: () => number = Math.random;

    // ------------------------------------------------------------ 生命周期

    onLoad(): void {
        this.weaponTabBtn?.on(Node.EventType.TOUCH_END, this.onWeaponTab, this);
        this.auxTabBtn?.on(Node.EventType.TOUCH_END, this.onAuxTab, this);
        this.armorTabBtn?.on(Node.EventType.TOUCH_END, this.onArmorTab, this);
        this.singleBtn?.on(Node.EventType.TOUCH_END, this.onSingle, this);
        this.batchBtn?.on(Node.EventType.TOUCH_END, this.onBatch, this);
        this.rankUpBtn?.on(Node.EventType.TOUCH_END, this.onRankUp, this);
        this.adBtn?.on(Node.EventType.TOUCH_END, this.onAdCrystal, this);
        this.sacrificeBtn?.on(Node.EventType.TOUCH_END, this.onSacrifice, this);
        this.blessAdBtn?.on(Node.EventType.TOUCH_END, this.onBlessAd, this);
        this.exchangeBtn?.on(Node.EventType.TOUCH_END, this.onExchange, this);
        this.nextExchangeBtn?.on(Node.EventType.TOUCH_END, this.onNextExchange, this);
        this.closeBtn?.on(Node.EventType.TOUCH_END, this.close, this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.weaponTabBtn?.off(Node.EventType.TOUCH_END, this.onWeaponTab, this);
        this.auxTabBtn?.off(Node.EventType.TOUCH_END, this.onAuxTab, this);
        this.armorTabBtn?.off(Node.EventType.TOUCH_END, this.onArmorTab, this);
        this.rankUpBtn?.off(Node.EventType.TOUCH_END, this.onRankUp, this);
        this.adBtn?.off(Node.EventType.TOUCH_END, this.onAdCrystal, this);
        this.sacrificeBtn?.off(Node.EventType.TOUCH_END, this.onSacrifice, this);
        this.blessAdBtn?.off(Node.EventType.TOUCH_END, this.onBlessAd, this);
        this.exchangeBtn?.off(Node.EventType.TOUCH_END, this.onExchange, this);
        this.nextExchangeBtn?.off(Node.EventType.TOUCH_END, this.onNextExchange, this);
        this.closeBtn?.off(Node.EventType.TOUCH_END, this.close, this);
    }

    public open(pool: GachaPool = 'weapon'): void {
        this._st = {
            pool,
            auxIndex: Math.max(0, ownedAuxList().length - 1),
            resultText: '',
            toast: '',
            exchangeId: this.defaultExchangeId(pool),
        };
        this.node.active = true;
        this.refresh();

        // 第十轮：首次打开许愿面板解释抽卡与货币
        TutorialLayer.showTipById('tip_gacha');
    }

    public openFromMenu(): void {
        this.open('weapon');
    }

    public close(): void {
        this.node.active = false;
    }

    public get state(): GachaPanelState {
        return this._st;
    }

    public get data(): GachaPanelData {
        return buildGachaPanelData(this._st.pool);
    }

    // ------------------------------------------------------------ 交互

    private onWeaponTab(): void {
        this._st.pool = 'weapon';
        this._st.resultText = '';
        this._st.exchangeId = this.defaultExchangeId('weapon');
        this.refresh();
    }

    private onAuxTab(): void {
        this._st.pool = 'aux';
        this._st.resultText = '';
        this._st.exchangeId = this.defaultExchangeId('aux');
        this.refresh();
    }

    private onArmorTab(): void {
        this._st.pool = 'armor';
        this._st.resultText = '';
        this._st.exchangeId = this.defaultExchangeId('armor');
        this.refresh();
    }

    /** 单抽 */
    onSingle(): void {
        if (this._busy) return;
        this.doPull(1);
    }

    /** 十连 */
    onBatch(): void {
        if (this._busy) return;
        this.doPull(MAX_PULL_BATCH);
    }

    private doPull(count: number): void {
        this._busy = true;
        try {
            const out = pull(this._st.pool, count, this.rng);
            if (out.results.length === 0) {
                this._st.toast = '水晶不足，还差 ' +
                    (CRYSTAL_PER_PULL * count - crystals()) + ' 个';
                this._st.resultText = '';
            } else {
                this._st.toast = out.newIds.length > 0
                    ? ('获得 ' + out.newIds.length + ' 件新收藏')
                    : '全是重复，已转化为材料';
                this._st.resultText = this.formatResults(out.results);
            }
        } finally {
            this._busy = false;
        }
        this.refresh();
    }

    /**
     * 把抽卡结果排成多行文案。
     *
     * 新东西打星号前缀，重复件显示转化去向 ——
     * 玩家最怕的是"抽到重复然后不知道发生了什么"，
     * 所以重复的补偿必须写在结果里，不能只写一句"已转化"。
     */
    private formatResults(results: { name: string; isNew: boolean; duplicateText: string | null }[]): string {
        const lines: string[] = [];
        for (const r of results) {
            lines.push(r.isNew ? ('★ 新 · ' + r.name) : (r.name + '（' + (r.duplicateText || '') + '）'));
        }
        return lines.join('\n');
    }

    /** 辅助升阶 */
    onRankUp(): void {
        if (this._busy) return;
        const list = ownedAuxList();
        if (list.length === 0) {
            this._st.toast = '还没有任何辅助装备，先去抽';
            this.refresh();
            return;
        }
        const cur = list[this._st.auxIndex] || list[0];
        const r = auxRankUp(cur.id);
        this._st.toast = r.ok ? ('升阶成功，当前 ' + r.rank + ' 阶') : ('升阶失败：' + (r.reason || ''));
        this.refresh();
    }

    /**
     * 献祭水晶换祝福值（不抽卡，直接换）。
     *
     * 默认换 3 点（30 水晶）—— 一次十连刚好用得完，
     * 与"看广告得 3 点"等价，让两条路的价值可比。
     */
    onSacrifice(): void {
        if (this._busy) return;
        const got = sacrificeCrystals(3);
        if (got <= 0) {
            const pv = sacrificePreview(3);
            this._st.toast = pv.canDo ? '祝福值已满' : '水晶不足（还需 ' +
                (pv.cost - crystals()) + ' 个）';
        } else {
            this._st.toast = '献祭 ' + (got * CRYSTAL_PER_BLESSING) +
                ' 水晶 → 祝福值 +' + got + '（下次抽卡高阶概率翻倍）';
        }
        this.refresh();
    }

    /** 看广告补祝福值（可选加速） */
    onBlessAd(): void {
        if (this._busy) return;
        const got = addBlessingByAd();
        this._st.toast = got > 0 ? ('祝福值 +' + got) : '祝福值已满（' + BLESSING_MAX + '）';
        this.refresh();
    }

    /** 用高阶碎片兑换选中的装备 */
    onExchange(): void {
        if (this._busy) return;
        const id = this._st.exchangeId;
        if (!id) {
            this._st.toast = '还没有选中要兑换的装备';
            this.refresh();
            return;
        }
        const r = exchangeHighEquip(this._st.pool, id);
        this._st.toast = r.ok
            ? ('兑换成功：' + rarityName(EXCHANGE_RARITY) + ' ' + id)
            : ('兑换失败：' + (r.reason || ''));
        this.refresh();
    }

    /** 循环切换兑换目标 */
    onNextExchange(): void {
        const ids = poolIds(this._st.pool);
        if (ids.length === 0) return;
        const i = ids.indexOf(this._st.exchangeId);
        this._st.exchangeId = ids[(i + 1) % ids.length];
        this.refresh();
    }

    /** 打开面板时给一个合理的默认兑换目标：优先高阶里第一件 */
    private defaultExchangeId(pool: GachaPool): string {
        const ids = poolIds(pool);
        if (ids.length === 0) return '';
        // 优先挑一个高品阶的（兑换给的就是高阶，默认项应对得上）
        for (const id of ids) {
            if (this.rarityOfId(pool, id) >= EXCHANGE_RARITY) return id;
        }
        return ids[0];
    }

    /** 取某件装备的品阶（面板展示用） */
    private rarityOfId(pool: GachaPool, id: string): number {
        if (pool === 'aux') {
            const f = getForm(id);
            return f && f.rarity !== undefined ? f.rarity : 0;
        }
        if (pool === 'armor') {
            const a = getArmorDef(id);
            return a && a.rarity !== undefined ? a.rarity : 0;
        }
        const d = getEquipDef(id);
        return d && d.rarity !== undefined ? d.rarity : 0;
    }

    /** 看广告补水晶（可选加速，不是抽卡的必经之路） */
    async onAdCrystal(): Promise<void> {
        if (this._busy) return;
        this._busy = true;
        try {
            const ok = await AdReward.show(AdTag.CRYSTAL);
            if (ok) {
                grantCrystalByAd(CRYSTAL_PER_PULL);
                this._st.toast = '获得 ' + CRYSTAL_PER_PULL + ' 个许愿水晶';
            } else {
                this._st.toast = '未看完广告，不影响正常抽卡';
            }
        } finally {
            this._busy = false;
        }
        this.refresh();
    }

    // ------------------------------------------------------------ 渲染

    refresh(): void {
        const d = this.data;

        if (this.titleLabel) this.titleLabel.string = '许愿祭坛';
        if (this.crystalLabel) {
            this.crystalLabel.string =
                '许愿水晶 ' + d.crystals +
                '　（单抽 ' + CRYSTAL_PER_PULL + ' · 十连 ' + CRYSTAL_PER_PULL * MAX_PULL_BATCH + '）';
        }
        if (this.pityLabel) {
            this.pityLabel.string = GACHA_POOL_TEXT[d.pool] + '　' + d.pityText;
        }
        if (this.blessingLabel) {
            this.blessingLabel.string =
                '祝福值 ' + blessing() + '/' + BLESSING_MAX +
                '（钻石及以上权重 ' + this.highTierPct(0) + '% → ' +
                this.highTierPct(1) + '%）';
        }

        if (this.listLabel) this.listLabel.string = this.buildListText();

        if (this.resultLabel) {
            const head = this._st.toast ? (this._st.toast + '\n') : '';
            this.resultLabel.string = head + this._st.resultText;
        }

        if (this.singleBtn) {
            const btn = this.singleBtn.getComponent('cc.Button' as never) as unknown as { interactable: boolean } | null;
            if (btn) btn.interactable = d.canSingle;
        }
        if (this.batchBtn) {
            const btn = this.batchBtn.getComponent('cc.Button' as never) as unknown as { interactable: boolean } | null;
            if (btn) btn.interactable = d.canBatch;
        }

        this.refreshAux();
        this.refreshExchange();
    }

    /** 钻石及以上品阶的合计概率（百分比，用于祝福值预览） */
    private highTierPct(withBlessing: number): string {
        const w = RARITY_WEIGHTS.slice();
        let sum = 0;
        for (let i = 3; i < w.length; i++) sum += w[i];
        if (withBlessing > 0) sum = sum * 2;
        return sum.toFixed(0);
    }

    /** 碎片兑换区 */
    private refreshExchange(): void {
        const ids = poolIds(this._st.pool);
        if (this.exchangeTitleLabel) {
            this.exchangeTitleLabel.string =
                '高阶碎片兑换（' + fragHigh() + '/' + FRAGS_PER_HIGH_EQUIP + '）→ ' +
                rarityName(EXCHANGE_RARITY) + '品阶，种类任选';
        }
        if (this.exchangeLabel) {
            const id = this._st.exchangeId || (ids.length > 0 ? ids[0] : '');
            const name = this.nameOfId(this._st.pool, id);
            const rar = this.rarityOfId(this._st.pool, id);
            const owned = this._st.pool === 'aux'
                ? ownedAuxList().some((a) => a.id === id)
                : SaveManager.getProfile().equipment.some((e) => e.id === id);
            this.exchangeLabel.string =
                '当前选中：' + name + '　原生品阶 ' + rarityName(rar) +
                (owned ? '　（已拥有，兑换将按重复件折算）' : '');
        }
        if (this.exchangeBtn) {
            const btn = this.exchangeBtn.getComponent('cc.Button' as never) as unknown as { interactable: boolean } | null;
            if (btn) btn.interactable = fragHigh() >= FRAGS_PER_HIGH_EQUIP;
        }
    }

    /** 面板内取装备名 */
    private nameOfId(pool: GachaPool, id: string): string {
        if (pool === 'aux') {
            const f = getForm(id);
            return f ? f.name : id;
        }
        if (pool === 'armor') {
            const a = getArmorDef(id);
            return a ? a.name : id;
        }
        const d = getEquipDef(id);
        return d ? d.name : id;
    }

    /** 池内全部条目，已持有的打勾、未持有的标注可抽 */
    private buildListText(): string {
        const d = this.data;
        const owned = this._st.pool === 'aux'
            ? ownedAuxList().map((a) => a.id)
            : SaveManager.getProfile().equipment.map((e) => e.id);

        const lines: string[] = [GACHA_POOL_DESC[d.pool], '已收集 ' + d.collected + ' / ' + d.total];
        for (const id of poolIds(this._st.pool)) {
            const has = owned.indexOf(id) >= 0;
            const name = this._st.pool === 'aux'
                ? ((getForm(id) || { name: id }).name)
                : ((getEquipDef(id) || { name: id }).name);
            lines.push((has ? '✓ ' : '· ') + name + (has ? '' : '（未获得）'));
        }
        return lines.join('\n');
    }

    /** 辅助升阶区 */
    private refreshAux(): void {
        const list = ownedAuxList();
        if (this.auxTitleLabel) {
            this.auxTitleLabel.string = '辅助升阶（' + list.length + ' / ' +
                poolIds('aux').length + ' 已收集）';
        }
        if (this.auxLabel) {
            if (list.length === 0) {
                this.auxLabel.string = '尚未拥有辅助装备';
            } else {
                const cur = list[Math.min(this._st.auxIndex, list.length - 1)];
                const f = getForm(cur.id);
                const rank = auxRankOf(cur.id);
                const cost = auxRankUpCost(cur.id);
                const mul = auxRankMulOf(cur.id);
                this.auxLabel.string =
                    (f ? f.name : cur.id) + '　' + rank + ' / ' + AUX_MAX_RANK + ' 阶' +
                    '　加成 ×' + mul.toFixed(2) +
                    (cost >= 0 ? ('　升阶需金币 ' + cost) : '　已满阶');
            }
        }
        if (this.rankUpBtn) {
            const ok = list.length > 0 && canAuxRankUp(
                list[Math.min(this._st.auxIndex, list.length - 1)].id
            );
            const btn = this.rankUpBtn.getComponent('cc.Button' as never) as unknown as { interactable: boolean } | null;
            if (btn) btn.interactable = ok;
        }
    }

    // ------------------------------------------------------------ 测试辅助

    /** 切池（测试驱动用，避免直接改私有状态） */
    public switchPool(pool: GachaPool): void {
        this._st.pool = pool;
        this._st.exchangeId = this.defaultExchangeId(pool);
        this.refresh();
    }

    /** 循环选下一个已持有的辅助 */
    public selectNextAux(): void {
        const n = ownedAuxList().length;
        if (n === 0) return;
        this._st.auxIndex = (this._st.auxIndex + 1) % n;
        this.refresh();
    }

    /** 当前升阶区选中的辅助 id */
    public currentAuxId(): string | null {
        const list = ownedAuxList();
        if (list.length === 0) return null;
        return (list[Math.min(this._st.auxIndex, list.length - 1)] || {}).id || null;
    }
}
