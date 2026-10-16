/**
 * 品阶配置表（第八轮）
 *
 * 【这一轮补上了游戏的"装备等级"】
 *
 *   前七轮把"武器有几把、每把多强"做完了，但所有装备在**品质维度上是平的**：
 *   一把铁剑练到满，和一把光矛练到满，差别只在"解锁晚、基础数值高一点"。
 *   玩家需求把这条轴正式立起来：
 *
 *     青铜 → 白银 → 黄金 → 钻石 → 史诗 → 神话 → 传说
 *
 *   - 抽奖**最高抽到神话**，传说只能由神话进化而来
 *   - 从钻石往上，每一阶都有**直接就是该阶**的专属装备
 *   - 钻石及以上的专属装备**自带复合属性加成**（区别于材料镶进去的属性）
 *   - 升阶消耗同阶装备，件数随阶级递增
 *
 * 【品阶与"局外等级"是两条正交的轴】
 *
 *   局外等级 level 1~5   决定**基础数值**（用金币 + 材料升级）
 *   品阶 rarity 0~6      决定**品质倍率 + 镶嵌槽位 + 自带属性**
 *
 *   两条轴都必须投入才有满强度装备，这与第四轮"没有任何单一路线能点满破防"
 *   是同一条设计原则：让玩家始终有"还差一点"的具体目标。
 *
 * 【为什么品阶要替代 forge.rank】
 *
 *   第四轮做过一套 `forge.rank`（1~5），它唯一的作用是决定镶嵌槽位数。
 *   现在品阶也要决定槽位数 —— 两套阶梯并存会让玩家面对
 *   "我要先突破还是先升阶"这种没有意义的问题。
 *   所以品阶**吸收** forge.rank 的职责，forge.rank 整套删除，
 *   存档迁移时把老 rank 映射成品阶（见 SaveManager.migrateToV6）。
 *
 * 【为什么倍率曲线是 1.0 / 1.18 / 1.40 / 1.70 / 2.10 / 2.60 / 3.30】
 *
 *   这条曲线刻意**前缓后陡**：
 *   - 前两阶几乎白给（+18% / +18%），让玩家尽早尝到升阶的甜头
 *   - 黄金→钻石开始出现明显断层（1.40 → 1.70），这是"高阶装备"的体感门槛
 *   - 神话→传说只此一条路（专属材料），所以给最大的单跳（+27%）
 *
 *   终局 3.30 倍 ≈ 一件满级局外装备的两倍半，配合自带属性与 4 个镶嵌槽，
 *   传说装备是"一个 build 的核心"，而不是"比神话好一点的装备"。
 */

/** 品阶总数 */
export const RARITY_COUNT = 7;

/** 抽奖能抽到的最高品阶（神话）。传说只能靠进化 */
export const GACHA_MAX_RARITY = 5;

/** 最低品阶 */
export const RARITY_MIN = 0;

/** 自带复合属性的最低品阶（钻石） */
export const INNATE_RARITY_MIN = 3;

export interface RarityDef {
    /** 品阶索引 0~6 */
    tier: number;
    /** 稳定标识 */
    id: string;
    /** 显示名 */
    name: string;
    /** UI 主色 RGB */
    color: [number, number, number];
    /**
     * 品质倍率。
     * 武器乘在基础伤害上，辅助装备乘在 effect 上，防具乘在抗性数值上。
     */
    powerMul: number;
    /** 镶嵌槽位数（继承自原 forge.rank 的职责） */
    sockets: number;
    /** 升到下一阶需要消耗几件同阶同类装备 */
    ascendCopies: number;
    /** 升阶的金币花费 */
    ascendGold: number;
    /** 这一阶起是否自带复合属性 */
    innate: boolean;
    /** 一句话说明，抽卡与升阶面板展示 */
    desc: string;
}

export const RARITY_TABLE: RarityDef[] = [
    {
        tier: 0, id: 'bronze', name: '青铜', color: [176, 138, 92],
        powerMul: 1.00, sockets: 1, ascendCopies: 1, ascendGold: 400,
        innate: false,
        desc: '起步品阶。所有非专属装备的原生品阶',
    },
    {
        tier: 1, id: 'silver', name: '白银', color: [188, 196, 208],
        powerMul: 1.18, sockets: 1, ascendCopies: 1, ascendGold: 900,
        innate: false,
        desc: '第一次升阶，几乎白给，让玩家立刻尝到甜头',
    },
    {
        tier: 2, id: 'gold', name: '黄金', color: [226, 182, 74],
        powerMul: 1.40, sockets: 2, ascendCopies: 2, ascendGold: 2000,
        innate: false,
        desc: '镶嵌槽翻倍，属性搭配从这里开始有意义',
    },
    {
        tier: 3, id: 'diamond', name: '钻石', color: [122, 206, 232],
        powerMul: 1.70, sockets: 2, ascendCopies: 2, ascendGold: 4500,
        innate: true,
        desc: '高阶起点，专属装备开始自带复合属性',
    },
    {
        tier: 4, id: 'epic', name: '史诗', color: [178, 122, 226],
        powerMul: 2.10, sockets: 3, ascendCopies: 2, ascendGold: 9000,
        innate: true,
        desc: '三个镶嵌槽，一件装备就能独立撑起一套属性',
    },
    {
        tier: 5, id: 'myth', name: '神话', color: [232, 128, 84],
        powerMul: 2.60, sockets: 3, ascendCopies: 1, ascendGold: 18000,
        innate: true,
        desc: '抽奖上限。再往上需要专属材料，只能打三复合关卡的噩梦难度',
    },
    {
        tier: 6, id: 'legend', name: '传说', color: [240, 206, 122],
        powerMul: 3.30, sockets: 4, ascendCopies: 0, ascendGold: 0,
        innate: true,
        desc: '终局品阶。全游戏唯一的 4 槽装备，自带最强复合属性',
    },
];

/** 把任意输入收敛成合法品阶索引 */
export function normalizeRarity(rarity: number): number {
    if (!rarity || !isFinite(rarity)) return RARITY_MIN;
    return Math.max(RARITY_MIN, Math.min(RARITY_COUNT - 1, Math.floor(rarity)));
}

/** 取品阶定义，越界收敛 */
export function getRarity(rarity: number): RarityDef {
    return RARITY_TABLE[normalizeRarity(rarity)];
}

/** 品阶名 */
export function rarityName(rarity: number): string {
    return getRarity(rarity).name;
}

/** 品阶的强度倍率 */
export function rarityPowerMul(rarity: number): number {
    return getRarity(rarity).powerMul;
}

/** 品阶决定的镶嵌槽位数 */
export function raritySockets(rarity: number): number {
    return getRarity(rarity).sockets;
}

/** 该品阶是否自带复合属性 */
export function rarityHasInnate(rarity: number): boolean {
    return normalizeRarity(rarity) >= INNATE_RARITY_MIN;
}

/** 是否已是最高品阶 */
export function isMaxRarity(rarity: number): boolean {
    return normalizeRarity(rarity) >= RARITY_COUNT - 1;
}

// ====================================================================
// 第九轮：防具套装「基础专属词条」数量阶梯
// ====================================================================

/**
 * 防具套装大套（4 件）的基础专属词条数量，按品阶递增。
 *
 * 用户确认：传说 7 / 神话 6 / 史诗 5 / 钻石 4 / 黄金 3 / 白银 2 / 青铜 1。
 * 索引 = 品阶 0~6。该数量即「4 件大套属性」的词条条数；
 * 2 件小套 = ceil(数量 / 2)。升阶后按当前品阶重新计算。
 */
export const RARITY_AFFIX_COUNT: number[] = [1, 2, 3, 4, 5, 6, 7];

/** 某品阶防具套装大套的基础词条数 */
export function rarityAffixCount(rarity: number): number {
    return RARITY_AFFIX_COUNT[normalizeRarity(rarity)];
}

/** 升到下一阶需要的同阶装备件数。已满阶返回 -1 */
export function ascendCopiesOf(rarity: number): number {
    const r = normalizeRarity(rarity);
    if (r >= RARITY_COUNT - 1) return -1;
    return RARITY_TABLE[r].ascendCopies;
}

/** 升阶的金币花费。已满阶返回 -1 */
export function ascendGoldOf(rarity: number): number {
    const r = normalizeRarity(rarity);
    if (r >= RARITY_COUNT - 1) return -1;
    return RARITY_TABLE[r].ascendGold;
}

/**
 * 升阶是否需要专属材料（只有神话 → 传说需要）。
 * 这是"传说只能靠打三复合噩梦关卡获得"的开关。
 */
export function ascendNeedsCore(rarity: number): boolean {
    return normalizeRarity(rarity) === 5;
}

// ====================================================================
// 品阶给玩家的直观对比文案
// ====================================================================

/** "钻石（强度 ×1.70 · 2 镶嵌槽 · 自带复合属性）" */
export function describeRarity(rarity: number): string {
    const d = getRarity(rarity);
    const parts: string[] = [
        '强度 ×' + d.powerMul.toFixed(2),
        d.sockets + ' 镶嵌槽',
    ];
    if (d.innate) parts.push('自带复合属性');
    return d.name + '（' + parts.join(' · ') + '）';
}

/** 升阶预览："需要同阶装备 ×2 + 金币 4500，强度 ×1.40 → ×1.70" */
export function describeAscend(rarity: number): string {
    const cur = getRarity(rarity);
    const next = getRarity(rarity + 1);
    if (rarity >= RARITY_COUNT - 1) return cur.name + ' 已是最高品阶';
    const parts: string[] = ['同阶装备 ×' + ascendCopiesOf(rarity)];
    if (ascendNeedsCore(rarity)) parts.push('专属进化材料 ×1');
    parts.push('金币 ' + ascendGoldOf(rarity));
    return parts.join(' + ') + '　强度 ×' + cur.powerMul.toFixed(2) +
        ' → ×' + next.powerMul.toFixed(2);
}

/**
 * 校验品阶表自身的一致性（配置改错时立刻报错）。
 *
 * 【2026-10-16 重构为可测试】与 `validateFormGraphData` 同样的理由：
 * 原实现硬读模块级 `RARITY_TABLE`，测试无法注入畸形数据，
 * 只能验「当前表是对的」—— 那样测不出校验逻辑本身有没有用。
 */
export function validateRarityTable(): string[] {
    return validateRarityTableData(RARITY_TABLE, RARITY_COUNT, GACHA_MAX_RARITY);
}

/**
 * 校验品阶表（纯函数版）。
 *
 * @param table    品阶表
 * @param count    期望的品阶总数
 * @param gachaMax 抽奖能抽到的最高品阶（必须小于最高品阶，否则传说没有存在意义）
 */
export function validateRarityTableData(
    table: RarityDef[], count: number, gachaMax: number
): string[] {
    const errors: string[] = [];
    if (table.length !== count) {
        errors.push('品阶表长度应为 ' + count + '，实际 ' + table.length);
    }
    for (let i = 0; i < table.length; i++) {
        const d = table[i];
        if (d.tier !== i) errors.push('品阶表索引不连续：' + i + ' → ' + d.tier);
        if (d.powerMul <= 0) errors.push('品阶倍率必须为正：' + d.id);
        if (d.sockets < 0) errors.push('镶嵌槽位不能为负：' + d.id);
        // 倍率必须严格递增，否则「升阶变强」这件事不成立
        if (i > 0 && d.powerMul <= table[i - 1].powerMul) {
            errors.push('品阶倍率必须严格递增：' + table[i - 1].id + ' → ' + d.id);
        }
        // 槽位不允许回退，否则升阶会镶不上原来的石头
        if (i > 0 && d.sockets < table[i - 1].sockets) {
            errors.push('镶嵌槽位不允许减少：' + table[i - 1].id + ' → ' + d.id);
        }
        if (d.innate && d.tier < INNATE_RARITY_MIN) {
            errors.push('低于钻石不该有自带属性：' + d.id);
        }
    }
    if (gachaMax >= count - 1) {
        errors.push('抽奖上限不能是最高品阶（传说必须留作进化目标）');
    }
    return errors;
}