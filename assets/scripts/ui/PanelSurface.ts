import { _decorator, Color, Component, Graphics, UITransform } from 'cc';

const { ccclass, property, executeInEditMode, requireComponent } = _decorator;

@ccclass('PanelSurface')
@executeInEditMode
@requireComponent(UITransform)
@requireComponent(Graphics)
export class PanelSurface extends Component {
    @property(Color) fillColor = new Color(31, 44, 68, 255);
    @property radius = 14;

    onEnable(): void {
        this.redraw();
        this.node.on('size-changed', this.redraw, this);
    }

    onDisable(): void {
        this.node.off('size-changed', this.redraw, this);
    }

    private redraw(): void {
        const graphics = this.getComponent(Graphics)!;
        const transform = this.getComponent(UITransform)!;
        graphics.clear();
        graphics.fillColor = this.fillColor;
        graphics.roundRect(-transform.width / 2, -transform.height / 2,
            transform.width, transform.height, this.radius);
        graphics.fill();
    }
}
