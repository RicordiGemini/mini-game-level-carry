/**
 * 教学覆盖层 UI（新手引导 + 首通教学共用）。
 *
 * 为什么用代码画 UI：
 *   场景编辑器无法在本次开发流程里改动，且教学层应当是「零资源依赖」的。
 *   这里在 onLoad / ensure() 时用 Graphics + Label 画出 遮罩 + 卡片 + 按钮，
 *   运行时挂到 Canvas 下即可，不需要任何预制体或图片资源。
 *
 * 交互模型（尽量简单）：
 *   - 整张卡片（根节点）可点击 = 主操作（分步时「下一步」；单卡时「关闭」）。
 *   - 新手引导模式额外在右上角放一个「跳过引导」，点了直接结束并标记已看。
 *   - 点击任意处都算「已看过」：关闭后不再重复弹。
 *
 * 引擎 API 约定（Cocos Creator 3.8）：
 *   Graphics 的颜色是 **属性**（fillColor / strokeColor），不是方法（无 fillStyle / lineStyle）；
 *   填充流程固定为「设色 → 描路径（rect / roundRect）→ fill()」，描边为「设色+线宽 → stroke()」。
*/

import {
    _decorator, Color, Component, EventTouch, Graphics, HorizontalTextAlignment, Label,
    Node, UITransform, VerticalTextAlignment, view, Widget, find, director, Layers,
} from 'cc';
import { TutorialManager } from '../core/TutorialManager';
import { NEWBIE_KEY, NEWBIE_STEPS, TutorialStep, TutorialTip } from '../data/TutorialConfig';

const { ccclass } = _decorator;

/** 卡片配色（深色主题，匹配游戏整体调性） */
const CARD_BG = new Color(27, 34, 54, 245);
const CARD_BORDER = new Color(120, 150, 220, 255);
const MASK_BG = new Color(0, 0, 0, 165);
const BTN_BG = new Color(86, 132, 235, 255);
const TITLE_COLOR = new Color(245, 248, 255, 255);
const BODY_COLOR = new Color(206, 214, 232, 255);
const BTN_COLOR = new Color(255, 255, 255, 255);
const SKIP_COLOR = new Color(150, 160, 185, 255);

@ccclass('TutorialLayer')
export class TutorialLayer extends Component {
    /** 全局单例，供各面板静态调用 */
    static instance: TutorialLayer | null = null;

    private built = false;
    private mask!: Node;
    private card!: Node;
    private titleLabel!: Label;
    private bodyLabel!: Label;
    private btnLabel!: Label;
    private skipLabel!: Label;

    /** 当前模式 */
    private mode: 'steps' | 'tip' = 'tip';
    private steps: TutorialStep[] = [];
    private stepIdx = 0;
    private ctaCb: (() => void) | null = null;
    private onDone: (() => void) | null = null;

    onLoad(): void {
        TutorialLayer.instance = this;
        this.buildUI();
    }

    onDestroy(): void {
        if (TutorialLayer.instance === this) TutorialLayer.instance = null;
    }

    // ----------------------------------------------------------- 静态入口

    /**
     * 获取单例：若没有就按需创建一个挂到 Canvas 下。
     * 这样调用方（GameEntry / 面板）无需在场景里预先挂节点。
     *
     * 注意：`addComponent` 触发的 onLoad 时机取决于节点是否已在活动场景树中，
     * 因此这里显式接管单例与 buildUI，避免 onLoad 尚未触发时单例为 null。
     */
    static ensure(): TutorialLayer {
        if (TutorialLayer.instance && TutorialLayer.instance.isValid) return TutorialLayer.instance;

        const node = new Node('TutorialLayer');
        node.layer = Layers.Enum.UI_2D;
        const size = view.getVisibleSize();

        const ut = node.addComponent(UITransform)!;
        ut.setContentSize(size.width, size.height);

        const w = node.addComponent(Widget)!;
        w.isAlignTop = w.isAlignBottom = w.isAlignLeft = w.isAlignRight = true;
        w.top = w.bottom = w.left = w.right = 0;
        w.alignMode = Widget.AlignMode.ALWAYS;

        const inst = node.addComponent(TutorialLayer)!;
        TutorialLayer.instance = inst;

        const canvas = find('Canvas') || director.getScene();
        if (canvas) {
            node.setParent(canvas);
            node.setSiblingIndex(canvas.children.length - 1);
        }
        inst.buildUI();
        return inst;
    }

    /** 启动新手引导（首次进入游戏调用） */
    static startNewbie(ctaCb?: () => void, onDone?: () => void): void {
        const inst = TutorialLayer.ensure();
        inst.showSteps(NEWBIE_STEPS.slice(), { ctaLabel: '开始第 1 关', ctaCb, onDone });
    }

    /**
     * 触发一条首通教学（按 id）。
     * 已看过 → 直接返回；未看过 → 显示并标记已看。
     */
    static showTipById(id: string): void {
        const tip = TutorialManager.consumeTip(id);
        if (!tip) return;
        const inst = TutorialLayer.ensure();
        inst.showTip(tip);
    }

    // ----------------------------------------------------------- UI 构建

    private buildUI(): void {
        if (this.built) return;
        this.built = true;

        const size = view.getVisibleSize();
        const sw = size.width;
        const sh = size.height;

        // 遮罩（全屏半透明）
        this.mask = new Node('Mask');
        this.mask.layer = Layers.Enum.UI_2D;
        this.mask.addComponent(UITransform)!.setContentSize(sw, sh);
        const mg = this.mask.addComponent(Graphics)!;
        mg.fillColor = MASK_BG;
        mg.rect(-sw / 2, -sh / 2, sw, sh);
        mg.fill();
        this.mask.setParent(this.node);
        this.mask.setSiblingIndex(0);

        // 卡片
        this.card = new Node('Card');
        this.card.layer = Layers.Enum.UI_2D;
        const cardW = Math.min(sw * 0.86, 620);
        const cardH = 380;
        this.card.addComponent(UITransform)!.setContentSize(cardW, cardH);
        this.card.setPosition(0, sh * 0.04, 0);
        const cg = this.card.addComponent(Graphics)!;
        cg.fillColor = CARD_BG;
        cg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 18);
        cg.fill();
        cg.lineWidth = 2;
        cg.strokeColor = CARD_BORDER;
        cg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 18);
        cg.stroke();
        this.card.setParent(this.node);
        this.card.setSiblingIndex(1);

        // 标题
        this.titleLabel = this.makeLabel('Title', cardW - 60, 44, 26,
            TITLE_COLOR, HorizontalTextAlignment.CENTER, VerticalTextAlignment.CENTER);
        this.titleLabel.node.setPosition(0, cardH / 2 - 38, 0);
        this.titleLabel.node.setParent(this.card);

        // 正文
        this.bodyLabel = this.makeLabel('Body', cardW - 60, 200, 20,
            BODY_COLOR, HorizontalTextAlignment.CENTER, VerticalTextAlignment.CENTER);
        this.bodyLabel.enableWrapText = true;
        this.bodyLabel.overflow = Label.Overflow.CLAMP;
        this.bodyLabel.node.setPosition(0, 6, 0);
        this.bodyLabel.node.setParent(this.card);

        // 按钮（视觉，主操作由根节点点击触发）
        const btn = new Node('Btn');
        btn.layer = Layers.Enum.UI_2D;
        btn.addComponent(UITransform)!.setContentSize(240, 60);
        const bg = btn.addComponent(Graphics)!;
        bg.fillColor = BTN_BG;
        bg.roundRect(-120, -30, 240, 60, 14);
        bg.fill();
        this.btnLabel = this.makeLabel('BtnLabel', 220, 40, 24,
            BTN_COLOR, HorizontalTextAlignment.CENTER, VerticalTextAlignment.CENTER);
        this.btnLabel.node.setParent(btn);
        btn.setPosition(0, -cardH / 2 + 50, 0);
        btn.setParent(this.card);

        // 跳过（仅新手引导模式使用）
        this.skipLabel = this.makeLabel('Skip', 120, 32, 18,
            SKIP_COLOR, HorizontalTextAlignment.RIGHT, VerticalTextAlignment.CENTER);
        this.skipLabel.string = '跳过引导';
        this.skipLabel.node.setPosition(cardW / 2 - 60, cardH / 2 - 22, 0);
        this.skipLabel.node.setParent(this.card);
        // 跳过按钮必须「吃掉」事件，否则会冒泡到根节点触发 onPrimary
        this.skipLabel.node.on(Node.EventType.TOUCH_START, (e: EventTouch) => {
            e.propagationStopped = true;
        }, this);
        this.skipLabel.node.on(Node.EventType.TOUCH_END, this.onSkip, this);

        // 整卡点击 = 主操作
        this.node.on(Node.EventType.TOUCH_END, this.onPrimary, this);

        this.node.active = false;
    }

    private makeLabel(
        name: string, w: number, h: number, fontSize: number, color: Color,
        halign: HorizontalTextAlignment, valign: VerticalTextAlignment,
    ): Label {
        const n = new Node(name);
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform)!.setContentSize(w, h);
        const l = n.addComponent(Label)!;
        l.string = '';
        l.fontSize = fontSize;
        l.color = color;
        l.horizontalAlign = halign;
        l.verticalAlign = valign;
        l.lineHeight = fontSize + 6;
        return l;
    }

    // ----------------------------------------------------------- 显示控制

    private showSteps(
        steps: TutorialStep[],
        opts?: { ctaLabel?: string; ctaCb?: () => void; onDone?: () => void },
    ): void {
        this.mode = 'steps';
        this.steps = steps;
        this.stepIdx = 0;
        this.ctaCb = opts && opts.ctaCb ? opts.ctaCb : null;
        this.onDone = opts && opts.onDone ? opts.onDone : null;
        this.skipLabel.node.active = true;
        this.renderStep();
        this.node.active = true;
    }

    private showTip(tip: TutorialTip): void {
        this.mode = 'tip';
        this.skipLabel.node.active = false;
        this.titleLabel.string = tip.title;
        this.bodyLabel.string = tip.body;
        this.btnLabel.string = tip.cta || '知道了';
        this.node.active = true;
    }

    private renderStep(): void {
        const step = this.steps[this.stepIdx];
        if (!step) { this.finish(); return; }
        this.titleLabel.string = step.title;
        this.bodyLabel.string = step.body;
        const isLast = this.stepIdx >= this.steps.length - 1;
        this.btnLabel.string = isLast ? (step.cta || '完成') : '下一步';
    }

    private onPrimary(): void {
        if (this.mode === 'tip') {
            this.node.active = false;
            const cb = this.onDone;
            this.onDone = null;
            if (cb) cb();
            return;
        }
        // steps 模式
        const isLast = this.stepIdx >= this.steps.length - 1;
        if (isLast) {
            this.finish();
            return;
        }
        this.stepIdx += 1;
        this.renderStep();
    }

    private onSkip(e: EventTouch): void {
        if (e) e.propagationStopped = true;
        this.finish();
    }

    /** 结束新手引导：标记已看、隐藏、回调 */
    private finish(): void {
        TutorialManager.markSeen(NEWBIE_KEY);
        this.node.active = false;
        const cb = this.ctaCb;
        const done = this.onDone;
        this.ctaCb = null;
        this.onDone = null;
        if (cb) cb();
        if (done) done();
    }

    // ----------------------------------------------------------- 查询

    /** 当前是否有教学卡片在显示（供外部判断是否遮挡） */
    isShowing(): boolean {
        return this.node.active;
    }
}
