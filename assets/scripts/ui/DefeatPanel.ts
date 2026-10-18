import {
    _decorator, Button, Color, Component, Graphics, Label, Layers, Node,
    UITransform, VerticalTextAlignment, HorizontalTextAlignment, find, director, view,
} from 'cc';
import { DefeatPayload, LevelFlow } from '../core/LevelFlow';

const { ccclass } = _decorator;

/** 战败后的明确选择，避免自动重开打断玩家并隐藏本局收益。 */
@ccclass('DefeatPanel')
export class DefeatPanel extends Component {
    static instance: DefeatPanel | null = null;
    private built = false;
    private title!: Label;
    private body!: Label;
    private hint!: Label;
    private revive!: Button;
    private retry!: Button;
    private abandon!: Button;
    private busy = false;

    static ensure(parent?: Node): DefeatPanel {
        if (this.instance && this.instance.isValid) return this.instance;
        const node = new Node('DefeatPanel');
        node.layer = Layers.Enum.UI_2D;
        node.addComponent(UITransform)!.setContentSize(view.getVisibleSize());
        const inst = node.addComponent(DefeatPanel)!;
        this.instance = inst;
        const host = parent || find('Canvas') || director.getScene();
        if (host) node.setParent(host);
        inst.build();
        return inst;
    }

    onLoad(): void {
        DefeatPanel.instance = this;
        this.build();
    }

    onDestroy(): void {
        if (DefeatPanel.instance === this) DefeatPanel.instance = null;
    }

    private build(): void {
        if (this.built) return;
        this.built = true;
        const size = view.getVisibleSize();
        const card = new Node('Card');
        card.layer = Layers.Enum.UI_2D;
        card.addComponent(UITransform)!.setContentSize(Math.min(620, size.width * .88), 560);
        const bg = card.addComponent(Graphics)!;
        bg.fillColor = new Color(25, 30, 47, 250);
        bg.roundRect(-280, -250, 560, 500, 18); bg.fill();
        card.setParent(this.node);

        this.title = this.label(card, 'Title', 500, 48, 30, new Color(255, 220, 120), 190);
        this.body = this.label(card, 'Body', 500, 230, 21, new Color(230, 235, 248), 35);
        this.hint = this.label(card, 'Hint', 500, 42, 17, new Color(165, 178, 205), -105);
        this.revive = this.button(card, '看广告复活并继续', -160, -175, new Color(72, 145, 235));
        this.retry = this.button(card, '重新挑战（保留成长）', 160, -175, new Color(73, 170, 120));
        this.abandon = this.button(card, '返回关卡选择', 0, -235, new Color(95, 105, 130));
        this.revive.node.on(Node.EventType.TOUCH_END, () => this.onRevive(), this);
        this.retry.node.on(Node.EventType.TOUCH_END, () => this.onRetry(), this);
        this.abandon.node.on(Node.EventType.TOUCH_END, () => this.onAbandon(), this);
        this.node.active = false;
    }

    private label(parent: Node, name: string, width: number, height: number, size: number, color: Color, y: number): Label {
        const n = new Node(name); n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform)!.setContentSize(width, height);
        const l = n.addComponent(Label)!; l.fontSize = size; l.lineHeight = size + 8;
        l.color = color; l.horizontalAlign = HorizontalTextAlignment.CENTER; l.verticalAlign = VerticalTextAlignment.CENTER;
        l.enableWrapText = true; n.setPosition(0, y, 0); n.setParent(parent); return l;
    }

    private button(parent: Node, text: string, x: number, y: number, color: Color): Button {
        const n = new Node(text); n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform)!.setContentSize(250, 58);
        const g = n.addComponent(Graphics)!; g.fillColor = color; g.roundRect(-125, -29, 250, 58, 12); g.fill();
        const l = this.label(n, 'Label', 235, 50, 18, new Color(255, 255, 255, 255), 0); l.string = text;
        n.setPosition(x, y, 0); n.setParent(parent);
        return n.addComponent(Button)!;
    }

    show(p: DefeatPayload): void {
        this.build(); this.busy = false; this.node.active = true;
        this.title.string = '第 ' + p.levelId + ' 关 · ' + p.difficultyName + ' 战败';
        this.body.string = '本局击杀 ' + p.kills + ' · 得分 ' + p.score + ' · 用时 ' + p.elapsed.toFixed(1) + 's\n' +
            '金币 +' + p.coin + '（局内）\n局内等级 Lv.' + p.level + ' · 经验进度 ' + Math.round(p.progress * 100) + '%\n' +
            '进化 ' + p.evolutionCount + ' 次\n当前装备：' + p.equipmentText;
        this.hint.string = '金币与成长会在通关后才转入永久档案；重新挑战会保留本局成长。';
        this.revive.interactable = true; this.retry.interactable = true; this.abandon.interactable = true;
    }

    private setBusy(value: boolean): void {
        this.busy = value; this.revive.interactable = !value; this.retry.interactable = !value; this.abandon.interactable = !value;
    }

    private async onRevive(): Promise<void> {
        if (this.busy) return; this.setBusy(true);
        const ok = await LevelFlow.inst.reviveDefeated();
        if (ok) this.node.active = false;
        else { this.hint.string = '广告未完成或暂不可用，可重新挑战或返回关卡选择。'; this.setBusy(false); }
    }

    private onRetry(): void {
        if (this.busy) return; this.setBusy(true); this.node.active = false; LevelFlow.inst.retryDefeated();
    }

    private onAbandon(): void {
        if (this.busy) return; this.setBusy(true); this.node.active = false; LevelFlow.inst.abandonDefeated();
    }
}
