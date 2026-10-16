/**
 * 成就表
 *
 * 【成就的设计目标不是"收集"，是"引导"】
 *
 * 这一轮加了大量新系统：分支进化、双武器合成、辅助装备、天赋、
 * 复玩加难、每关武器适配。玩家不太可能自己把每一个都试一遍。
 *
 * 所以成就刻意覆盖了**每一个新系统**：
 *   合成 → 初次合成 / 合成 10 次 / 合成 30 次
 *   图鉴 → 收录 10 / 30 / 全部形态
 *   深度 → 推到 depth 3 / depth 4（复玩限定）
 *   复玩 → 加难 15% / 50% / 120% 通关
 *   适配 → 用推荐武器通关 5 次
 *   天赋 → 单个天赋叠到 5 层
 *
 * 于是"冲成就"这件事等于"把游戏玩明白"，而不只是刷数字。
 *
 * 【奖励为什么给永久金币】
 *   金币是局外升级武器的基础伤害的唯一消耗品。
 *   成就发金币 = 成就直接转化为战力，形成"解锁成就 → 变强 → 打更高难度
 *   → 解锁更多成就"的正循环，而不是一个孤立的展示墙。
 */

import { AchievementDef } from './GameTypes';

/**
 * collectForms 用 -1 表示"图鉴全收集"。
 * 用具体数字不行 —— 每次加新武器（比如这一轮从 5 把扩到 12 把）
 * 都会让"全收集"成就的判定失效，而 -1 永远正确。
 */
export const ACHIEVE_ALL_FORMS = -1;

/**
 * 合成出全部完整属性材料的累计次数上限 —— "24 种都合成过"。
 * 同样用 -1 而不是具体数字：加新属性时判定不会失效。
 */
export const ACHIEVE_ALL_STONES = -1;

export const ACHIEVEMENT_TABLE: AchievementDef[] = [
    // ---------------------------------------------------------- 征程
    {
        id: 'ach_first_clear', name: '初次通关', group: '征程', gold: 100,
        desc: '通关第 1 关', kind: 'clearLevel', target: 1,
    },
    {
        id: 'ach_clear_5', name: '连破五关', group: '征程', gold: 300,
        desc: '通关第 5 关', kind: 'clearLevel', target: 5,
    },
    {
        id: 'ach_clear_9', name: '破关九重', group: '征程', gold: 600,
        desc: '通关第 9 关', kind: 'clearLevel', target: 9,
    },
    {
        id: 'ach_kill_200', name: '百人斩', group: '征程', gold: 250,
        desc: '累计击杀 200 名敌人', kind: 'killTotal', target: 200,
    },
    {
        id: 'ach_kill_2000', name: '千军万马', group: '征程', gold: 1000,
        desc: '累计击杀 2000 名敌人', kind: 'killTotal', target: 2000,
    },

    // ---------------------------------------------------------- 难度
    {
        id: 'ach_hard', name: '困难挑战者', group: '难度', gold: 400,
        desc: '通关任意一关的困难难度', kind: 'clearTier', target: 2,
    },
    {
        id: 'ach_nightmare', name: '噩梦征服者', group: '难度', gold: 900,
        desc: '通关任意一关的噩梦难度', kind: 'clearTier', target: 3,
    },
    {
        id: 'ach_no_damage', name: '毫发无伤', group: '难度', gold: 500,
        desc: '未受到任何伤害通关一局', kind: 'noDamageClear', target: 1,
    },
    {
        id: 'ach_no_damage_hard', name: '铁壁', group: '难度', gold: 1200,
        desc: '在困难或更高难度下无伤通关', kind: 'noDamageClear', target: 2,
    },

    // ---------------------------------------------------------- 技艺
    {
        id: 'ach_affinity', name: '对症下药', group: '技艺', gold: 350,
        desc: '用关卡推荐的武器通关 5 次', kind: 'affinityClear', target: 5,
    },
    {
        id: 'ach_affinity_20', name: '知己知彼', group: '技艺', gold: 900,
        desc: '用关卡推荐的武器通关 20 次', kind: 'affinityClear', target: 20,
    },
    {
        id: 'ach_talent_5', name: '专精', group: '技艺', gold: 350,
        desc: '把同一个天赋叠到 5 层', kind: 'talentStacks', target: 5,
    },
    {
        id: 'ach_forms_8', name: '满编出战', group: '技艺', gold: 400,
        desc: '单局同时持有 8 件装备（武器 + 辅助）', kind: 'formCountInRun', target: 8,
    },

    // ---------------------------------------------------------- 进化
    {
        id: 'ach_first_fusion', name: '初次合成', group: '进化', gold: 300,
        desc: '首次触发两件武器的合成进化', kind: 'firstFusion', target: 1,
    },
    {
        id: 'ach_fusion_10', name: '合成工匠', group: '进化', gold: 700,
        desc: '累计触发 10 次合成进化', kind: 'fusionCount', target: 10,
    },
    {
        id: 'ach_fusion_30', name: '合成大师', group: '进化', gold: 1500,
        desc: '累计触发 30 次合成进化', kind: 'fusionCount', target: 30,
    },
    {
        id: 'ach_depth3', name: '登堂入室', group: '进化', gold: 250,
        desc: '把任意一条武器线推到第 3 层形态', kind: 'reachDepth', target: 3,
    },
    {
        id: 'ach_depth4', name: '登峰造极', group: '进化', gold: 1200,
        desc: '解锁只有复玩才能触及的第 4 层形态', kind: 'reachDepth', target: 4,
    },

    // ---------------------------------------------------------- 图鉴
    {
        id: 'ach_collect_10', name: '图鉴·初窥', group: '图鉴', gold: 200,
        desc: '进化图鉴收录 10 种形态', kind: 'collectForms', target: 10,
    },
    {
        id: 'ach_collect_30', name: '图鉴·半壁', group: '图鉴', gold: 600,
        desc: '进化图鉴收录 30 种形态', kind: 'collectForms', target: 30,
    },
    {
        id: 'ach_collect_all', name: '图鉴·全知', group: '图鉴', gold: 3000,
        desc: '进化图鉴收录全部形态', kind: 'collectForms', target: ACHIEVE_ALL_FORMS,
    },

    // ---------------------------------------------------------- 复玩
    {
        id: 'ach_boost_15', name: '主动加难', group: '复玩', gold: 300,
        desc: '在复玩加难 15% 及以上的设定下通关', kind: 'boostClear', target: 0.15,
    },
    {
        id: 'ach_boost_50', name: '自讨苦吃', group: '复玩', gold: 800,
        desc: '在复玩加难 50% 及以上的设定下通关', kind: 'boostClear', target: 0.5,
    },
    {
        id: 'ach_boost_120', name: '极限挑战', group: '复玩', gold: 2000,
        desc: '在复玩加难 120% 及以上的设定下通关', kind: 'boostClear', target: 1.2,
    },

    // ---------------------------------------------------------- 锻造
    // 这一组覆盖突破 / 镶嵌 / 碎片合成 / 防具四件事，
    // 目的是让玩家不会漏掉"材料除了升级还能这么用"。
    {
        id: 'ach_rank_2', name: '初窥门径', group: '锻造', gold: 250,
        desc: '把任意一把武器突破到 2 阶', kind: 'breakRank', target: 2,
    },
    {
        id: 'ach_rank_4', name: '炉火纯青', group: '锻造', gold: 900,
        desc: '把任意一把武器突破到 4 阶', kind: 'breakRank', target: 4,
    },
    {
        id: 'ach_rank_5', name: '登峰造极·锻造', group: '锻造', gold: 1800,
        desc: '把任意一把武器突破到 5 阶', kind: 'breakRank', target: 5,
    },
    {
        id: 'ach_socket_1', name: '点缀锋芒', group: '锻造', gold: 200,
        desc: '在一把武器上镶嵌 1 个属性材料', kind: 'socketCount', target: 1,
    },
    {
        id: 'ach_socket_2', name: '双属性', group: '锻造', gold: 600,
        desc: '在同一把武器上叠加 2 个不同属性', kind: 'socketCount', target: 2,
    },
    {
        id: 'ach_socket_4', name: '万象归一', group: '锻造', gold: 2000,
        desc: '在同一把武器上叠加 4 个不同属性', kind: 'socketCount', target: 4,
    },
    {
        id: 'ach_stone_1', name: '点石成金', group: '锻造', gold: 250,
        desc: '用 10 个碎片合成出 1 个完整属性材料', kind: 'craftStone', target: 1,
    },
    {
        id: 'ach_stone_all', name: '六相俱全', group: '锻造', gold: 1500,
        desc: '全部 24 种属性的完整材料都合成出来过', kind: 'elementMasters', target: ACHIEVE_ALL_STONES,
    },
    {
        id: 'ach_armor_1', name: '披甲', group: '锻造', gold: 300,
        desc: '获得第 1 件防具（许愿抽卡或在关卡掉落中取得）', kind: 'armorOwned', target: 1,
    },
    {
        id: 'ach_armor_all', name: '百炼之身', group: '锻造', gold: 1200,
        desc: '集齐全部 92 件防具（23 套 × 4 部位）', kind: 'armorOwned', target: -1,
    },
    {
        id: 'ach_omni_armor', name: '万象镜甲', group: '锻造', gold: 3000,
        desc: '集齐任意一整套（头/身/裤/鞋）防具套装', kind: 'omniArmor', target: 1,
    },

    // ---------------------------------------------------------- 属性
    {
        id: 'ach_element_1', name: '初识属性', group: '属性', gold: 250,
        desc: '用属性克制打出一次伤害', kind: 'elementCounter', target: 1,
    },
    {
        id: 'ach_element_500', name: '见招拆招', group: '属性', gold: 900,
        desc: '用属性克制累计打出 500 点伤害', kind: 'elementCounter', target: 500,
    },
    {
        id: 'ach_resist_300', name: '固若金汤', group: '属性', gold: 800,
        desc: '被属性抗性累计减免 300 点伤害', kind: 'elementResist', target: 300,
    },
];

/** 成就面板的分组顺序 */
export const ACHIEVEMENT_GROUPS: string[] =
    ['征程', '难度', '技艺', '进化', '图鉴', '复玩', '锻造', '属性'];

export function getAchievementDef(id: string): AchievementDef | null {
    for (const a of ACHIEVEMENT_TABLE) {
        if (a.id === id) return a;
    }
    return null;
}

/** 全部成就的累计金币奖励上限，用于进度展示 */
export function totalAchievementGold(): number {
    let sum = 0;
    for (const a of ACHIEVEMENT_TABLE) sum += a.gold;
    return sum;
}

/** 按分组取成就 */
export function achievementsOfGroup(group: string): AchievementDef[] {
    return ACHIEVEMENT_TABLE.filter((a) => a.group === group);
}
