/**
 * Cocos Creator 3.8 引擎 API 的最小类型存根（仅供 tsc 类型检查用）。
 *
 * 【为什么需要它】
 *   Cocos 的类型定义由编辑器生成在 `temp/declarations/` 下，
 *   但 `temp/` 是 gitignore 的生成物 —— 也就是说**克隆下来的仓库
 *   没有任何办法做类型检查**。本存根让 `npx tsc --noEmit`
 *   在纯 Node 环境下也能跑起来，是 CI 的前置条件。
 *
 * 【边界】
 *   这里只声明工程实际用到的成员，且全部是 `any` 语义 ——
 *   目的是让 tsc 聚焦检查**我们自己写的逻辑**（类型不匹配、
 *   引用不存在的字段、拼错的方法名），而不是去检查引擎契约。
 *   引擎自身的类型安全由 Cocos 编辑器负责。
 *
 * 【它不做什么】
 *   - 不参与运行时（`cc` 由引擎在运行时提供）
 *   - 不进微信小游戏包体（`.d.ts` 不参与打包）
 */

declare module 'cc' {
  export const _decorator: any;

  export class Component {
    node: any;
    enabled: boolean;
    constructor(...args: any[]);
    onLoad(...args: any[]): void;
    start(...args: any[]): void;
    update(dt: number): void;
    lateUpdate(dt: number): void;
    onDestroy(...args: any[]): void;
    scheduleOnce(fn: any, delay?: number): void;
    [key: string]: any;
  }

  export class Node {
    constructor(name?: string);
    /** 节点事件类型枚举（TOUCH_START / TOUCH_END / ...） */
    static readonly EventType: {
      TOUCH_START: string;
      TOUCH_MOVE: string;
      TOUCH_END: string;
      TOUCH_CANCEL: string;
      MOUSE_DOWN: string;
      MOUSE_MOVE: string;
      MOUSE_UP: string;
      KEY_DOWN: string;
      SIZE: string;
    };
    name: string;
    active: boolean;
    parent: Node | null;
    children: any[];
    position: any;
    layer: number;
    setParent(parent: Node): void;
    getChildByPath(path: string): Node | null;
    getChildByName(name: string): Node | null;
    getComponent<T>(cls: new (...args: any[]) => T): T | null;
    getComponentsInChildren<T>(cls: new (...args: any[]) => T): T[];
    addComponent(cls: new (...args: any[]) => any, ...args: any[]): any;
    instantiate(prefab: Prefab): Node;
    on(type: string, fn: any, target?: any, ...rest: any[]): void;
    off(type: string, fn?: any, target?: any, ...rest: any[]): void;
    emit(type: string, ...args: any[]): void;
    destroy(): void;
    [key: string]: any;
  }

  export class Prefab {
    name: string;
    data: any;
    [key: string]: any;
  }

  export class UITransform {
    width: number;
    height: number;
    anchorPoint: any;
    setContentSize(size: any): void;
    setPosition(x: number, y: number, z?: number): void;
    [key: string]: any;
  }

  export class Label {
    static readonly Overflow: { NONE: number; CLAMP: number; SHRINK: number; RESIZE_HEIGHT: number };
    static readonly HorizontalAlign: { LEFT: number; CENTER: number; RIGHT: number };
    static readonly VerticalAlign: { TOP: number; CENTER: number; BOTTOM: number };
    string: string;
    fontSize: number;
    lineHeight: number;
    color: any;
    horizontalAlign: number;
    verticalAlign: number;
    overflow: number;
    enableWrapText: boolean;
    [key: string]: any;
  }

  export class Widget {
    static readonly AlignMode: { ALWAYS: number; ON_WINDOW_RESIZE: number; ON_WINDOW_RESIZE_HEIGHT: number; ON_WINDOW_RESIZE_WIDTH: number };
    isAlignTop: boolean;
    isAlignBottom: boolean;
    isAlignLeft: boolean;
    isAlignRight: boolean;
    top: number; bottom: number; left: number; right: number;
    alignMode: number;
    updateAlignment(): void;
    [key: string]: any;
  }

  export enum HorizontalTextAlignment {
    LEFT = 0, CENTER = 1, RIGHT = 2, JUSTIFIED = 3,
  }

  export enum VerticalTextAlignment {
    TOP = 0, CENTER = 1, BOTTOM = 2, BASELINE = 3,
  }

  export class Button {
    interactable: boolean;
    transition: number;
    [key: string]: any;
  }

  export class Sprite {
    spriteFrame: any;
    color: any;
    sizeMode: number;
    [key: string]: any;
  }

  export class Graphics {
    fillColor: any;
    strokeColor: any;
    lineWidth: number;
    clear(): void;
    circle(x: number, y: number, r: number): void;
    rect(x: number, y: number, w: number, h: number): void;
    roundRect(x: number, y: number, w: number, h: number, r: number): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
    fill(): void;
    [key: string]: any;
  }

  export class Color {
    constructor(r?: number, g?: number, b?: number, a?: number);
    r: number; g: number; b: number; a: number;
    [key: string]: any;
  }

  export class Vec3 {
    static ZERO: Vec3;
    static ONE: Vec3;
    constructor(x?: number, y?: number, z?: number);
    x: number; y: number; z: number;
    set(x: number, y: number, z?: number): Vec3;
    add(v: Vec3): Vec3;
    sub(v: Vec3): Vec3;
    length(): number;
    normalize(): Vec3;
    [key: string]: any;
  }

  export class EventTouch {
    getUILocation(): Vec3;
    getLocation(): Vec3;
    touch: any;
    propagationStopped: boolean;
    [key: string]: any;
  }

  export class EventKeyboard {
    keyCode: number;
    [key: string]: any;
  }

  export const director: any;
  export const sys: any;
  export const game: any;
  export const input: any;
  export const screen: any;
  export const view: any;
  export const macro: any;
  export const math: any;
  export const easing: any;
  export const tween: any;
  export const instantiate: any;

  export function find(path: string): Node | null;
  export function warn(...args: any[]): void;
  export function error(...args: any[]): void;
  export function log(...args: any[]): void;
}