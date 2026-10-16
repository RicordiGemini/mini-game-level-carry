/**
 * 防具配置（第九轮重写）—— 四部位套装模型
 *
 * 【本轮解决的核心不对称】
 *
 *   第八轮给武器立起了「品阶」轴（青铜→传说、升阶、镶嵌、自带属性），
 *   但防具仍是单件 + 6 维抗性，没有局外等级轴，与武器不对称。
 *   本轮把防具也做成「四部位套装 + 品阶 + 升阶 + 开槽 + 专属词条/套装属性」，
 *   与武器完全对齐。
 *
 * 【双轨并存：抗性 + 词条】
 *
 *   用户确认：每件防具**保留属性抗性**（管减伤），
 *   同时新增「专属词条」（增益）与「套装属性」。
 *   所以一件防具同时贡献：抗性（减伤）+ 单件专属 + 套装属性 + 镶嵌属性石。
 *
 *   抗性共 24 轴（见 ElementConfig.ELEMENT_IDS）。常规 92 件**每件只铺 1 轴**
 *   （由套装主题的 elements 按部位轮转决定）；只有隐藏的「万象套」每件铺满 24 轴，见 §万象套。
 *
 * 【四部位】
 *
 *   头 / 身体 / 裤子 / 鞋子，全部进防具池，可同时穿戴。
 *   一套 = 4 件（每个部位 1 件）。
 *
 * 【套装数量（用户确认）】
 *
 *   青铜 5 套、白银/黄金/钻石/史诗/神话/传说 各 3 套 = 23 套 / 92 件。
 *   每套有：
 *     - 2 件套装属性（小套）：约半数基础词条
 *     - 4 件套装属性（大套）：完整基础词条（数量 = 品阶阶梯值）
 *     - 单件专属属性：每件自带 1 条 innate 增益
 *
 * 【词条阶梯（用户确认）】
 *
 *   传说 7 / 神话 6 / 史诗 5 / 钻石 4 / 黄金 3 / 白银 2 / 青铜 1。
 *
 * 【与武器对称】
 *
 *   复用 RarityConfig 的 7 阶、品阶倍率、镶嵌槽位。防具数值（抗性/词条/套装）
 *   全部乘 owned.rarity 的品阶倍率 —— 升阶自动变强，与武器一致。
 *
 * 【为什么用生成器而非手写 92 条】
 *
 *   23 套 × 4 件 = 92 条装备，手写既冗长又易错。
 *   这里用「主题（role + elements）+ 品阶」生成：每件防具的抗性/专属/套装属性
 *   都由 role 模板与品阶阶梯推导，内容量由本文件集中控制，测试可断言结构。
 */

import { ElementId, ELEMENT_IDS, ResistMap, emptyResist } from './ElementConfig';
import { AuxEffect, OwnedArmor } from './GameTypes';
import { normalizeRarity, rarityAffixCount, rarityPowerMul, raritySockets } from './RarityConfig';

// ====================================================================
// 部位
// ====================================================================

export type ArmorPart = 'head' | 'body' | 'pants' | 'shoes';

/** 四部位固定顺序，UI 与存档都按这个顺序 */
export const ARMOR_PARTS: ArmorPart[] = ['head', 'body', 'pants', 'shoes'];

export const ARMOR_PART_TEXT: Record<ArmorPart, string> = {
    head: '头部',
    body: '身体',
    pants: '裤子',
    shoes: '鞋子',
};

// ====================================================================
// 词条模板（按 role 分组）
// ====================================================================

type Line = Partial<AuxEffect>;

/**
 * 每个 role 的「基础词条」模板：一条 Line = 一个增益项（基准幅度）。
 * 战斗时整条 AuxEffect 再乘品阶倍率。
 */
const AFFIX_LINES: Record<string, Line[]> = {
    attack: [
        { atkPct: 0.04 },
        { critRate: 0.03 },
        { critMul: 0.15 },
        { extraShots: 0.15 },
    ],
    defense: [
        { maxHpFlat: 60 },
        { shield: 25 },
        { thorns: 15 },
    ],
    speed: [
        { atkSpeedPct: 0.05 },
        { moveSpeedPct: 0.05 },
        { rangePct: 0.05 },
        { extraShots: 0.15 },
    ],
    lifesteal: [
        { lifesteal: 0.03 },
        { maxHpFlat: 60 },
        { atkPct: 0.04 },
    ],
    element: [
        { pierceResist: 0.08 },
        { highHpDmg: 0.08 },
        { atkPct: 0.04 },
    ],
};

/** 把若干 Line 合并成一个 AuxEffect（critMul 取最大，其余相加） */
function mergeLines(lines: Line[]): AuxEffect {
    const out: AuxEffect = {};
    for (const ln of lines) {
        for (const k of Object.keys(ln) as (keyof AuxEffect)[]) {
            const v = ln[k];
            if (v === undefined || v === null) continue;
            if (k === 'critMul') {
                out.critMul = Math.max(out.critMul || 0, v as number);
            } else {
                (out as Record<string, number>)[k] = ((out as Record<string, number>)[k] || 0) + (v as number);
            }
        }
    }
    return out;
}

/**
 * 取 role 的前 count 条词条（不足则循环复用模板）。
 * 用于「4 件大套 = 阶梯数条」「2 件小套 = ceil(阶梯/2) 条」。
 */
export function roleBonus(role: string, count: number): AuxEffect {
    const pool = AFFIX_LINES[role] || AFFIX_LINES['attack'];
    const lines: Line[] = [];
    for (let i = 0; i < count; i++) lines.push(pool[i % pool.length]);
    return mergeLines(lines);
}

/** 单件专属属性：取 role 的第 1 条词条（作为该件防具自带的一条增益） */
export function roleInnate(role: string): AuxEffect {
    const pool = AFFIX_LINES[role] || AFFIX_LINES['attack'];
    return mergeLines([pool[0]]);
}

// ====================================================================
// 数据结构
// ====================================================================

export interface ArmorPieceDef {
    /** 部件 id，如 armor_lieyan_head */
    id: string;
    /** 所属套装 id，如 armor_lieyan */
    setId: string;
    /** 套装显示名，如 烈焰套 */
    setName: string;
    /** 部件显示名，如 烈焰盔 */
    name: string;
    part: ArmorPart;
    /** 该套装的「掉落品阶」—— 决定它出现在防具池的哪个品阶桶 */
    rarity: number;
    /** 该部件的属性抗性（24 轴基准幅度，战斗时乘品阶倍率） */
    resist: ResistMap;
    /** 单件专属属性（自带的一条增益，基准幅度） */
    innate: AuxEffect;
    color: [number, number, number];
    desc: string;
}

export interface ArmorSetDef {
    /** 套装 id，如 armor_lieyan */
    id: string;
    /** 显示名，如 烈焰套 */
    name: string;
    /** 掉落品阶 0~6 */
    rarity: number;
    /** 套装定位（决定词条模板） */
    role: string;
    /** 4 个部位部件 */
    pieces: ArmorPieceDef[];
    desc: string;
}

// ====================================================================
// 套装生成
// ====================================================================

const PART_SUFFIX: Record<ArmorPart, string> = {
    head: '盔',
    body: '甲',
    pants: '护腿',
    shoes: '战靴',
};

/** 4 个部位分摊一套总抗性的权重（身体最高，头部次之） */
const PART_WEIGHTS: Record<ArmorPart, number> = {
    head: 0.30,
    body: 0.34,
    pants: 0.20,
    shoes: 0.16,
};

interface SetTheme {
    id: string;
    name: string;
    rarity: number;
    role: string;
    elements: ElementId[];
    /** 一套 4 件的总抗性基准幅度（分摊到 4 部位后乘品阶倍率） */
    total: number;
    color: [number, number, number];
    desc: string;
}

/** 由主题生成一个完整套装（4 部件 + 套装定位） */
function buildSet(t: SetTheme): ArmorSetDef {
    const shortName = t.name.replace('套', '');
    const pieces: ArmorPieceDef[] = ARMOR_PARTS.map((part) => {
        const elem = t.elements[ARMOR_PARTS.indexOf(part) % t.elements.length];
        const r = emptyResist();
        r[elem] = t.total * PART_WEIGHTS[part];
        return {
            id: t.id + '_' + part,
            setId: t.id,
            setName: t.name,
            name: shortName + PART_SUFFIX[part],
            part,
            rarity: t.rarity,
            resist: r,
            innate: roleInnate(t.role),
            color: t.color,
            desc: t.desc,
        };
    });
    return {
        id: t.id,
        name: t.name,
        rarity: t.rarity,
        role: t.role,
        pieces,
        desc: t.desc,
    };
}

// ====================================================================
// 主题表（青铜 5 / 其余每阶 3 = 23 套）
// ====================================================================

const SET_THEMES: SetTheme[] = [
    // ---------------- 青铜（5 套，从零起步、自由度高） ----------------
    { id: 'armor_lieyan', name: '烈焰套', rarity: 0, role: 'attack', elements: ['fire'], total: 0.42, color: [232, 96, 60], desc: '入门攻击套，火属性抗性打底。' },
    { id: 'armor_hanshuang', name: '寒霜套', rarity: 0, role: 'speed', elements: ['ice'], total: 0.42, color: [120, 196, 228], desc: '入门机动套，冰属性抗性打底。' },
    { id: 'armor_judu', name: '剧毒套', rarity: 0, role: 'lifesteal', elements: ['poison'], total: 0.42, color: [150, 200, 90], desc: '入门吸血套，毒属性抗性打底。' },
    { id: 'armor_yanshi', name: '岩石套', rarity: 0, role: 'defense', elements: ['stone'], total: 0.44, color: [170, 156, 132], desc: '入门防御套，石属性抗性打底。' },
    { id: 'armor_jifeng', name: '疾风套', rarity: 0, role: 'speed', elements: ['wind'], total: 0.42, color: [150, 220, 180], desc: '入门机动套，风属性抗性打底。' },

    // ---------------- 白银（3 套） ----------------
    { id: 'armor_shengguang', name: '圣光套', rarity: 1, role: 'defense', elements: ['light'], total: 0.46, color: [236, 224, 150], desc: '圣光庇护，光属性抗性打底。' },
    { id: 'armor_anying', name: '暗影套', rarity: 1, role: 'attack', elements: ['ghost'], total: 0.46, color: [132, 108, 170], desc: '暗影突袭，幽属性抗性打底。' },
    { id: 'armor_leiting', name: '雷霆套', rarity: 1, role: 'speed', elements: ['electric'], total: 0.46, color: [240, 212, 90], desc: '雷霆疾走，电属性抗性打底。' },

    // ---------------- 黄金（3 套） ----------------
    { id: 'armor_ziran', name: '自然套', rarity: 2, role: 'lifesteal', elements: ['grass', 'wood'], total: 0.48, color: [120, 190, 110], desc: '草木共生，自然属性抗性打底。' },
    { id: 'armor_jixie', name: '机械套', rarity: 2, role: 'defense', elements: ['machine'], total: 0.48, color: [150, 160, 176], desc: '钢铁壁垒，机械属性抗性打底。' },
    { id: 'armor_xukong', name: '虚空套', rarity: 2, role: 'element', elements: ['space'], total: 0.48, color: [166, 138, 226], desc: '虚空折跃，空间属性抗性打底。' },

    // ---------------- 钻石（3 套，起自带复合属性） ----------------
    { id: 'armor_longyi', name: '龙裔套', rarity: 3, role: 'attack', elements: ['dragon', 'fire'], total: 0.50, color: [96, 168, 200], desc: '龙鳞护体，龙/火属性抗性打底。' },
    { id: 'armor_taitan', name: '泰坦套', rarity: 3, role: 'defense', elements: ['stone', 'earth'], total: 0.50, color: [150, 140, 176], desc: '泰坦之躯，石/地属性抗性打底。' },
    { id: 'armor_xinghui', name: '星辉套', rarity: 3, role: 'element', elements: ['space', 'time'], total: 0.50, color: [226, 214, 250], desc: '星辉指引，空间/时间属性抗性打底。' },

    // ---------------- 史诗（3 套） ----------------
    { id: 'armor_shenyuan', name: '深渊套', rarity: 4, role: 'lifesteal', elements: ['devil', 'poison'], total: 0.52, color: [204, 88, 96], desc: '深渊吞噬，恶魔/毒属性抗性打底。' },
    { id: 'armor_chiyang', name: '炽阳套', rarity: 4, role: 'attack', elements: ['light', 'cute'], total: 0.52, color: [240, 200, 120], desc: '炽阳焚敌，光/萌属性抗性打底。' },
    { id: 'armor_huanmeng', name: '幻梦套', rarity: 4, role: 'speed', elements: ['ghost', 'devil'], total: 0.52, color: [200, 140, 220], desc: '幻梦迷踪，幽/恶魔属性抗性打底。' },

    // ---------------- 神话（3 套，抽奖上限） ----------------
    { id: 'armor_shijie', name: '世界树套', rarity: 5, role: 'lifesteal', elements: ['wood', 'grass', 'water'], total: 0.54, color: [126, 190, 132], desc: '世界树生机，自然三属性抗性打底。' },
    { id: 'armor_xingguan', name: '星冠套', rarity: 5, role: 'element', elements: ['space', 'time', 'metal'], total: 0.54, color: [226, 214, 250], desc: '星冠加冕，法则三属性抗性打底。' },
    { id: 'armor_hundun', name: '混沌套', rarity: 5, role: 'attack', elements: ['dragon', 'fire', 'combat'], total: 0.54, color: [232, 128, 84], desc: '混沌初开，龙/火/斗属性抗性打底。' },

    // ---------------- 传说（3 套，仅进化可得） ----------------
    { id: 'armor_chuangshi', name: '创世套', rarity: 6, role: 'element', elements: ['light', 'dragon', 'space'], total: 0.56, color: [240, 230, 160], desc: '创世之光，三法则属性抗性打底。' },
    { id: 'armor_yongheng', name: '永恒套', rarity: 6, role: 'defense', elements: ['stone', 'earth', 'machine'], total: 0.56, color: [210, 200, 180], desc: '永恒壁垒，坚壁三属性抗性打底。' },
    { id: 'armor_zhongyan', name: '终焉套', rarity: 6, role: 'attack', elements: ['devil', 'ghost', 'time'], total: 0.56, color: [244, 120, 90], desc: '终焉审判，湮灭三属性抗性打底。' },
];

// ====================================================================
// 万象套（第十一轮 / A-6 关闭）—— 隐藏四件套，只能靠「万象线」养成获得
// ====================================================================

/**
 * 万象套 —— 第四轮「万象镜甲」的正统继承者。
 *
 * 【身份】全属性（24 轴）抗性 + 最高阶。定位是"永远不用换装"的终局防具。
 *
 * 【与其余 23 套的三点不同】
 *   1. **不进抽卡池**：它不在 `ARMOR_SETS` 里，`allArmorPieces()` 仍是 92 件。
 *      获取途径只有「万象线」这一条（碎片 → 全属性石 → 逐级升级 → 四件套），见
 *      `core/ForgeManager.ts` 的 `advanceOmni()`。
 *   2. **每件铺满 24 轴**（常规 92 件每件只铺 1 轴）。
 *   3. **全套固定传说（rarity 6）**，不需要也不可能再升阶。
 *
 * 【数值：仍然"越广越薄"】（同口径实测，`currentResist()` 软压缩之后）
 *   万象套   每轴 0.396 × 24 轴 → 总抗性 9.504（每轴最低、总量最高）
 *   终焉套   0.850 / 0.628 / 0.370 × 3 轴 → 总抗性 1.848（传说三轴套）
 *   龙裔套   0.425 × 2 轴 → 0.850（钻石双轴套）
 *   烈焰套   0.420 × 1 轴 → 0.420（青铜单轴套）
 *   所以万象套是"覆盖最广、每轴最薄"，总抗性却远超任何常规套 —— 这是它作为
 *   终局装备该有的强度，且每轴 0.396 仍远低于 `ElementConfig.RESIST_MAX = 0.75`（不给免疫）。
 */
export const OMNI_SET_ID = 'armor_wanxiang';
export const OMNI_SET_NAME = '万象套';
/** 万象套四件的固定品阶：6 = 传说（最高阶） */
export const OMNI_RARITY = 6;
/** 万象套「每件、每轴」的抗性基准（24 轴全覆盖） */
export const OMNI_RESIST_PER_AXIS = 0.03;
/** 万象套的定位（决定单件专属与套装属性的词条模板） */
export const OMNI_ROLE = 'element';
/**
 * 万象线的最高阶段：4 = 万象套四件已到手。
 *
 * 放在数据层（而不是 core/ForgeManager）是为了让 SaveManager 迁移能直接 clamp 进度，
 * 避免 core → core 的循环依赖。
 */
export const OMNI_MAX_STAGE = 4;

const OMNI_PART_SUFFIX: Record<ArmorPart, string> = {
    head: '盔',
    body: '甲',
    pants: '护腿',
    shoes: '战靴',
};

function buildOmniSet(): ArmorSetDef {
    const pieces: ArmorPieceDef[] = ARMOR_PARTS.map((part) => {
        const r = emptyResist();
        // 每一件都铺满 24 轴（常规套装只铺 elements 里的 1 轴）
        for (const e of ELEMENT_IDS) r[e] = OMNI_RESIST_PER_AXIS;
        return {
            id: OMNI_SET_ID + '_' + part,
            setId: OMNI_SET_ID,
            setName: OMNI_SET_NAME,
            name: '万象' + OMNI_PART_SUFFIX[part],
            part,
            rarity: OMNI_RARITY,
            resist: r,
            innate: roleInnate(OMNI_ROLE),
            color: [214, 226, 244] as [number, number, number],
            desc: '万象归一，24 轴抗性与最高阶并存。',
        };
    });
    return {
        id: OMNI_SET_ID,
        name: OMNI_SET_NAME,
        rarity: OMNI_RARITY,
        role: OMNI_ROLE,
        pieces,
        desc: '【隐藏】全属性抗性的终局四件套，只能沿「万象线」升级获得。',
    };
}

/** 万象套定义（**不在 ARMOR_SETS 内**，因此不会进池） */
export const OMNI_ARMOR_SET: ArmorSetDef = buildOmniSet();

/** 万象套的 4 件部件 */
export function omniPieces(): ArmorPieceDef[] {
    return OMNI_ARMOR_SET.pieces;
}

/** 某部件 id 是否属于万象套 */
export function isOmniPiece(id: string): boolean {
    return OMNI_ARMOR_SET.pieces.some((p) => p.id === id);
}

// ====================================================================
// 导出索引
// ====================================================================

export const ARMOR_SETS: ArmorSetDef[] = SET_THEMES.map(buildSet);

const PIECE_INDEX: Record<string, ArmorPieceDef> = {};
const SET_INDEX: Record<string, ArmorSetDef> = {};
// 池内套装（28 套里的 23 套）先建索引，再补上隐藏的万象套 ——
// 万象套可被查询 / 穿戴 / 展示，但不会出现在 allArmorPieces() 与抽卡池里。
for (const s of ARMOR_SETS) {
    SET_INDEX[s.id] = s;
    for (const p of s.pieces) PIECE_INDEX[p.id] = p;
}
SET_INDEX[OMNI_ARMOR_SET.id] = OMNI_ARMOR_SET;
for (const p of OMNI_ARMOR_SET.pieces) PIECE_INDEX[p.id] = p;

/** 取防具部件定义（含隐藏的万象套） */
export function getArmorDef(id: string): ArmorPieceDef | null {
    return PIECE_INDEX[id] || null;
}

/** 取套装定义（含隐藏的万象套） */
export function getArmorSet(setId: string): ArmorSetDef | null {
    return SET_INDEX[setId] || null;
}

/** 抽卡池内的全部防具部件（**不含**隐藏的万象套，恒为 92 件） */
export function allArmorPieces(): ArmorPieceDef[] {
    const out: ArmorPieceDef[] = [];
    for (const s of ARMOR_SETS) for (const p of s.pieces) out.push(p);
    return out;
}

/** 防具池：按品阶分组的所有部件 id（供抽卡两段式随机用；万象套不入池） */
export function armorPieceIdsByRarity(): Record<number, string[]> {
    const map: Record<number, string[]> = {};
    for (const s of ARMOR_SETS) {
        for (const p of s.pieces) {
            (map[s.rarity] = map[s.rarity] || []).push(p.id);
        }
    }
    return map;
}

/**
 * 造一件可入库的防具实例（uid + 品阶基础孔）。
 *
 * 抽卡（`GachaManager.grantArmorToProfile`）与万象线（`ForgeManager.advanceOmni`）
 * 共用这一份构造逻辑，避免两处各写一遍导致孔位规则漂移。
 */
export function makeOwnedArmor(id: string, rarity?: number): OwnedArmor | null {
    const def = getArmorDef(id);
    if (!def) return null;
    const r = normalizeRarity(rarity === undefined ? def.rarity : rarity);
    const slots: (ElementId | null)[] = [];
    for (let i = 0; i < raritySockets(r); i++) slots.push(null);
    return { uid: newArmorUid(), id, rarity: r, sockets: slots, openedSlots: 0 };
}

/** 某套装在某品阶下的套装属性（动态：按品阶阶梯数推导词条） */
export function setBonusOf(set: ArmorSetDef, rarity: number, pieceCount: number): AuxEffect {
    if (pieceCount < 2) return {};
    const r = normalizeRarity(rarity);
    const total = rarityAffixCount(r);
    const count = pieceCount >= 4 ? total : Math.ceil(total / 2);
    return roleBonus(set.role, count);
}

/** 一件防具的抗性文案：只列非零轴 */
export function armorResistText(resist: ResistMap): string {
    const parts: string[] = [];
    for (const e of ELEMENT_IDS) {
        const v = resist[e] || 0;
        if (v > 0) parts.push(e + ' ' + Math.round(v * 100) + '%');
    }
    return parts.join(' · ');
}

/** 防具抗性总量（比较"哪套更扛"） */
export function totalResist(resist: ResistMap): number {
    let s = 0;
    for (const e of ELEMENT_IDS) s += resist[e] || 0;
    return s;
}

/** 旧的兼容别名：单件防具的强度摘要仍可由 ResistMap 计算 */
export function resistOfPiece(p: ArmorPieceDef): ResistMap {
    return p.resist;
}

// ====================================================================
// 实例 uid 生成
// ====================================================================

/**
 * 生成一件防具持有实例的唯一 id。
 *
 * 第九轮起防具是「四部位套装 + 可重复持有」模型：
 * 同一部件可以有多件（不同品阶 / 不同实例都是升阶燃料），
 * 所以持有列表里每件装备必须有一个全局唯一 uid，
 * 穿戴槽（ArmorWorn）指向的也是 uid 而非部件 id。
 *
 * 用「时间戳 + 进程内自增 + 随机数」三段拼接，
 * 进程内绝不重复，跨进程靠随机后缀避免碰撞。
 */
let _armorUidSeq = 0;
export function newArmorUid(): string {
    _armorUidSeq += 1;
    const t = Date.now().toString(36);
    const s = _armorUidSeq.toString(36);
    const r = Math.floor(Math.random() * 0xffffff).toString(36);
    return 'arm_' + t + '_' + s + '_' + r;
}
