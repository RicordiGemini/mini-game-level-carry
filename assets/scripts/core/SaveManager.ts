/**
 * 存档管理器
 *
 * 存储介质：sys.localStorage
 *   - Cocos 预览 / 浏览器环境 = window.localStorage
 *   - 微信小游戏环境 = Cocos 自动映射到 wx.setStorageSync
 *   两套环境共用一份读写代码，无需分支处理。
 *
 * 【键位设计：关卡 × 难度 双主键】
 *
 *   mg_profile                全局玩家档案
 *   mg_level                  当前单局的运行态（用于杀进程后续玩）
 *   mg_archive_<levelId>_<tier>   某关某难度通关时的档案
 *
 * 为什么档案必须按难度分开：
 *   第 3 关的普通难度和噩梦难度是两个完全不同的挑战，
 *   把它们的最高分、最快时间、通关次数混在一个键里，
 *   玩家打完噩梦回头看，会发现普通难度的纪录被覆盖了 —— 数据直接失效。
 *   分开存之后，"刷新纪录"这个复玩核心驱动才对每个难度各自成立。
 *
 * 每条记录都包一层 { data, sig, ts }，读取时校验签名，防止被工具直接改数值。
 */

import { sys } from 'cc';
import {
    AchievementRecord, ArmorWorn, LevelArchive, LevelState, OwnedArmor, PlayerProfile,
    RunLoadoutState, SignedPayload,
} from '../data/GameTypes';
import { MAX_TIER, normalizeTier } from '../data/DifficultyConfig';
import { AUX_ROOT_IDS } from '../data/AuxConfig';
import { AUX_MAX_RANK } from '../data/GachaConfig';
import { getEquipDef } from '../data/EquipmentConfig';
import { getArmorDef, newArmorUid, OMNI_MAX_STAGE } from '../data/ArmorConfig';
import { normalizeRarity, raritySockets } from '../data/RarityConfig';
import { ELEMENT_IDS, ElementId } from '../data/ElementConfig';
import { ALL_FORMS, legacyFormId, getForm } from '../data/FormConfig';
import { REPLAY_BOOST_MAX } from '../data/GameTypes';
import { sign, verify } from './HashUtil';

const KEY_PROFILE = 'mg_profile';
const KEY_LEVEL = 'mg_level';
/** 旧版本键：mg_archive_<levelId>（没有难度维度），仅用于迁移 */
const KEY_ARCHIVE_PREFIX_LEGACY = 'mg_archive_';
/** 新版本键：mg_archive_<levelId>_<tier> */
const KEY_ARCHIVE_PREFIX = 'mg_archive_';

/** 存档结构版本，改结构时 +1 并在 migrateProfile 里补迁移 */
export const SAVE_VERSION = 8;

/**
 * 防具的「基础空槽」：品阶给的 raritySockets(rarity) 个空孔。
 *
 * 与武器对称（武器按品阶直接给槽位），所以新迁移/新发放的防具
 * 必须带够基础孔，而不是等玩家花水晶逐个去开（见 docs/防具套装系统设计.md §3.3）。
 */
function emptyArmorSockets(rarity: number): (ElementId | null)[] {
    const out: (ElementId | null)[] = [];
    for (let i = 0; i < raritySockets(rarity); i++) out.push(null);
    return out;
}

export class SaveManager {
    private static profileCache: PlayerProfile | null = null;

    // ---------------------------------------------------------------- 键位

    /** 关卡 × 难度 档案键 */
    static archiveKey(levelId: number, tier: number): string {
        return KEY_ARCHIVE_PREFIX + levelId + '_' + normalizeTier(tier);
    }

    /** 关卡 × 难度 统计键（用于 clearCounts / bestScores / bestTimes） */
    static statKey(levelId: number, tier: number): string {
        return levelId + '_' + normalizeTier(tier);
    }

    // ---------------------------------------------------------------- 底层读写

    private static writeSigned<T>(key: string, data: T): void {
        const payload: SignedPayload<T> = { data, sig: sign(data), ts: Date.now() };
        try {
            sys.localStorage.setItem(key, JSON.stringify(payload));
        } catch (e) {
            console.error('[Save] 写入失败', key, e);
        }
    }

    /**
     * 读并校验签名。
     * 校验失败 = 被外部改过，直接返回 null 并删除，绝不让可疑数据进入游戏逻辑。
     */
    private static readSigned<T>(key: string): T | null {
        try {
            const raw = sys.localStorage.getItem(key);
            if (!raw) return null;
            const payload = JSON.parse(raw) as SignedPayload<T>;
            if (!payload || typeof payload !== 'object') return null;
            if (!verify(payload.data, payload.sig)) {
                console.warn('[Save] 签名校验失败，数据已被篡改，丢弃:', key);
                sys.localStorage.removeItem(key);
                return null;
            }
            return payload.data;
        } catch (e) {
            console.error('[Save] 读取异常', key, e);
            return null;
        }
    }

    // ---------------------------------------------------------------- 全局档案

    private static defaultProfile(): PlayerProfile {
        return {
            version: SAVE_VERSION,
            unlockedLevel: 1,
            clearedLevels: [],
            maxTiers: {},
            globalMaxTier: 1,
            clearCounts: {},
            bestScores: {},
            bestTimes: {},
            gold: 0,
            equipment: [],
            equippedIds: [],
            totalAdViews: 0,
            totalRestarts: 0,
            achievements: [],
            seenForms: [],
            fusionCount: 0,
            totalKills: 0,
            affinityClearCount: 0,
            replayCounts: {},
            replayBoosts: {},
            materials: {},
            shards: {},
            stones: {},
            armor: { owned: [], worn: null },
            crystals: 0,
            auxOwned: [],
            pityWeapon: 0,
            pityAux: 0,
            gachaTotal: 0,
            fragHigh: 0,
            blessing: 0,
            totalSacrificed: 0,
            totalAscends: 0,
            tutorials: {},
            omni: { stage: 0 },
            createdAt: Date.now(),
        };
    }

    static getProfile(): PlayerProfile {
        if (this.profileCache) return this.profileCache;
        let p = this.readSigned<PlayerProfile>(KEY_PROFILE);
        if (!p) {
            p = this.defaultProfile();
            this.writeSigned(KEY_PROFILE, p);
        } else {
            p = this.migrateProfile(p);
        }
        this.profileCache = p;
        return p;
    }

    /** 老存档升级：以后加字段都在这里补默认值，避免老玩家存档崩溃 */
    private static migrateProfile(p: PlayerProfile): PlayerProfile {
        const fromVersion = p.version || 1;

        p.version = SAVE_VERSION;
        p.clearedLevels = p.clearedLevels || [];
        p.maxTiers = p.maxTiers || {};
        p.clearCounts = p.clearCounts || {};
        p.bestScores = p.bestScores || {};
        p.bestTimes = p.bestTimes || {};
        p.gold = p.gold || 0;
        p.equipment = p.equipment || [];
        p.equippedIds = p.equippedIds || [];
        p.totalAdViews = p.totalAdViews || 0;
        p.totalRestarts = p.totalRestarts || 0;
        p.unlockedLevel = Math.max(1, p.unlockedLevel || 1);

        // v3 新字段兜底（放在迁移之前，保证 migrateToV3 能直接用）
        p.achievements = p.achievements || [];
        p.seenForms = p.seenForms || [];
        p.fusionCount = p.fusionCount || 0;
        p.totalKills = p.totalKills || 0;
        p.affinityClearCount = p.affinityClearCount || 0;
        p.replayCounts = p.replayCounts || {};
        p.replayBoosts = p.replayBoosts || {};

        // v4 新字段兜底：突破材料 / 属性碎片 / 完整材料 / 防具
        // 老玩家一律从"一阶、空槽、无防具"开始 —— 不补任何材料，
        // 否则等于凭空发一批掉落，破坏"材料只能靠打关卡拿"这条规则。
        p.materials = p.materials || {};
        p.shards = p.shards || {};
        p.stones = p.stones || {};
        if (!p.armor) p.armor = { owned: [], worn: null };
        // v6 起 owned 是 OwnedArmor[]。老存档可能是 string[]，
        // 这里先兜底成空数组，真正的形状转换在 migrateToV6 里做。
        p.armor.owned = (p.armor.owned || []) as unknown as typeof p.armor.owned;
        if (p.armor.worn === undefined) p.armor.worn = null;
        // 武器的锻造字段：空槽起步。
        // 【v6 起这里不再有 rank】品阶接管了槽位数，见 migrateToV6。
        // 但老存档的 rank 仍可能在这里出现，所以先按旧结构读一遍，
        // 真正的映射在 migrateToV6 里做。
        for (const e of p.equipment) {
            const legacyForge = e.forge as unknown as {
                rank?: number;
                sockets?: (ElementId | null)[];
            } | undefined;
            if (!e.forge) e.forge = { sockets: [null] };
            if (!e.forge.sockets) e.forge.sockets = legacyForge && legacyForge.sockets
                ? legacyForge.sockets.slice()
                : [null];
            // 移除已在配置表里被删掉的镶嵌属性（改表时可能发生）
            e.forge.sockets = e.forge.sockets.map(
                (s) => (s && ELEMENT_IDS.indexOf(s as ElementId) >= 0 ? s : null)
            );
            while (e.forge.sockets.length < 1) e.forge.sockets.push(null);
        }

        // v5 新字段兜底：许愿水晶 / 抽卡保底 / 辅助局外持有
        //
        // 【为什么不凭空补水晶】
        //   与 v4 迁移同一原则：老玩家已经用"自动发放"玩了很多局，
        //   现在改抽卡不该让他一进游戏就白拿 100 水晶十连。
        //   所以从 0 开始，靠下一次通关挣 —— 起步慢，但每一分都是自己打的。
        //
        // 【辅助持有从"图鉴"里回填】
        //   老玩家在局内见过辅助形态，但那时它们不落档案。
        //   这里从 seenForms 里把辅助根形态捞出来，一件都不给阶数（1 阶），
        //   理由同上：不凭空发养成资源。
        //   只捞根形态（depth 0），因为深层形态本来就不该直接持有，
        //   那是局内进化才该到达的深度。
        p.crystals = p.crystals || 0;
        p.pityWeapon = p.pityWeapon || 0;
        p.pityAux = p.pityAux || 0;
        p.gachaTotal = p.gachaTotal || 0;
        if (!p.auxOwned) p.auxOwned = [];
        // 剔除配置表里已删除的辅助（改表时可能发生）。
        //
        // 【这里不能用 !!indexOf(...)】
        // indexOf 对首元素返回 0，而 !!0 === false —— 那样会把
        // AUX_ROOT_IDS[0]（aux_thorn）当成"不存在"删掉。
        // 这正是"不要用 indexOf 的结果做否定判断"那条约束的由来，
        // 这里用显式的 >= 0 把它写死。
        p.auxOwned = p.auxOwned.filter((a) => !!a && AUX_ROOT_IDS.indexOf(a.id) >= 0);
        for (const a of p.auxOwned) {
            a.rank = Math.max(1, Math.min(AUX_MAX_RANK, Math.floor(a.rank || 1)));
        }
        // 已在局内见过的辅助根形态，默认记为 1 阶持有
        for (const auxId of AUX_ROOT_IDS) {
            if (p.seenForms.indexOf(auxId) < 0) continue;
            if (p.auxOwned.some((a) => a.id === auxId)) continue;
            p.auxOwned.push({ id: auxId, rank: 1 });
        }

        // v6 新字段兜底：高阶碎片 / 祝福值 / 升阶统计
        p.fragHigh = p.fragHigh || 0;
        p.blessing = p.blessing || 0;
        p.totalSacrificed = p.totalSacrificed || 0;
        p.totalAscends = p.totalAscends || 0;
        // v7 新字段兜底：教学已看记录（老存档一律从"空"开始，不补任何已看）
        p.tutorials = p.tutorials || {};

        if (fromVersion < 2) this.migrateToV2(p);
        if (fromVersion < 3) this.migrateToV3(p);
        // v5 的字段是上面内联兜底的（没有独立函数），v6 才需要单独迁移
        if (fromVersion < 6) this.migrateToV6(p);
        // 第九轮：v7 把防具持有升级为「四部位套装 + 实例 uid」
        if (fromVersion < 7) this.migrateToV7(p);
        // 第十一轮：v8 补「万象线」进度字段（只补结构，不白送任何资源）
        if (fromVersion < 8) this.migrateToV8(p);

        // 兜底：maxTiers 至少为 1，且已解锁的关卡都有条目
        for (let i = 1; i <= p.unlockedLevel; i++) {
            const k = String(i);
            p.maxTiers[k] = Math.max(1, normalizeTier(p.maxTiers[k] || 1));
        }
        p.globalMaxTier = Math.max(1, normalizeTier(this.computeGlobalMaxTier(p)));

        this.writeSigned(KEY_PROFILE, p);
        return p;
    }

    /**
     * v1 → v2 迁移：给所有数据补上"难度 = 1（普通）"这一维。
     *
     * 老版本的档案键是 mg_archive_3，统计键是 "3"。
     * 迁移后统一变成 mg_archive_3_1 与 "3_1"，玩家的通关记录一条不丢。
     */
    private static migrateToV2(p: PlayerProfile): void {
        const allLevels: number[] = [];
        for (let i = 1; i <= p.unlockedLevel; i++) allLevels.push(i);
        for (const lv of p.clearedLevels) {
            if (allLevels.indexOf(lv) < 0 && lv > 0) allLevels.push(lv);
        }

        let moved = 0;
        for (const lv of allLevels) {
            const oldKey = KEY_ARCHIVE_PREFIX_LEGACY + lv;
            const raw = sys.localStorage.getItem(oldKey);
            if (raw === null) continue;
            const newKey = this.archiveKey(lv, 1);
            if (sys.localStorage.getItem(newKey) === null) {
                sys.localStorage.setItem(newKey, raw);
                moved += 1;
            }
            sys.localStorage.removeItem(oldKey);
        }

        const remap = (src: Record<string, number>): Record<string, number> => {
            const out: Record<string, number> = {};
            for (const k of Object.keys(src || {})) {
                // 已经是新格式（含下划线）就原样保留
                out[k.indexOf('_') >= 0 ? k : k + '_1'] = src[k];
            }
            return out;
        };
        p.clearCounts = remap(p.clearCounts);
        p.bestScores = remap(p.bestScores);
        p.bestTimes = remap(p.bestTimes);

        // 所有已通关的关卡，难度都从普通开始重新解锁
        for (const lv of allLevels) {
            if (p.maxTiers[String(lv)] === undefined) p.maxTiers[String(lv)] = 1;
        }
        p.globalMaxTier = 1;

        if (moved > 0) {
            console.log('[Save] 存档迁移 v1 → v2：移动了 ' + moved + ' 份关卡档案到难度维度');
        }
    }

    /**
     * v2 → v3 迁移：把"线性进化链"的档案升级成"形态图"的档案。
     *
     * v2 的 EquipRunState 是 { id, stage, exp }，没有 formId 也没有 kind。
     * v3 需要 formId 才能查形态。迁移策略是**反查**：
     * 沿该武器线的主线（evolveTo 第一项）走 stage 步，得到 formId。
     *
     * 为什么不做成"读到旧档案时懒迁移"：
     * 那样每次读档案都要走一遍反查分支，永久代码里留一条只为兼容的分支。
     * 一次性搬完，之后所有代码都可以假定 formId 一定存在。
     */
    private static migrateToV3(p: PlayerProfile): void {
        let archivesTouched = 0;
        const seen: string[] = p.seenForms.slice();

        const markSeen = (formId: string): void => {
            if (seen.indexOf(formId) < 0) seen.push(formId);
        };

        const maxLevel = Math.max(p.unlockedLevel, 1);
        for (let lv = 1; lv <= maxLevel; lv++) {
            for (let t = 1; t <= MAX_TIER; t++) {
                const a = this.loadArchive(lv, t);
                if (!a || !a.loadout || !a.loadout.equipment) continue;

                let dirty = false;
                for (const st of a.loadout.equipment) {
                    if (st.kind === undefined) {
                        st.kind = 'weapon';
                        dirty = true;
                    }
                    if (!st.formId) {
                        st.formId = st.kind === 'aux' ? st.id : legacyFormId(st.id, st.stage || 0);
                        dirty = true;
                    }
                    markSeen(st.formId);
                }
                if (!a.loadout.talents) {
                    a.loadout.talents = {};
                    dirty = true;
                }
                if (a.boostPercent === undefined) {
                    a.boostPercent = 0;
                    dirty = true;
                }

                if (dirty || archivesTouched === 0) {
                    // 重新签名写回。签名逻辑与写入路径一致，所以不会破坏校验。
                    this.writeSigned(this.archiveKey(lv, t), a);
                    archivesTouched += 1;
                }
            }
        }

        // 老玩家开局就拥有 STARTER 武器的根形态，先补进图鉴，
        // 否则"图鉴 10 种"这类成就会从 0 开始算，看起来像进度丢了。
        for (const f of ALL_FORMS) {
            if (f.depth === 0 && p.equipment.some((e) => e.id === f.id)) markSeen(f.id);
        }
        p.seenForms = seen;

        if (archivesTouched > 0) {
            console.log('[Save] 存档迁移 v2 → v3：升级了 ' + archivesTouched + ' 份档案到形态图');
        }
    }

    // ================================================================
    // v5 → v6：品阶替代 forge.rank
    // ================================================================

    /**
     * v5 → v6 迁移：把"突破等阶"这套旧阶梯映射成"品阶"。
     *
     * 【为什么要映射而不是清零】
     *   老玩家为 forge.rank 投入了材料与金币（rank 5 要 20 个专属材料）。
     *   清零等于把几个星期的投入一笔勾销，这是最伤玩家的迁移方式。
     *   所以按 `rarity = rank - 1` 映射：
     *     rank 1 → 青铜(0)   rank 2 → 白银(1)   rank 3 → 黄金(2)
     *     rank 4 → 钻石(3)   rank 5 → 史诗(4)
     *   语义也对得上：老 rank 越高 = 投入越多 = 品阶越高。
     *
     * 【为什么不给玩家补到神话/传说】
     *   神话要专属材料、传说只能从神话进化。凭空映射上去等于
     *   跳过了整套第八轮内容，与"不白送养成资源"的原则冲突。
     *   老玩家迁移后最高到史诗，往上仍然要自己打三复合噩梦关卡。
     *
     * 【镶嵌槽位：只增不减】
     *   两套阶梯的槽位表不完全一致（老 rank 5 = 4 槽，史诗 = 3 槽）。
     *   ForgeManager.forgeOf() 已经保证长度只增不减，
     *   所以这里**不需要**动 sockets 数组 —— 老玩家保底保留原有石头。
     *
     * 【防具 owned 从 string[] 改成对象数组】
     *   品阶成了正式维度，必须能分别记录同款防具的不同品阶。
     *   迁移时按防具的**原生品阶**入档（老玩家此前没有品阶概念，
     *   他们持有的就是配置表原生的那一个）。
     */
    private static migrateToV6(p: PlayerProfile): void {
        let weaponsMapped = 0;
        let armorsMapped = 0;

        for (const e of p.equipment) {
            const forge = e.forge as unknown as {
                rank?: number;
                sockets?: (ElementId | null)[];
            } | undefined;
            const oldRank = forge && forge.rank ? Math.floor(forge.rank) : 1;
            // rank 1~5 → rarity 0~4
            e.rarity = Math.max(0, Math.min(4, oldRank - 1));
            // 配置表里声明了更高原生品阶的（高阶专属武器）以配置表为准
            const def = getEquipDef(e.id);
            if (def && def.rarity !== undefined && def.rarity > e.rarity) {
                e.rarity = def.rarity;
            }
            // forge 只保留 sockets，删掉 rank（字段已从类型上移除）
            e.forge = { sockets: forge && forge.sockets ? forge.sockets.slice() : [null] };
            // 清掉配置表里已不存在的镶嵌属性
            e.forge.sockets = e.forge.sockets.map(
                (s) => (s && ELEMENT_IDS.indexOf(s as ElementId) >= 0 ? s : null)
            );
            weaponsMapped += 1;
        }

        // 防具：string[] → OwnedArmor[]
        const rawOwned = (p.armor ? p.armor.owned : []) as unknown as Array<string | OwnedArmor>;
        const newOwned: OwnedArmor[] = [];
        for (const item of rawOwned || []) {
            if (!item) continue;
            if (typeof item === 'string') {
                const def = getArmorDef(item);
                if (!def) continue;
                const rarity = normalizeRarity(def.rarity === undefined ? 0 : def.rarity);
                newOwned.push({
                    uid: newArmorUid(),
                    id: item,
                    rarity,
                    sockets: emptyArmorSockets(rarity),
                    openedSlots: 0,
                });
                armorsMapped += 1;
            } else if (typeof item === 'object' && item.id) {
                const def = getArmorDef(item.id);
                if (!def) continue;
                const rarity = normalizeRarity(item.rarity === undefined ? 0 : item.rarity);
                newOwned.push({
                    uid: newArmorUid(),
                    id: item.id,
                    rarity,
                    sockets: emptyArmorSockets(rarity),
                    openedSlots: 0,
                });
                armorsMapped += 1;
            }
        }
        if (p.armor) p.armor.owned = newOwned;

        // 辅助装备补 rarity 字段
        for (const a of p.auxOwned) {
            if (a.rarity === undefined) {
                const f = getForm(a.id);
                a.rarity = normalizeRarity(f && f.rarity !== undefined ? f.rarity : 0);
            } else {
                a.rarity = normalizeRarity(a.rarity);
            }
        }

        if (weaponsMapped > 0 || armorsMapped > 0) {
            console.log('[Save] 存档迁移 v5 → v6：' + weaponsMapped + ' 件武器的突破等阶映射为品阶，' +
                armorsMapped + ' 件防具迁移到带品阶结构');
        }
    }

    // ================================================================
    // v6 → v7：防具改为「四部位套装 + 实例 uid」模型
    // ================================================================

    /**
     * v6 → v7 迁移：防具持有从「部件 id 去重」升级为「可重复实例（uid）」。
     *
     * 【为什么需要这步】
     *   第九轮前防具是单件、按 id 去重持有；第九轮起每件防具是一个带 uid
     *   的实例，且允许重复持有（重复件=升阶燃料）。v6 迁过来的 OwnedArmor
     *   没有 uid、没有 sockets/openedSlots，且旧 worn 指向的是「部件 id 字符串」
     *   而非 uid，直接拿来用会悬空。
     *
     * 【处理策略】
     *   - 为每件已持有防具补上 newArmorUid() 与空 sockets / openedSlots=0；
     *   - 旧 worn 若是字符串（旧单件 id），把它对应实例穿上到正确部位；
     *     若是别的（null / 异常），重置为 null，让玩家在锻造界面自行穿戴。
     */
    private static migrateToV7(p: PlayerProfile): void {
        if (!p.armor) p.armor = { owned: [], worn: null };
        if (!p.armor.owned) p.armor.owned = [];

        const newOwned: OwnedArmor[] = [];
        let n = 0;
        for (const item of p.armor.owned) {
            if (!item || !item.id) continue;
            const def = getArmorDef(item.id);
            if (!def) continue;
            const rarity = normalizeRarity(item.rarity === undefined ? (def.rarity || 0) : item.rarity);
            // 槽位至少补齐「品阶基础孔」（与武器对称）；老档的 [] 在这里被补成 base 个空孔
            const socks: (ElementId | null)[] = Array.isArray(item.sockets) ? item.sockets.slice() : [];
            const base = raritySockets(rarity);
            while (socks.length < base) socks.push(null);
            newOwned.push({
                uid: item.uid || newArmorUid(),
                id: item.id,
                rarity,
                sockets: socks,
                openedSlots: typeof item.openedSlots === 'number' ? item.openedSlots : 0,
            });
            n += 1;
        }
        p.armor.owned = newOwned;

        // 旧 worn：可能是字符串（旧单件 id）
        const oldWornId = typeof p.armor.worn === 'string' ? p.armor.worn : null;
        p.armor.worn = null;
        if (oldWornId) {
            const owned = newOwned.find((a) => a.id === oldWornId);
            if (owned) {
                const def = getArmorDef(owned.id);
                if (def) {
                    const worn: ArmorWorn = {};
                    worn[def.part] = owned.uid;
                    p.armor.worn = worn;
                }
            }
        }

        if (n > 0) {
            console.log('[Save] 存档迁移 v6 → v7：' + n + ' 件防具补上实例 uid 与四部位穿戴结构');
        }
    }

    /**
     * v7 → v8 迁移：补「万象线」进度字段。
     *
     * 第十一轮把第四轮遗留的「万象镜甲」改造成一条隐藏养成线（碎片 → 全属性石 → 逐级升级 → 万象套四件），
     * 进度存在 `PlayerProfile.omni.stage`。这里只做两件事：
     *   1. 缺字段就补 `{ stage: 0 }`（老玩家从"未开始"起步）；
     *   2. 把非法值 clamp 到 `[0, OMNI_MAX_STAGE]`（防篡改 / 防越界）。
     *
     * **不白送任何资源**：不补全属性石、不补万象套装备 —— 进度必须自己打出来。
     */
    private static migrateToV8(p: PlayerProfile): void {
        let stage = 0;
        if (p.omni && typeof p.omni.stage === 'number' && isFinite(p.omni.stage)) {
            stage = Math.floor(p.omni.stage);
        }
        if (stage < 0) stage = 0;
        if (stage > OMNI_MAX_STAGE) stage = OMNI_MAX_STAGE;
        p.omni = { stage };
        if (stage > 0) {
            console.log('[Save] 存档迁移 v7 → v8：万象线进度保留在 stage ' + stage);
        }
    }

    private static computeGlobalMaxTier(p: PlayerProfile): number {
        let max = 1;
        for (const k of Object.keys(p.maxTiers || {})) {
            const v = p.maxTiers[k];
            if (v > max) max = v;
        }
        return max;
    }

    static saveProfile(p: PlayerProfile): void {
        this.profileCache = p;
        this.writeSigned(KEY_PROFILE, p);
    }

    static unlockLevel(levelId: number): void {
        const p = this.getProfile();
        let dirty = false;
        if (levelId > p.unlockedLevel) {
            p.unlockedLevel = levelId;
            dirty = true;
        }
        // 新解锁的关卡默认只有普通难度
        if (p.maxTiers[String(levelId)] === undefined) {
            p.maxTiers[String(levelId)] = 1;
            dirty = true;
        }
        if (dirty) this.saveProfile(p);
    }

    // ---------------------------------------------------------------- 难度解锁

    /** 某关已解锁的最高难度，至少为 1 */
    static getMaxTier(levelId: number): number {
        const p = this.getProfile();
        return Math.max(1, normalizeTier(p.maxTiers[String(levelId)] || 1));
    }

    static isTierUnlocked(levelId: number, tier: number): boolean {
        return normalizeTier(tier) <= this.getMaxTier(levelId);
    }

    /**
     * 解锁某关的更高难度。
     * 难度解锁是**每关独立**的：第 3 关打到困难，不会让第 5 关也解锁困难。
     */
    static unlockTier(levelId: number, tier: number): boolean {
        const t = normalizeTier(tier);
        const p = this.getProfile();
        const key = String(levelId);
        const cur = Math.max(1, normalizeTier(p.maxTiers[key] || 1));
        if (t <= cur) return false;

        p.maxTiers[key] = t;
        p.globalMaxTier = Math.max(p.globalMaxTier || 1, this.computeGlobalMaxTier(p));
        this.saveProfile(p);

        // 全局最高难度变化会影响出战槽位与装备解锁，交给调用方 refresh
        console.log('[Save] 第 ' + levelId + ' 关解锁难度 ' + t +
            '，全局最高难度 ' + p.globalMaxTier);
        return true;
    }

    /** 全局最高已解锁难度（驱动出战槽位与装备开放） */
    static getGlobalMaxTier(): number {
        const p = this.getProfile();
        return Math.max(1, normalizeTier(p.globalMaxTier || 1));
    }

    /** 发放永久金币（局外升级装备用） */
    static addGold(amount: number): void {
        if (amount <= 0) return;
        const p = this.getProfile();
        p.gold += amount;
        this.saveProfile(p);
    }

    static bumpAdView(): void {
        const p = this.getProfile();
        p.totalAdViews += 1;
        this.saveProfile(p);
    }

    static bumpRestart(): void {
        const p = this.getProfile();
        p.totalRestarts += 1;
        this.saveProfile(p);
    }

    // ---------------------------------------------------------------- v3：图鉴 / 成就 / 复玩

    /**
     * 记录"见过的形态"（进化图鉴）。
     *
     * 一路上遇到的每个形态都要记 —— 不只是最终形态。
     * 玩家从铁剑走到天罚剑，中途的淬锋、裂空也应该进图鉴，
     * 否则"收录 30 种形态"这个成就永远达不到，因为一局里只会停在终点。
     */
    static markFormsSeen(ids: string[]): void {
        if (!ids || ids.length === 0) return;
        const p = this.getProfile();
        let dirty = false;
        for (const id of ids) {
            if (!id) continue;
            if (p.seenForms.indexOf(id) >= 0) continue;
            p.seenForms.push(id);
            dirty = true;
        }
        if (dirty) this.saveProfile(p);
    }

    /** 图鉴已收录的形态 id */
    static getSeenForms(): string[] {
        return this.getProfile().seenForms.slice();
    }

    /** 结算时批量并入累计计数（只写一次档，避免一次通关写四遍） */
    static addCounters(kills: number, fusions: number, affinityClears: number): void {
        const p = this.getProfile();
        p.totalKills = (p.totalKills || 0) + Math.max(0, kills);
        p.fusionCount = (p.fusionCount || 0) + Math.max(0, fusions);
        p.affinityClearCount = (p.affinityClearCount || 0) + Math.max(0, affinityClears);
        this.saveProfile(p);
    }

    /**
     * 解锁成就并发放金币奖励。
     *
     * @returns 新解锁的成就 id（已经解锁过的会被过滤掉，重复调用是安全的）
     */
    static unlockAchievements(records: AchievementRecord[], gold: number): string[] {
        if (!records || records.length === 0) return [];
        const p = this.getProfile();
        const fresh: string[] = [];
        for (const r of records) {
            if (p.achievements.some((a) => a.id === r.id)) continue;
            p.achievements.push({ id: r.id, at: r.at });
            fresh.push(r.id);
        }
        if (fresh.length === 0) return [];
        p.gold += Math.max(0, gold);
        this.saveProfile(p);
        return fresh;
    }

    /** 已解锁的成就 id */
    static getAchievementIds(): string[] {
        return this.getProfile().achievements.map((a) => a.id);
    }

    // ---------------------------------------------------------------- 复玩

    static replayKey(levelId: number, tier: number): string {
        return this.statKey(levelId, tier);
    }

    /** 该关该难度复玩过几次（首次进入算第 1 次，返回 0） */
    static getReplayCount(levelId: number, tier: number): number {
        return this.getProfile().replayCounts[this.replayKey(levelId, tier)] || 0;
    }

    /** 记一次复玩进入 */
    static bumpReplay(levelId: number, tier: number): number {
        const p = this.getProfile();
        const k = this.replayKey(levelId, tier);
        p.replayCounts[k] = (p.replayCounts[k] || 0) + 1;
        this.saveProfile(p);
        return p.replayCounts[k];
    }

    /** 该关该难度上次选的加难百分比 */
    static getReplayBoost(levelId: number, tier: number): number {
        const v = this.getProfile().replayBoosts[this.replayKey(levelId, tier)];
        return Math.max(0, Math.min(REPLAY_BOOST_MAX, v || 0));
    }

    /** 记住该关该难度的加难百分比 */
    static setReplayBoost(levelId: number, tier: number, percent: number): void {
        const p = this.getProfile();
        p.replayBoosts[this.replayKey(levelId, tier)] =
            Math.max(0, Math.min(REPLAY_BOOST_MAX, percent || 0));
        this.saveProfile(p);
    }

    /** 是否已经反复玩过（决定要不要弹"是否加难"） */
    static hasReplayed(levelId: number, tier: number): boolean {
        return this.getReplayCount(levelId, tier) > 0;
    }

    // ---------------------------------------------------------------- 单局运行态

    static saveLevel(state: LevelState): void {
        state.updatedAt = Date.now();
        this.writeSigned(KEY_LEVEL, state);
    }

    static loadLevel(): LevelState | null {
        const s = this.readSigned<LevelState>(KEY_LEVEL);
        if (!s) return null;
        s.difficulty = normalizeTier(s.difficulty || 1);

        // v3 兜底：v2 的单局运行态是扁平的 `equipment: EquipRunState[]`，
        // 没有 loadout 也没有 replay。单局态是临时的，直接现场补一个空 build 即可 ——
        // 它的档案才是真正需要迁移的东西（见 migrateToV3）。
        const legacy = s as unknown as { equipment?: LevelArchive['loadout']['equipment'] };
        if (!s.loadout) {
            const lo: RunLoadoutState = {
                weapons: [], auxes: [], talents: {},
                level: 1, pendingExp: 0, pendingPicks: 0, pending: [],
            };
            for (const st of legacy.equipment || []) {
                const item = {
                    id: st.id,
                    formId: st.formId || (st.kind === 'aux' ? st.id : legacyFormId(st.id, st.stage || 0)),
                    kind: st.kind || ('weapon' as const),
                    stage: st.stage || 0,
                    exp: Math.max(0, Math.floor(st.exp || 0)),
                };
                if (item.kind === 'aux') lo.auxes.push(item);
                else lo.weapons.push(item);
            }
            s.loadout = lo;
        }
        if (!s.replay) s.replay = { enabled: false, percent: 0 };
        return s;
    }

    static clearLevel(): void {
        sys.localStorage.removeItem(KEY_LEVEL);
    }

    // ---------------------------------------------------------------- 关卡档案

    /** 该关该难度是否已通关过（有档案即视为通关过） */
    static hasArchive(levelId: number, tier: number): boolean {
        return sys.localStorage.getItem(this.archiveKey(levelId, tier)) !== null;
    }

    static loadArchive(levelId: number, tier: number): LevelArchive | null {
        const a = this.readSigned<LevelArchive>(this.archiveKey(levelId, tier));
        if (!a) return null;
        // 兼容：老档案没有 difficulty 字段
        a.levelId = levelId;
        a.difficulty = normalizeTier(a.difficulty || tier);
        return a;
    }

    /**
     * 写入关卡档案。
     * 注意：调用方要保证 loadout 已经过白名单裁剪，不要把整份运行态直接塞进来。
     */
    static saveArchive(archive: LevelArchive): void {
        archive.difficulty = normalizeTier(archive.difficulty || 1);
        this.writeSigned(this.archiveKey(archive.levelId, archive.difficulty), archive);

        const p = this.getProfile();
        const key = this.statKey(archive.levelId, archive.difficulty);
        p.clearCounts[key] = archive.clearCount;
        p.bestScores[key] = archive.bestScore;
        p.bestTimes[key] = archive.bestTime;
        if (p.clearedLevels.indexOf(archive.levelId) < 0) {
            p.clearedLevels.push(archive.levelId);
        }
        this.saveProfile(p);
    }

    /**
     * 删除某关某难度的档案 —— 玩家主动重置该难度的数据时调用。
     * 删除后该难度回到未通关前的状态，复玩时只能从初始数据开局。
     *
     * 注意：默认的「重新开始」并不会调用这里（见 LevelFlow 的 DROP_ARCHIVE_ON_RESTART），
     * 因为玩家往往只是想重玩一遍，不该因此丢掉辛苦攒下的装备。
     */
    static dropArchive(levelId: number, tier: number): void {
        const t = normalizeTier(tier);
        sys.localStorage.removeItem(this.archiveKey(levelId, t));

        const p = this.getProfile();
        const key = this.statKey(levelId, t);
        delete p.clearCounts[key];
        delete p.bestScores[key];
        delete p.bestTimes[key];

        // 只有该关所有难度都没有档案了，才算"回到未通关"
        let anyLeft = false;
        for (let i = 1; i <= MAX_TIER; i++) {
            if (this.hasArchive(levelId, i)) {
                anyLeft = true;
                break;
            }
        }
        if (!anyLeft) {
            const idx = p.clearedLevels.indexOf(levelId);
            if (idx >= 0) p.clearedLevels.splice(idx, 1);
        }
        this.saveProfile(p);
    }

    /** 该关是否至少通关过一个难度 */
    static hasAnyArchive(levelId: number): boolean {
        for (let i = 1; i <= MAX_TIER; i++) {
            if (this.hasArchive(levelId, i)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- 危险操作

    /** 清空所有数据，只在"玩家主动要求"或存档彻底损坏时调用 */
    static resetAll(): void {
        const p = this.getProfile();
        for (let i = 1; i <= p.unlockedLevel; i++) {
            for (let t = 1; t <= MAX_TIER; t++) {
                sys.localStorage.removeItem(this.archiveKey(i, t));
                sys.localStorage.removeItem(KEY_ARCHIVE_PREFIX_LEGACY + i);
            }
        }
        sys.localStorage.removeItem(KEY_LEVEL);
        sys.localStorage.removeItem(KEY_PROFILE);
        this.profileCache = null;
    }

    /** 调试用：导出存档文本 */
    static dump(): string {
        const p = this.getProfile();
        const archives: LevelArchive[] = [];
        for (let i = 1; i <= p.unlockedLevel; i++) {
            for (let t = 1; t <= MAX_TIER; t++) {
                const a = this.loadArchive(i, t);
                if (a) archives.push(a);
            }
        }
        return JSON.stringify({ profile: p, level: this.loadLevel(), archives }, null, 2);
    }
}
