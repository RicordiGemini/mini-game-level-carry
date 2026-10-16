/**
 * 拖动走位输入
 *
 * 玩家需求里的"拖动走位"有两种常见做法，这里都实现了，用 dragMode 切换：
 *
 *   JOYSTICK（默认）—— 相对拖动 / 虚拟摇杆
 *     手指按下记一个起点，拖动方向相对起点算。
 *     好处：手指可以放在屏幕任何地方，不遮挡角色；
 *           力度可调（拖得远跑得快），走位精度高。
 *     这是绝大多数移动端动作游戏的做法。
 *
 *   FOLLOW —— 直接跟随
 *     角色朝手指位置跑，手指离角色越远跑得越快，进入到位半径就停下。
 *     好处：直觉最强，新手一秒上手。
 *     代价：手指会挡住角色，精细走位稍差。
 *
 * 两种模式最终都归一到同一个输出：方向 + 强度。
 * 战斗层（BattleWorld.setMoveInput）因此不需要知道用的是哪种输入方式。
 */

import { _decorator, Component, EventTouch, Node, UITransform, Vec3 } from 'cc';
import { Vec2, v2, vlen, vnorm, vsub } from '../battle/BattleTypes';

const { ccclass, property } = _decorator;

/** 拖动状态的完整快照，表现层用它画摇杆圈 */
export interface DragState {
    active: boolean;
    /** 起点（输入区本地坐标） */
    start: Vec2;
    /** 当前触点（输入区本地坐标） */
    cur: Vec2;
    /** 归一化方向，静止时为零向量 */
    dir: Vec2;
    /** 强度 0~1 */
    strength: number;
}

/** FOLLOW 模式下用来取"角色当前在输入区里的位置" */
export type AnchorProvider = () => Vec2 | null;

@ccclass('DragInput')
export class DragInput extends Component {
    /** 全屏触摸区。不填则用所在节点 */
    @property(Node) inputArea: Node = null!;

    /** 'JOYSTICK' = 相对拖动摇杆（推荐）；'FOLLOW' = 角色跟随手指 */
    @property({ tooltip: 'JOYSTICK = 相对拖动摇杆（推荐）；FOLLOW = 角色跟随手指' })
    dragMode = 'JOYSTICK';

    /** 摇杆拉满对应的拖动距离（像素） */
    @property({ tooltip: '摇杆拉满对应的拖动距离' })
    joystickRadius = 130;

    /** 死区：小于这个距离视为没动，避免手指微抖导致角色乱飘 */
    @property({ tooltip: '死区半径，小于它视为没动' })
    deadZone = 14;

    /** FOLLOW 模式的到位半径：手指离角色这么近就停下 */
    @property({ tooltip: 'FOLLOW 模式的到位半径' })
    returnRadius = 100;

    /** 拖动状态，表现层读取用于绘制摇杆 */
    readonly state: DragState = {
        active: false,
        start: v2(0, 0),
        cur: v2(0, 0),
        dir: v2(0, 0),
        strength: 0,
    };

    private _cb: ((s: DragState) => void) | null = null;
    private _anchor: AnchorProvider | null = null;
    private _inputUT: UITransform | null = null;

    /** 设置拖动回调。每帧可能调用多次，实现要够轻 */
    setCallback(cb: (s: DragState) => void): void {
        this._cb = cb;
    }

    /** FOLLOW 模式必须设置，否则退化为不移动 */
    setAnchorProvider(p: AnchorProvider): void {
        this._anchor = p;
    }

    // ------------------------------------------------------------ 事件绑定

    onEnable(): void {
        const target = this.inputArea ?? this.node;
        this._inputUT = target.getComponent(UITransform);

        target.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        target.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        target.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        target.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    onDisable(): void {
        const target = this.inputArea ?? this.node;
        target.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        target.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        target.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        target.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        this.reset();
    }

    /** 强制回到静止状态（战斗结束、弹窗打开时调用） */
    reset(): void {
        this.state.active = false;
        this.state.dir = v2(0, 0);
        this.state.strength = 0;
        this.fire();
    }

    // ------------------------------------------------------------ 触摸处理

    private onTouchStart(e: EventTouch): void {
        const p = this.toLocal(e);
        this.state.active = true;
        this.state.start = p;
        this.state.cur = v2(p.x, p.y);
        this.fire();
    }

    private onTouchMove(e: EventTouch): void {
        if (!this.state.active) return;
        this.state.cur = this.toLocal(e);
        this.fire();
    }

    private onTouchEnd(): void {
        this.state.active = false;
        this.state.dir = v2(0, 0);
        this.state.strength = 0;
        this.fire();
    }

    /**
     * 屏幕坐标 → 输入区本地坐标。
     *
     * 用 convertToNodeSpaceAR 而不是直接减半宽，是为了让输入区节点
     * 无论被摆在什么位置、缩放到多大，拖动方向都是对的。
     */
    private toLocal(e: EventTouch): Vec2 {
        const p = e.getUILocation();
        if (!this._inputUT) return v2(p.x, p.y);
        const v: Vec3 = this._inputUT.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
        return v2(v.x, v.y);
    }

    // ------------------------------------------------------------ 输出

    /**
     * 每帧重新计算一次输出，返回最新的拖动状态。
     *
     * 【为什么表现层必须逐帧调用它，而不是只依赖触摸回调】
     * 手指按住屏幕**不动**时，系统不会再派发 TOUCH_MOVE 事件。
     * 如果角色位置只由回调驱动，摇杆会在这时"失去输入"、角色半路停下。
     * 轮询可以彻底消除这个问题；FOLLOW 模式更是必须轮询 ——
     * 角色一边跑一边靠近手指，方向得实时重算才不会画圈。
     */
    compute(): DragState {
        if (!this.state.active) {
            this.state.dir = v2(0, 0);
            this.state.strength = 0;
            return this.state;
        }
        if (this.dragMode === 'FOLLOW') {
            this.computeFollow();
        } else {
            this.computeJoystick();
        }
        return this.state;
    }

    /** 计算出结果并通知回调（触摸事件里用） */
    private fire(): void {
        this.compute();
        if (this._cb) this._cb(this.state);
    }

    /** 相对拖动：方向取「当前点 - 起点」 */
    private computeJoystick(): void {
        const d = vsub(this.state.cur, this.state.start);
        const l = vlen(d);
        if (l < this.deadZone) {
            this.state.dir = v2(0, 0);
            this.state.strength = 0;
            return;
        }
        this.state.dir = vnorm(d);
        this.state.strength = Math.min(1, l / Math.max(1, this.joystickRadius));
    }

    /**
     * 跟随式：方向取「触点 - 角色当前位置」。
     * 角色位置的来源由外部注入（BattleLayer 知道怎么把世界坐标换成输入区坐标）。
     */
    private computeFollow(): void {
        const anchor = this._anchor ? this._anchor() : null;
        if (!anchor) {
            this.state.dir = v2(0, 0);
            this.state.strength = 0;
            return;
        }
        const d = vsub(this.state.cur, anchor);
        const l = vlen(d);
        if (l < this.returnRadius) {
            // 已经到手指位置了，停下，避免角色绕着手指抖
            this.state.dir = v2(0, 0);
            this.state.strength = 0;
            return;
        }
        this.state.dir = vnorm(d);
        // 离得越远跑越快，但保底 0.4 的强度，否则贴边时会慢得像爬
        const t = Math.min(1, l / (this.returnRadius * 2.2));
        this.state.strength = Math.max(0.4, t);
    }
}
