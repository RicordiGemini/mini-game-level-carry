/**
 * 战场渲染层 —— 把 BattleWorld 的状态画出来，把 DragInput 的输入喂进去
 *
 * 【为什么用 Graphics 直接画，而不是预制体】
 * 预制体方案需要你先在编辑器里做一套美术资源，工程拿到手跑不起来。
 * 这一版用 Graphics 画圆/矩形，**零美术资源就能真机跑通完整玩法**，
 * 用来验证手感、调数值足够；等手感定下来再逐个换成预制体 + 序列帧。
 *
 * 顶部的武器信息条（每件武器当前的瞄准方式）也在这里维护，
 * 因为"换武器 = 换手感"这件事必须让玩家在局内直接看见。
 */

import { _decorator, Color, Component, Graphics, UITransform } from 'cc';
import {
    AimModeId,
    AttackModeId,
    LevelConfigItem,
} from '../data/GameTypes';
import { buildEnemySpawnSpec } from '../data/LevelConfig';
import { BattleWorld } from '../battle/BattleWorld';
import { ProjectileKind, Vec2, WeaponSpec, v2 } from '../battle/BattleTypes';
import { DragInput, DragState } from './DragInput';

const { ccclass, property } = _decorator;

/** 判定体配色：不同形态一眼可辨，便于调试手感 */
const PROJ_COLOR: Record<ProjectileKind, [number, number, number]> = {
    melee: [255, 213, 79],
    sweep: [255, 183, 77],
    bullet: [129, 199, 132],
    pierce: [77, 208, 225],
    shockwave: [255, 171, 64],
    rain: [186, 104, 200],
    chain: [100, 181, 246],
    meteor: [255, 112, 67],
    wheel: [240, 98, 146],
};

const C_BG = new Color(16, 19, 28, 255);
const C_GRID = new Color(30, 36, 54, 255);
const C_PLAYER = new Color(79, 195, 247, 255);
const C_FACING = new Color(179, 229, 252, 255);
const C_ENEMY = new Color(239, 83, 80, 255);
/** 远程怪用另一个色系：玩家必须一眼分辨"谁是近战谁是狙击手" */
const C_ENEMY_RANGED = new Color(186, 104, 200, 255);
const C_ENEMY_FLASH = new Color(255, 255, 255, 255);
const C_ENEMY_SHOT = new Color(255, 138, 128, 255);
const C_LOCK = new Color(255, 82, 82, 255);
const C_HP_BG = new Color(40, 44, 58, 255);
const C_HP = new Color(102, 187, 106, 255);
const C_HP_LOW = new Color(229, 115, 115, 255);
/** 护盾条配色：与生命条明显区分，避免"血没掉"的误读 */
const C_SHIELD = new Color(77, 182, 240, 255);
const C_JOY = new Color(120, 144, 200, 190);

/** 战斗回调，由 GameEntry 注入 */
export interface BattleLayerHooks {
    /** 击杀一只敌人 */
    onEnemyKilled?: () => void;
    /** 全部清空 */
    onCleared?: () => void;
    /** 玩家阵亡 */
    onDefeat?: () => void;
    /** 玩家掉血 */
    onPlayerHurt?: (dmg: number, remainHp: number) => void;
}

@ccclass('BattleLayer')
export class BattleLayer extends Component {
    /** 战场绘制节点（需要 UITransform，尺寸即战场尺寸） */
    @property(Graphics) gfx: Graphics = null!;

    /** 拖动输入组件 */
    @property(DragInput) dragInput: DragInput = null!;

    /** 是否绘制背景网格（调试用，正式版可关掉换成背景图） */
    @property({ tooltip: '是否绘制背景网格，正式版可关掉换成背景图' })
    drawGrid = true;

    readonly world = new BattleWorld();

    private _hooks: BattleLayerHooks = {};
    private _uiW = 720;
    private _uiH = 1280;
    private _ox = -360;
    private _oy = -640;
    private _started = false;
    /** 伤害飘字：命中时的短暂提示，纯表现 */
    private _hurtFlash = 0;
    private _levelId = 1;
    /** 当前难度名，HUD 展示用 */
    private _diffName = '普通';

    // ================================================================
    // 生命周期
    // ================================================================

    onDisable(): void {
        this.world.running = false;
        this.dragInput?.reset();
    }

    // ================================================================
    // 开局
    // ================================================================

    /**
     * 开始一场战斗。
     *
     * @param cfg      关卡配置（敌人数、血量、分波参数、刷怪阵型）
     * @param weapons  出战武器（来自 EquipmentManager.buildWeapons）
     * @param playerHp 玩家血量（来自关卡内 stats.hp）
     * @param hooks    战斗事件回调
     * @param extra    玩家侧的开局属性：护盾 / 荆棘。
     *                 它们不属于任何一件武器（合成会换武器但护盾还在），
     *                 所以走 setup 而不是塞进 WeaponSpec。
     */
    begin(
        cfg: LevelConfigItem,
        weapons: WeaponSpec[],
        playerHp: number,
        hooks: BattleLayerHooks,
        extra?: {
            shield?: number;
            thorns?: number;
            resist?: Record<string, number>;
            /** 无视抗性的比例（石 / 时间属性） */
            pierceResist?: number;
            /** 破防比例：装备够好就无视克制 */
            counterBreak?: number;
        }
    ): void {
        this._hooks = hooks;
        this._levelId = cfg.levelId;
        this._diffName = cfg.diff ? cfg.diff.name : '普通';
        this.syncTransform();

        this.world.setup({
            arenaW: this._uiW,
            arenaH: this._uiH,
            playerHp: Math.max(1, Math.round(playerHp)),
            weapons,
            enemy: buildEnemySpawnSpec(cfg),
            shield: extra && extra.shield ? Math.max(0, Math.round(extra.shield)) : 0,
            thorns: extra && extra.thorns ? Math.max(0, extra.thorns) : 0,
            // 属性抗性：抗性只减元素伤害、不给免疫（上限 75%）
            resist: extra && extra.resist ? extra.resist : undefined,
            pierceResist: extra && extra.pierceResist ? extra.pierceResist : undefined,
            // ★ 破防：把属性克制倍率向 1.0 收敛，取出战武器里最高的那一件
            counterBreak: extra && extra.counterBreak ? extra.counterBreak : 0,
            // 用「关卡 + 难度」当种子：同一关同一难度的战斗过程可复现，
            // 方便定位"这一关这一难度为什么打不过"的问题
            seed: 1000 + cfg.levelId * 977 + cfg.difficulty * 131,
        });

        // 把世界事件桥接到钩子
        this.bindWorldEvents();

        // 输入：拖动 → 战斗世界
        if (this.dragInput) {
            this.dragInput.setCallback((s: DragState) => this.onDrag(s));
            // FOLLOW 模式需要知道"角色现在在输入区里的哪个位置"
            this.dragInput.setAnchorProvider(() => this.w2l(this.world.player.pos));
        }

        this._started = true;
        this._hurtFlash = 0;
    }

    private bindWorldEvents(): void {
        this.world.cb = {
            onEnemyKilled: () => {
                if (this._hooks.onEnemyKilled) this._hooks.onEnemyKilled();
            },
            onCleared: () => {
                if (this._hooks.onCleared) this._hooks.onCleared();
            },
            onPlayerDead: () => {
                if (this._hooks.onDefeat) this._hooks.onDefeat();
            },
            onPlayerHurt: (dmg: number, hp: number) => {
                this._hurtFlash = 0.18;
                if (this._hooks.onPlayerHurt) this._hooks.onPlayerHurt(dmg, hp);
            },
        };
    }

    /** 装备进化后立刻把新参数灌进战斗世界 —— 进化当场生效 */
    syncWeapons(weapons: WeaponSpec[]): void {
        this.world.syncWeapons(weapons);
    }

    // ================================================================
    // 主循环
    // ================================================================

    /** 由 GameEntry 每帧驱动 */
    tick(dt: number): void {
        if (!this._started) return;

        // 输入每帧轮询一次（原因见 DragInput.compute 的说明：
        // 手指按住不动时没有 TOUCH_MOVE 事件，只靠回调会让角色中途停下）
        this.pollInput();

        this.world.update(dt);
        if (this._hurtFlash > 0) this._hurtFlash -= dt;
        this.draw();
    }

    private pollInput(): void {
        if (!this.dragInput) return;
        const s = this.dragInput.compute();
        if (!this.world.running) {
            this.world.stopMove();
            return;
        }
        if (s.strength > 0.01) {
            this.world.setMoveInput(s.dir, s.strength);
        } else {
            this.world.stopMove();
        }
    }

    private onDrag(s: DragState): void {
        // 触摸事件触发的即时响应（按下/抬起那一下），
        // 常规推进由 tick 里的 pollInput 负责
        if (!this.world.running) {
            this.world.stopMove();
            return;
        }
        this.world.setMoveInput(s.dir, s.strength);
    }

    // ================================================================
    // 坐标换算
    // ================================================================

    private syncTransform(): void {
        const target = this.gfx ? this.gfx.node : this.node;
        const ut = target.getComponent(UITransform);
        if (ut && ut.width > 1 && ut.height > 1) {
            this._uiW = ut.width;
            this._uiH = ut.height;
        }
        this._ox = -this._uiW / 2;
        this._oy = -this._uiH / 2;
    }

    /** 世界坐标（左下为原点） → 绘制节点本地坐标（中心为原点） */
    private w2l(p: Vec2): Vec2 {
        return v2(p.x + this._ox, p.y + this._oy);
    }

    // ================================================================
    // 绘制
    // ================================================================

    private draw(): void {
        const g = this.gfx;
        if (!g) return;

        g.clear();

        // ---- 背景 ----
        g.fillColor = C_BG;
        g.rect(this._ox, this._oy, this._uiW, this._uiH);
        g.fill();

        if (this.drawGrid) this.drawBackgroundGrid(g);

        // ---- 判定体（在角色下层，避免糊住角色）----
        this.drawProjectiles(g);

        // ---- 敌弹（远程怪的威胁，必须清晰可见）----
        this.drawEnemyShots(g);

        // ---- 敌人 ----
        this.drawEnemies(g);

        // ---- 玩家 ----
        this.drawPlayer(g);

        // ---- 摇杆指示器 ----
        this.drawJoystick(g);

        // ---- 血条 ----
        this.drawHpBar(g);
    }

    private drawBackgroundGrid(g: Graphics): void {
        g.strokeColor = C_GRID;
        g.lineWidth = 1;
        const step = 80;
        for (let x = 0; x <= this._uiW; x += step) {
            const lx = x + this._ox;
            g.moveTo(lx, this._oy);
            g.lineTo(lx, this._oy + this._uiH);
        }
        for (let y = 0; y <= this._uiH; y += step) {
            const ly = y + this._oy;
            g.moveTo(this._ox, ly);
            g.lineTo(this._ox + this._uiW, ly);
        }
        g.stroke();
    }

    private drawProjectiles(g: Graphics): void {
        for (const p of this.world.projectiles) {
            if (!p.alive) continue;
            if (p.delay > 0) {
                // 还在落地延迟中（陨石/剑雨）：画一个空心预警圈，玩家能反应
                g.strokeColor = new Color(255, 255, 255, 90);
                g.lineWidth = 2;
                g.circle(p.pos.x + this._ox, p.pos.y + this._oy, p.radius);
                g.stroke();
                continue;
            }
            const c = PROJ_COLOR[p.kind] || [200, 200, 200];
            g.fillColor = new Color(c[0], c[1], c[2], 210);
            g.circle(p.pos.x + this._ox, p.pos.y + this._oy, p.radius);
            g.fill();
        }
    }

    /** 敌弹：画成菱形，和玩家的圆形判定体天然区分开 */
    private drawEnemyShots(g: Graphics): void {
        for (const s of this.world.enemyShots) {
            if (!s.alive) continue;
            const lx = s.pos.x + this._ox;
            const ly = s.pos.y + this._oy;
            const r = s.radius;
            g.fillColor = C_ENEMY_SHOT;
            g.moveTo(lx, ly + r);
            g.lineTo(lx + r, ly);
            g.lineTo(lx, ly - r);
            g.lineTo(lx - r, ly);
            g.close();
            g.fill();
        }
    }

    private drawEnemies(g: Graphics): void {
        for (const e of this.world.enemies) {
            if (!e.alive) continue;
            const lx = e.pos.x + this._ox;
            const ly = e.pos.y + this._oy;

            if (e.hitFlash > 0) {
                g.fillColor = C_ENEMY_FLASH;
            } else {
                g.fillColor = e.kind === 'ranged' ? C_ENEMY_RANGED : C_ENEMY;
            }

            if (e.kind === 'ranged') {
                // 远程怪：菱形。形状差异比颜色差异更快被识别，
                // 玩家在混战里能立刻判断"该先切入哪一只"
                const r = e.radius * 1.15;
                g.moveTo(lx, ly + r);
                g.lineTo(lx + r, ly);
                g.lineTo(lx, ly - r);
                g.lineTo(lx - r, ly);
                g.close();
                g.fill();
            } else {
                g.circle(lx, ly, e.radius);
                g.fill();
            }

            // 血条：只在受伤后显示，画面不啰嗦
            if (e.hp < e.maxHp) {
                const w = e.radius * 2.2;
                const ratio = Math.max(0, e.hp / e.maxHp);
                g.fillColor = C_HP_BG;
                g.rect(lx - w / 2, ly + e.radius + 7, w, 5);
                g.fill();
                g.fillColor = C_HP_LOW;
                g.rect(lx - w / 2, ly + e.radius + 7, w * ratio, 5);
                g.fill();
            }
        }

        // 锁定标记：让"锁定"这个瞄准方式和另外四种一眼区分开
        const locked = this.world.lockedIds;
        if (locked.length) {
            g.strokeColor = C_LOCK;
            g.lineWidth = 3;
            for (const e of this.world.enemies) {
                if (!e.alive || locked.indexOf(e.id) < 0) continue;
                g.circle(e.pos.x + this._ox, e.pos.y + this._oy, e.radius + 12);
                g.stroke();
            }
        }
    }

    private drawPlayer(g: Graphics): void {
        const p = this.world.player;
        const lx = p.pos.x + this._ox;
        const ly = p.pos.y + this._oy;

        // 朝向指示：一段短线，这是"前向攻击"能不能命中的唯一视觉依据
        const fx = p.facing.x;
        const fy = p.facing.y;
        g.strokeColor = C_FACING;
        g.lineWidth = 4;
        g.moveTo(lx, ly);
        g.lineTo(lx + fx * (p.radius + 26), ly + fy * (p.radius + 26));
        g.stroke();

        g.fillColor = p.alive ? C_PLAYER : new Color(120, 130, 150, 255);
        g.circle(lx, ly, p.radius);
        g.fill();
    }

    /** 摇杆可视化：只有 JOYSTICK 模式且正在拖动时才画 */
    private drawJoystick(g: Graphics): void {
        const d = this.dragInput;
        if (!d || !d.state.active || d.dragMode === 'FOLLOW') return;

        const s = d.state;
        g.strokeColor = C_JOY;
        g.lineWidth = 3;
        g.circle(s.start.x, s.start.y, d.joystickRadius);
        g.stroke();

        const knobX = s.start.x + s.dir.x * d.joystickRadius * s.strength;
        const knobY = s.start.y + s.dir.y * d.joystickRadius * s.strength;
        g.fillColor = new Color(160, 190, 240, 200);
        g.circle(knobX, knobY, 26);
        g.fill();
    }

    private drawHpBar(g: Graphics): void {
        const p = this.world.player;
        const w = this._uiW * 0.68;
        const h = 16;
        const x = this._ox + (this._uiW - w) / 2;
        const y = this._oy + 22;
        const ratio = Math.max(0, p.hp / p.maxHp);

        g.fillColor = C_HP_BG;
        g.rect(x, y, w, h);
        g.fill();

        // 受伤瞬间闪一下，反馈更明确
        g.fillColor = this._hurtFlash > 0
            ? new Color(255, 255, 255, 255)
            : (ratio > 0.3 ? C_HP : C_HP_LOW);
        g.rect(x, y, w * ratio, h);
        g.fill();

        // 护盾挂在血条上方：它是"会被打掉的一层额外血量"，
        // 和生命分开画，玩家才能看出"我这一下是被盾吃掉的"
        if (p.shield > 0) {
            const sr = Math.max(0.02, Math.min(1, p.shield / Math.max(1, p.maxHp)));
            g.fillColor = C_SHIELD;
            g.rect(x, y + h + 3, w * sr, 7);
            g.fill();
        }
    }

    // ================================================================
    // HUD 文案
    // ================================================================

    /**
     * 顶部信息条。
     * 重点是让玩家随时看到"我这几件武器分别是怎么瞄准的"——
     * 这是本作最核心的差异化设计，不该藏在面板里。
     */
    getHudText(): string {
        const w = this.world;
        const lines: string[] = [];

        const ranged = w.rangedCount;
        lines.push('第 ' + this._levelId + ' 关 · ' + this._diffName +
            '　剩余 ' + w.remaining +
            '　击杀 ' + w.stats.kills +
            (ranged > 0 ? '　远程 ' + ranged : '') +
            '　' + w.time.toFixed(1) + 's');

        const hp = Math.max(0, Math.round(w.player.hp));
        lines.push('生命 ' + hp + '/' + w.player.maxHp +
            (w.player.shield > 0 ? '　护盾 ' + Math.round(w.player.shield) : '') +
            '　输出 ' + Math.round(w.stats.damageDealt) +
            (w.stats.critCount > 0 ? '　暴击 ' + w.stats.critCount : ''));

        for (const wep of w.weapons) {
            // 射程统一按全屏，所以 HUD 只报"打击尺度"（判定体大小）和伤害
            const extras: string[] = [];
            if (wep.extraShots && wep.extraShots > 0) extras.push('弹道 +' + wep.extraShots);
            if (wep.lifesteal && wep.lifesteal > 0) extras.push('吸血 ' + Math.round(wep.lifesteal * 100) + '%');
            if (wep.critRate && wep.critRate > 0) extras.push('暴击 ' + Math.round(wep.critRate * 100) + '%');

            lines.push('· ' + wep.name + '　' + wep.aimText +
                '　伤害 ' + wep.damage + '　范围 ' + wep.range +
                (extras.length > 0 ? '　' + extras.join(' ') : '') +
                (wep.aimMode === AimModeId.LOCK_ON && wep.lockedId ? '　[已锁定]' : ''));
        }

        if (!w.running) {
            lines.push(w.result === 'won' ? '— 通关 —' : '— 战败 —');
        }
        return lines.join('\n');
    }

    /** 当前出战武器，便于外部（结算页）展示 */
    get weapons(): WeaponSpec[] {
        return this.world.weapons.slice();
    }

    /** 关卡是否还在进行 */
    get playing(): boolean {
        return this.world.running;
    }

    /** 攻击方式的中文说明，调试面板用 */
    static attackModeName(id: AttackModeId): string {
        const map: Record<number, string> = {
            [AttackModeId.SINGLE_MELEE]: '近战单体',
            [AttackModeId.SINGLE_RANGED]: '远程单体',
            [AttackModeId.TRIPLE_SHOT]: '三连射',
            [AttackModeId.SWEEP]: '范围剑气',
            [AttackModeId.PIERCE]: '穿透',
            [AttackModeId.SHOCKWAVE]: '震荡波',
            [AttackModeId.RAIN]: '剑雨/箭雨',
            [AttackModeId.CHAIN]: '连锁闪电',
            [AttackModeId.METEOR]: '陨石',
            [AttackModeId.FULL_SWEEP]: '全屏横扫',
        };
        return map[id] || '未知';
    }
}
