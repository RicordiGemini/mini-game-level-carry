/**
 * 游戏入口 —— 把各模块串起来的可运行示例
 *
 * 挂在启动场景的 Canvas 上。
 *
 * 场景结构：
 *   Canvas
 *   ├── GameEntry          (空节点，挂本脚本)
 *   ├── LevelSelectPanel   关卡选择界面
 *   ├── DifficultyPanel    难度选择面板（普通 / 困难 / 噩梦）
 *   ├── EquipPanel         局外装备面板（升级 / 切换出战）
 *   ├── BattleLayer        闯关玩法层
 *   │   ├── Arena          Graphics + UITransform，尺寸即战场尺寸（建议 720×1280）
 *   │   ├── DragInput      拖动走位输入
 *   │   └── HudLabel       Label —— 实时显示本关数据与每件武器的瞄准方式
 *   ├── LoadoutPanel        装备继承选择面板（默认 active = false）
 *   ├── ReplayEnhancePanel  复玩加难面板 · 选择加难百分比（默认 active = false）
 *   ├── RewardPanel         局内三选一面板（默认 active = false）
 *   ├── TreePanel           进化图鉴 / 合成配方（默认 active = false，主界面手动开）
 *   ├── AchievementPanel    成就面板（默认 active = false，主界面手动开）
 *   └── ResultPanel         通关结算面板（默认 active = false）
 *
 * 【战斗层如何与装备系统对接】
 * 双方唯一的接口是两个纯数据：
 *   EquipmentManager.buildWeapons(loadout, stats, mod, affinityMul) → WeaponSpec[]   开打前灌一次
 *   LevelFlow.inst.onEnemyKilled()                                                   每击杀一只调一次
 * 战斗层不认识"装备等级""形态图""合成"，装备系统也不认识"敌人""判定体"。
 * 三选一选完之后调用 BattleLayer.syncWeapons() 把新参数推过去，当场生效。
 *
 * 【难度维度在哪里生效】
 *   LevelConfig.getLevelConfig(levelId, tier) → 敌人血量/攻击/数量/远程怪比例
 *   DifficultyConfig.getEquipSlotCount(globalTier) → 出战槽位数量
 *   EquipmentConfig.isEquipUnlocked(...) → 新装备是否发放
 * 三处都由 LevelFlow 在通关时统一触发，入口层只负责把 cfg 传给战斗层。
 */

import { _decorator, Component, Label, Node, Vec3, Tween, tween } from 'cc';
import { LevelFlow, SettlePayload } from './core/LevelFlow';
import { EquipmentManager, getMaxEquipped } from './core/EquipmentManager';
import { SaveManager } from './core/SaveManager';
import { AdReward } from './ad/AdReward';
import {
    CombatPower, ElementId, EquipRunState, EvolutionEvent, LevelConfigItem, LevelState,
} from './data/GameTypes';
import { auxSlotCap, weaponSlotCap, levelExpFor, MAX_RUN_LEVEL } from './data/RunConfig';
import { getTalentDef } from './data/TalentConfig';
import { expToEvolve, readyEvolutions } from './core/FormGraph';
import { armorCounterBreak, currentResist, grantStoneByAd, maxCounterBreak } from './core/ForgeManager';
import {
    elementDamageMul, levelElementText, levelElementDesc, elementsForLevel,
    ELEMENT_IDS, getElementDef,
} from './data/ElementConfig';
import { setElementResolver } from './battle/BattleWorld';
import { WeaponSpec, PLAYER_SPEED } from './battle/BattleTypes';
import { TutorialLayer } from './ui/TutorialLayer';
import { TutorialManager } from './core/TutorialManager';
import { LevelSelectPanel } from './ui/LevelSelectPanel';
import { DifficultyPanel } from './ui/DifficultyPanel';
import { EquipPanel } from './ui/EquipPanel';
import { BattleLayer } from './ui/BattleLayer';
import { TreePanel } from './ui/TreePanel';
import { AchievementPanel } from './ui/AchievementPanel';
import { ForgePanel } from './ui/ForgePanel';
import { CounterPanel } from './ui/CounterPanel';
import { GachaPanel } from './ui/GachaPanel';
import { DefeatPanel } from './ui/DefeatPanel';

const { ccclass, property } = _decorator;

@ccclass('GameEntry')
export class GameEntry extends Component {
    @property(Label) hudLabel: Label = null!;
    @property(Node) levelSelectPanel: Node = null!;
    @property(Node) difficultyPanel: Node = null!;
    @property(Node) equipPanel: Node = null!;
    @property(Node) battleLayer: Node = null!;
    /** 战斗层组件，挂在 battleLayer 节点上 */
    @property(BattleLayer) battle: BattleLayer = null!;
    @property(Label) evolveToast: Label = null!;
    @property(Node) loadoutPanel: Node = null!;
    @property(Node) resultPanel: Node = null!;
    /** 三选一面板（REWARD 阶段显示，战斗冻结在背后） */
    @property(Node) rewardPanel: Node = null!;
    /** 复玩加难面板（REPLAY_BOOST 阶段显示） */
    @property(Node) replayPanel: Node = null!;
    /** 进化图鉴 / 合成配方面板（主界面手动打开） */
    @property(Node) treePanel: Node = null!;
    /** 成就面板（主界面手动打开） */
    @property(Node) achievementPanel: Node = null!;
    /** 锻造面板（突破 / 镶嵌 / 碎片合成 / 防具，主界面手动打开） */
    @property(Node) forgePanel: Node = null!;
    /** 许愿面板（主界面手动打开） */
    @property(Node) gachaPanel: Node = null!;
    /** 属性克制面板（对局角落常驻，24 种属性下是必需品） */
    @property(Node) counterPanel: Node = null!;

    /** 本局开打时的战力快照，HUD 展示用 */
    private _power: CombatPower | null = null;
    /** 防止通关/战败回调重复触发 */
    private _settling = false;

    start(): void {
        // 0. 把属性克制规则注入战斗层。
        //    战斗层不认识属性表（它只认字符串 key），
        //    注入之后属性克制才真正生效；不注入时战斗层返回 ×1。
        // 第三个参数是破防值 —— 战斗层用它把克制倍率向 1.0 收敛
        setElementResolver((weaponEls, enemyEl, counterBreak) =>
            elementDamageMul(weaponEls as ElementId[], enemyEl as ElementId, counterBreak));

        // 1. 初始化广告实例（复用 + 预加载）
        AdReward.init();

        // 2. 订阅流程事件
        LevelFlow.inst.onStart((state, cfg) => this.onLevelStart(state, cfg));
        LevelFlow.inst.onEvolve((events) => this.onEvolve(events));
        LevelFlow.inst.onLoadoutChanged(() => this.syncCombatLoadout());
        LevelFlow.inst.onSettle((payload) => this.onLevelSettled(payload));
        LevelFlow.inst.onDefeat((payload) => {
            DefeatPanel.ensure(this.node.parent || this.node).show(payload);
            this.syncLayerByPhase();
        });
        DefeatPanel.ensure(this.node.parent || this.node);

        // 3. 启动：校准装备 → 续玩未打完的单局 / 进入关卡选择
        LevelFlow.inst.boot();
        this.positionPanelCloseButtons();
        this.syncLayerByPhase();

        // 第十轮：首次进入游戏播放新手引导（已看过则跳过）。
        // CTA「开始第 1 关」直接打开第 1 关。
        if (TutorialManager.needNewbie()) {
            TutorialLayer.startNewbie(() => LevelFlow.inst.openLevel(1));
        }
    }

    // ------------------------------------------------------------ 场景切换

    /**
     * 按流程阶段拨动各面板的显隐。
     *
     * 【REWARD 显示战斗、REPLAY_BOOST 不显示】
     *
     *   REWARD 是**战斗中**弹出来的（升级了），此时战斗只是被冻结，
     *   让玩家看着自己刚打出来的战场做选择，比切到空界面再切回来更连贯。
     *
     *   REPLAY_BOOST 是**进关之前**弹出来的（本局还没开始）。
     *   这时候战斗层里留着的只是上一关的残留画面，
     *   把它显示出来会让玩家以为"我已经开打了"，是明确的误导。
     *   所以这两者必须分开处理，不能统一按 atBattle 算。
     */
    private syncLayerByPhase(): void {
        const phase = LevelFlow.inst.phase;
        const atBattle = phase === 'PLAYING' || phase === 'REWARD';

        if (this.levelSelectPanel) this.levelSelectPanel.active = phase === 'SELECT';
        if (this.difficultyPanel) this.difficultyPanel.active = phase === 'DIFFICULTY';
        // equipPanel 由 openEquipPanel / EquipPanel.close 自己管显隐，不在这里拨 ——
        // 它是个"随时能开、自己关"的工具面板，跟着阶段强制显隐会把它顶在最前面
        if (this.battleLayer) this.battleLayer.active = atBattle;
        if (this.loadoutPanel) this.loadoutPanel.active = phase === 'LOADOUT';
        if (this.resultPanel) this.resultPanel.active = phase === 'SETTLE';
        if (this.rewardPanel) this.rewardPanel.active = phase === 'REWARD';
        if (this.replayPanel) this.replayPanel.active = phase === 'REPLAY_BOOST';
        if (DefeatPanel.instance) DefeatPanel.instance.node.active = phase === 'DEFEAT';

        // 图鉴 / 成就属于"主界面工具"，只有在关卡选择、难度选择、备战这几个
        // 非战斗阶段才有意义。一旦进入战斗或结算，就把它们收起来，
        // 免得玩家点着点着把面板带进了战场。
        // 克制面板只在战场里存在
        if (!atBattle) this.counterPanel?.getComponent(CounterPanel)?.hide();

        if (!this.isMainMenuPhase(phase)) {
            this.treePanel?.getComponent(TreePanel)?.close();
            this.achievementPanel?.getComponent(AchievementPanel)?.close();
            this.forgePanel?.getComponent(ForgePanel)?.close();
        }
    }

    /** 只有这几个阶段允许打开图鉴 / 成就 */
    private isMainMenuPhase(phase: string): boolean {
        return phase === 'SELECT' || phase === 'DIFFICULTY' || phase === 'LOADOUT';
    }

    private onLevelStart(state: LevelState, cfg: LevelConfigItem): void {
        this._settling = false;
        this._power = LevelFlow.inst.getCombatPower();

        const carryText = state.carrySource === 'archive' ? '（看广告继承该难度档案）' :
            state.carrySource === 'lowerTier' ? '（默认继承上一难度装备）' : '（初始数据）';
        const boostText = state.replay.percent > 0
            ? '　复玩加难 +' + Math.round(state.replay.percent * 100) + '%' : '';
        console.log('[Game] 进入第 ' + state.levelId + ' 关 · ' + cfg.diff.name + carryText + boostText);

        this.syncLayerByPhase();
        this.hideToast();

        // 第十轮：首次正式进入战斗（且新手引导已看完）时补一句操作提示。
        // 新手引导本身已讲移动/自动开火，引导流程内不再重复弹。
        if (TutorialManager.hasSeen('newbie')) {
            TutorialLayer.showTipById('tip_move');
        }

        // 真正开打：把装备翻译成战斗参数，交给战斗层
        if (this.battle) {
            const mod = LevelFlow.inst.getModifier();
            const weapons = EquipmentManager.buildWeapons(
                state.loadout, state.stats, mod, LevelFlow.inst.getAffinityMul());
            const hp = (state.stats['hp'] ?? 100) + mod.maxHpFlat;

            this.battle.begin(cfg, weapons, hp, {
                onEnemyKilled: (enemyId, expValue, formExpValue) => this.onEnemyKilled(enemyId, expValue, formExpValue),
                onCleared: () => this.onBattleWin(),
                onDefeat: () => this.onBattleLost(),
                onPlayerHurt: (dmg) => LevelFlow.inst.notePlayerHurt(dmg),
            }, {
                // 护盾 / 荆棘是玩家侧属性，走 setup 而不是武器表 ——
                // 它们是"玩家被打时生效"的，挂在武器上会在合成时丢失
                shield: mod.shield,
                playerSpeed: PLAYER_SPEED * (1 + mod.moveSpeedPct),
                killedEnemyIds: state.killedEnemyIds,
                waveProgress: state.waveProgress,
                thorns: mod.thorns,
                // 属性抗性同理：防具是局外穿戴的，不进 buildWeapons
                resist: currentResist(),
                // 无视抗性（石 / 时间属性镶嵌）
                pierceResist: mod.pierceResist,
                // ★ 破防：装备够好就无视克制。取出战武器里最高的那一件
                counterBreak: maxCounterBreak(
                    weapons.map((w) => w.equipId).filter((id) => !!id)
                ),
            });
            this.updateCounterPanel(state.levelId, weapons);
            this.battle.dragInput?.reset();

            const desc = weapons.map((w) => w.name + '(' + w.aimText + ')').join(' + ') || '无武器';
            console.log('[Game] 出战武器：' + desc +
                (weapons.length > 0 && LevelFlow.inst.getAffinityMul() > 1 ? '　★本关推荐武器加成生效' : '') +
                '　本关属性：' + levelElementText(state.levelId));
        }

        this.refreshHud();
    }

    // ------------------------------------------------------------ 战斗事件

    /**
     * 击杀一只敌人。
     * 加分 / 掉资源 / 涨经验 / 推进化全部由 LevelFlow 处理，战斗层不管这些。
     * 若触发了进化，onEvolve 回调会负责表现与同步。
     */
    private onEnemyKilled(enemyId: number, expValue: number, formExpValue?: number): void {
        LevelFlow.inst.onEnemyKilled(enemyId, expValue, formExpValue);
    }

    /** 所有选卡与击杀成长共用此入口，冷却、生命损失和护盾消耗保留。 */
    private syncCombatLoadout(): void {
        const flow = LevelFlow.inst;
        const state = flow.current;
        if (!state || !this.battle) return;
        const mod = flow.getModifier();
        const weapons = EquipmentManager.buildWeapons(state.loadout, state.stats, mod, flow.getAffinityMul());
        this.battle.syncWeapons(weapons);
        this.battle.world.syncPlayerStats({
            maxHp: (state.stats['hp'] ?? 100) + mod.maxHpFlat,
            speed: PLAYER_SPEED * (1 + mod.moveSpeedPct),
            shield: mod.shield,
            thorns: mod.thorns,
            resist: currentResist(),
            pierceResist: mod.pierceResist,
            counterBreak: maxCounterBreak(weapons.map((w) => w.equipId).filter((id) => !!id)),
        });
        this._power = flow.getCombatPower();
        this.updateCounterPanel(state.levelId, weapons);
        this.refreshHud();
    }

    private onBattleWin(): void {
        if (this._settling) return;
        this._settling = true;
        this.reportElementStats();

        LevelFlow.inst.onLevelClear();
        this.syncLayerByPhase();
    }

    private onLevelSettled(p: SettlePayload): void {
        this._settling = true;
        console.log('[Game] 第 ' + p.levelId + ' 关 · ' + p.difficultyName + ' 通关，得分 ' + p.score +
            '，耗时 ' + p.elapsed.toFixed(1) + 's，金币 +' + p.goldGained +
            '，档案已写入');
        if (p.tierJustUnlocked) {
            console.log('[Game] 解锁第 ' + p.levelId + ' 关难度 ' + p.nextTier +
                '，全局最高难度 ' + LevelFlow.inst.globalMaxTier +
                '，出战槽位 ' + EquipmentManager.getEquippedIds().length + ' 件已就绪');
        }
        this.syncLayerByPhase();

        // 第十轮：首次通关结算时解释产出去向（金币升级 / 水晶抽卡 / 更高难度）
        TutorialLayer.showTipById('tip_clear');
    }

    /**
     * 战败：先持久化并弹出选择面板，不自动替玩家重开。
     * 本局成长仍保留，永久奖励要等通关后才入账。
     */
    private onBattleLost(): void {
        if (this._settling) return;
        this._settling = true;
        // 战败也要上报：属性抗性减免了多少伤害是"已经赚到的"，
        // 不该因为这一局输了就不算数
        this.reportElementStats();
        console.log('[Game] 战败，等待玩家选择复活、重试或返回关卡选择');
        this.showToast('被击倒了');
        LevelFlow.inst.markDefeat();
        this.syncLayerByPhase();
    }

    /**
     * 刷新对局角落的属性克制面板。
     *
     * 24 种属性下这是**必需品**而不是装饰：玩家不可能记住 24×24 的表，
     * 不把"我这套武器打这一关到底是什么关系"写出来，
     * 属性系统就退化成查字典。
     */
    private updateCounterPanel(levelId: number, weapons: WeaponSpec[]): void {
        const panel = this.counterPanel?.getComponent(CounterPanel);
        if (!panel) return;
        const els = elementsForLevel(levelId);
        const brk = maxCounterBreak(weapons.map((w) => w.equipId).filter((id) => !!id));
        panel.show(els, weapons, brk);
        console.log('[Game] 本关属性：' + levelElementDesc(levelId) +
            '　破防 ' + Math.round(brk * 100) + '%');
    }

    /**
     * 把本局的属性统计交给流程层。
     *
     * 走显式上报而不是让 LevelFlow 反查战斗层 ——
     * 流程层不该认识战斗层的对象，两者之间只过纯数据。
     */
    private reportElementStats(): void {
        const st = this.battle && this.battle.world ? this.battle.world.stats : null;
        if (!st) return;
        LevelFlow.inst.noteElementStats(st.elementDamage || 0, st.resistReduced || 0);
    }

    // ------------------------------------------------------------ 装备进化表现

    /**
     * 装备进化 / 合成回调 —— 这里做三件事：
     *   1. 把新参数灌进战斗层（**当场生效**，这是"进化"爽感的来源）
     *   2. 刷新 HUD
     *   3. 播放飘字
     *
     * 合成与升级共用这条回调，但文案必须分开写 ——
     * "两件武器合一"和"一件武器变强"在玩家认知里是两件事，
     * 合成时如果不把被吃掉的那件武器名字报出来，玩家会觉得装备凭空少了。
     */
    private onEvolve(events: EvolutionEvent[]): void {
        if (!events || events.length === 0) return;

        // 第十轮：首次进化时解释「进化」这条成长线
        TutorialLayer.showTipById('tip_evolve');

        this._power = LevelFlow.inst.getCombatPower();
        this.refreshHud();

        const texts: string[] = [];
        for (const e of events) {
            const mode = e.attackModeText ? '（' + e.attackModeText + '）' : '';
            if (e.type === 'fusion') {
                texts.push(e.fromName + ' + ' + (e.consumedName || '材料') + ' 合成 ' + e.toName +
                    '！伤害合并' + mode + '　武器槽 -1，可再选一件武器');
            } else {
                texts.push(e.equipName + ' 进化为 ' + e.toName +
                    '！攻击 +' + Math.round(e.atkPct * 100) + '%' + mode);
            }
        }
        const msg = texts.join('\n');
        console.log('[Evolve] ' + msg.replace(/\n/g, ' / '));
        this.showToast(msg);
    }

    private showToast(msg: string): void {
        if (!this.evolveToast) return;
        this.evolveToast.node.active = true;
        this.evolveToast.string = msg;

        this.evolveToast.node.setScale(new Vec3(0.7, 0.7, 1));
        Tween.stopAllByTarget(this.evolveToast.node);
        tween(this.evolveToast.node)
            .to(0.18, { scale: new Vec3(1.1, 1.1, 1) })
            .to(0.12, { scale: new Vec3(1, 1, 1) })
            .delay(1.6)
            .call(() => this.hideToast())
            .start();
    }

    private hideToast(): void {
        if (this.evolveToast) this.evolveToast.node.active = false;
    }

    // ------------------------------------------------------------ 主循环

    update(dt: number): void {
        const phase = LevelFlow.inst.phase;

        // 阶段可能在上一帧的按钮回调中已经改变（例如三选一选卡后
        // REWARD -> PLAYING）。先统一同步一次节点显隐，再决定本帧是否
        // 推进战斗，避免奖励面板残留在屏幕上而战斗已经恢复。
        this.syncLayerByPhase();

        // 三选一 / 复玩加难面板打开时，战斗必须真的停住 ——
        // 只是"不画"而继续推进世界，会让玩家在选卡时被围殴致死
        if (phase === 'REWARD' || phase === 'REPLAY_BOOST') {
            return;
        }

        if (phase !== 'PLAYING') {
            return;
        }

        LevelFlow.inst.addElapsed(dt);

        // 战斗推进交给战斗层，入口只负责驱动与刷新 HUD
        if (this.battle) {
            this.battle.tick(dt);
            LevelFlow.inst.noteWaveProgress(this.battle.world?.waveProgress);
        }
        LevelFlow.inst.flushBattleRewards();
        this.refreshHud();
    }

    private refreshHud(): void {
        if (!this.hudLabel) return;

        const lines: string[] = [];

        if (this.battle && this.battle.playing) {
            // 战斗进行中：直接展示战斗层的实时数据（含每件武器的瞄准方式）
            lines.push(this.battle.getHudText());
        } else {
            const s = LevelFlow.inst.current;
            if (s) {
                const d = LevelFlow.inst.getCurrentDifficulty();
                lines.push('第 ' + s.levelId + ' 关 · ' + (d ? d.name : '普通') +
                    (s.carried ? ' · 已继承装备' : '') +
                    '　得分 ' + s.score + '　击杀 ' + s.kills);
            }
        }

        const p = this._power ?? LevelFlow.inst.getCombatPower();
        if (p) {
            lines.push('总战力 ' + p.finalDamage + '（基础 ' + p.baseDamage +
                ' +' + Math.round(p.atkPct * 100) + '%）　距离 ×' + p.rangeMul +
                '　' + p.attackModeText + '/' + p.aimModeText);
        }

        // 逐件装备显示进化进度，让玩家看得到"再打几只就能进化"
        const s2 = LevelFlow.inst.current;
        if (s2) {
            const carry = s2.carrySource !== 'none';
            const lo = s2.loadout;

            const expNeed = levelExpFor(lo.level);
            const exp = Math.max(0, Math.floor(lo.pendingExp));
            const expText = lo.level >= MAX_RUN_LEVEL
                ? '经验已满'
                : '经验 ' + exp + '/' + expNeed + ' ' + this.expBar(exp / Math.max(1, expNeed));
            lines.push('Lv.' + lo.level + '　' + expText + '　武器 ' + lo.weapons.length + '/' + weaponSlotCap(carry) +
                '　辅助 ' + lo.auxes.length + '/' + auxSlotCap(carry));

            for (const st of lo.weapons) {
                lines.push('　· ' + this.slotLine(st));
            }
            for (const st of lo.auxes) {
                lines.push('　◇ ' + this.slotLine(st));
            }

            // 天赋不占槽位，单独一行汇总，让玩家知道"这条线我叠了多厚"
            const talentText = this.talentSummary(lo.talents);
            if (talentText) lines.push('　天赋　' + talentText);
        }

        const prof = SaveManager.getProfile();
        lines.push('金币 ' + prof.gold +
            '　出战槽位 ' + EquipmentManager.getEquippedIds().length + '/' + getMaxEquipped() +
            '　全局最高难度 ' + LevelFlow.inst.globalMaxTier +
            '　成就 ' + prof.achievements.length +
            '　图鉴 ' + prof.seenForms.length +
            '　看广告 ' + prof.totalAdViews + ' 次');

        this.hudLabel.string = lines.join('\n');
    }

    /**
     * 一行槽位信息："裂空剑（攻击 +160% · 全屏）　再 120 经验进化"
     * 攒够经验就改成明确的"可进化"提示 —— HUD 上最该被一眼看到的就是它。
     */
    private slotLine(st: EquipRunState): string {
        const desc = EquipmentManager.describeSlot(st);
        if (st.kind === 'weapon') {
            const state = LevelFlow.inst.current;
            const ready = state && readyEvolutions(state.loadout, state.carrySource !== 'none')
                .some(m => m.kind === 'weapon' && state.loadout.weapons[m.slotIndex] === st);
            return desc + (ready ? '　★可进化' : '');
        }
        const need = expToEvolve(st);
        if (need < 0) return desc + '　已至当前上限';
        if (need === 0) return desc + '　★可进化';
        return desc + '　再 ' + need + ' 经验进化';
    }

    private expBar(progress: number): string {
        const width = 8;
        const filled = Math.round(Math.max(0, Math.min(1, progress)) * width);
        return '[' + '■'.repeat(filled) + '·'.repeat(width - filled) + ']';
    }

    private positionPanelCloseButtons(): void {
        const panels = [
            this.difficultyPanel, this.equipPanel, this.treePanel,
            this.achievementPanel, this.forgePanel, this.gachaPanel,
        ];
        for (const panel of panels) {
            const close = panel?.getChildByName('closeBtn');
            close?.setPosition(250, 560, 0);
        }
    }

    /** 天赋层数汇总，如"狂暴 ×3 · 疾风 ×1" */
    private talentSummary(talents: Record<string, number>): string {
        const parts: string[] = [];
        for (const k of Object.keys(talents)) {
            const n = talents[k];
            if (n <= 0) continue;
            const def = getTalentDef(k);
            parts.push((def ? def.name : k) + ' ×' + n);
        }
        return parts.join(' · ');
    }

    /** 从关卡选择进入关卡后，回来时刷新列表状态 */
    public onBackToSelect(): void {
        this.syncLayerByPhase();
        this.levelSelectPanel?.getComponent(LevelSelectPanel)?.rebuild();
    }

    // ------------------------------------------------------------ 主界面按钮入口

    /** 打开局外装备面板 */
    public openEquipPanel(): void {
        this.closeInfoPanels();
        this.equipPanel?.getComponent(EquipPanel)?.show();
    }

    public openGachaPanel(): void {
        this.closeInfoPanels();
        this.gachaPanel?.getComponent(GachaPanel)?.open('weapon');
    }

    /** 打开进化图鉴（"哪些武器可以合成"就靠它回答） */
    public openTreePanel(): void {
        this.closeInfoPanels();
        if (!this.isMainMenuPhase(LevelFlow.inst.phase)) {
            this.showToast('战斗中无法查看图鉴');
            return;
        }
        this.treePanel?.getComponent(TreePanel)?.open();
    }

    /** 打开成就面板 */
    public openAchievementPanel(): void {
        this.closeInfoPanels();
        if (!this.isMainMenuPhase(LevelFlow.inst.phase)) {
            this.showToast('战斗中无法查看成就');
            return;
        }
        this.achievementPanel?.getComponent(AchievementPanel)?.open();
    }

    /**
     * 打开锻造面板（突破 / 镶嵌 / 碎片合成 / 防具）。
     *
     * 面板里**没有任何看广告的入口** —— 属性材料全部靠碎片合成，
     * 广告加速只挂在结算页，这是一个可选入口而不是必经流程。
     */
    public openForgePanel(): void {
        this.closeInfoPanels();
        if (!this.isMainMenuPhase(LevelFlow.inst.phase)) {
            this.showToast('战斗中无法锻造');
            return;
        }
        this.forgePanel?.getComponent(ForgePanel)?.open();
    }

    /** 关闭图鉴 / 成就 / 锻造 */
    public closeInfoPanels(): void {
        if (this.equipPanel) this.equipPanel.active = false;
        this.treePanel?.getComponent(TreePanel)?.close();
        this.achievementPanel?.getComponent(AchievementPanel)?.close();
        this.forgePanel?.getComponent(ForgePanel)?.close();
        this.gachaPanel?.getComponent(GachaPanel)?.close();
    }

    // ------------------------------------------------------------ 调试入口（上线前删掉）

    /** 调试：强制通关当前关 */
    debugClear(): void {
        this.onBattleWin();
    }

    /** 调试：本局玩崩了，清空本局数据重开（档案保留） */
    debugResetCurrent(): void {
        const s = LevelFlow.inst.current;
        if (s) LevelFlow.inst.startFresh(s.levelId, s.difficulty);
    }

    /** 调试：直接解锁某一关的某一难度，用来验证难度面板与槽位解锁 */
    debugUnlockTier(levelId: number, tier: number): void {
        SaveManager.unlockTier(levelId, tier);
        EquipmentManager.syncProfile();
        this.levelSelectPanel?.getComponent(LevelSelectPanel)?.rebuild();
        this.difficultyPanel?.getComponent(DifficultyPanel)?.rebuildItems();
        this.refreshHud();
    }

    /** 调试：给当前关大量经验，测试形态进化、三选一与"进化当场生效" */
    debugFeedExp(amount: number): void {
        LevelFlow.inst.debugGainExp(amount);
        this.refreshHud();
    }

    /** 调试：跳过等待，直接结算（验证成就与档案写入） */
    debugReplayBoost(percent: number): void {
        const s = LevelFlow.inst.current;
        if (!s) return;
        LevelFlow.inst.replayWithMoreBoost(percent);
    }

    /** 调试：立刻弹出三选一，验证面板与候选池（不依赖打到升级） */
    debugOpenReward(): void {
        LevelFlow.inst.debugGainExp(100000);
        this.refreshHud();
    }

    /** 调试：直接发放永久金币，测试局外升级 */
    debugAddGold(amount: number): void {
        SaveManager.addGold(amount);
        this.equipPanel?.getComponent(EquipPanel)?.rebuild();
        this.refreshHud();
    }

    /**
     * 调试：直接发放突破材料。
     * 用途是验证"突破 → 槽位增加 → 能多镶一个属性"这条链，
     * 不用真的打十几次关卡攒材料。
     */
    debugAddMaterial(type: string, n = 99): void {
        const p = SaveManager.getProfile();
        if (!p.materials) p.materials = {};
        p.materials['mat_' + type] = (p.materials['mat_' + type] || 0) + n;
        SaveManager.saveProfile(p);
        console.log('[Debug] 突破材料 mat_' + type + ' ×' + n);
    }

    /** 调试：直接发放某属性的完整材料（跳过 10 个碎片的攒） */
    debugAddStone(element: string, n = 10): void {
        grantStoneByAd(element as ElementId);
        console.log('[Debug] 完整属性材料 stone_' + element + '（走的是"广告加速"同一条路径）');
        void n;
    }

    /** 调试：发放 24 种属性碎片各 10 个，用于验证全属性石合成 */
    debugAddAllShards(n = 10): void {
        const p = SaveManager.getProfile();
        if (!p.shards) p.shards = {};
        for (const e of ELEMENT_IDS) p.shards['shard_' + e] = n;
        SaveManager.saveProfile(p);
        console.log('[Debug] 24 种属性碎片各 ×' + n);
    }

    /** 调试：打印当前战斗层快照 */
    debugBattle(): void {
        if (!this.battle) return;
        const w = this.battle.world;
        console.log('[Battle] 玩家', w.player.pos, 'HP', w.player.hp + '/' + w.player.maxHp);
        for (const wep of w.weapons) {
            console.log('[Battle] 武器', wep.name, wep.aimText, 'cd=' + wep.cd.toFixed(2),
                'locked=' + wep.lockedId);
        }
        console.log('[Battle] 敌人', w.aliveEnemies.length, '判定体', w.projectiles.length);
    }

    /** 调试：打印全部存档 */
    debugDump(): void {
        console.log(SaveManager.dump());
    }
}
