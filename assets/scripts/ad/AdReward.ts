/**
 * 激励视频广告封装
 *
 * 设计要点：
 * 1. 实例复用 —— 微信官方建议同一个 adUnitId 复用同一个实例，反复 create 会导致拉取失败率上升。
 * 2. 预加载 —— 进结算页前就 load()，玩家点按钮时能立刻播出，减少流失。
 * 3. isEnded 严格校验 —— 这是防白嫖的核心，必须 res && res.isEnded === true。
 * 4. 失败重试 —— show() 失败时重新 load() 再 show() 一次，仍失败才返回 false，由上层给兜底路径。
 * 5. 超时保护 —— 拉取广告超过 8 秒直接放弃，避免玩家看着 loading 卡住。
 */

/** 广告位标识，用于埋点区分不同触发场景的 eCPM 表现 */
export enum AdTag {
    /** 继承关卡数据到下一关（主变现位） */
    CARRY_OVER = 'carry_over',
    /** 卡点关复活 */
    REVIVE = 'revive',
    /** 结算双倍奖励 */
    DOUBLE_REWARD = 'double_reward',
    /**
     * 补许愿水晶（第七轮新增）。
     *
     * 【严格的可选加速位】
     *   抽卡的唯一货币是通关掉落的水晶，看广告只是提前拿到下一次抽卡的门票。
     *   任何代码路径都不允许把它当成抽卡的前置条件 ——
     *   GachaManager 的接口不接收 AdTag，从结构上保证这一点。
     */
    CRYSTAL = 'crystal',
}

/** 广告位 ID：在微信公众平台 → 流量主 → 广告位管理里创建后填入 */
const AD_UNIT_IDS: Record<AdTag, string> = {
    [AdTag.CARRY_OVER]: 'adunit-xxxxxxxxxxxxxxxx',
    [AdTag.REVIVE]: 'adunit-xxxxxxxxxxxxxxxx',
    [AdTag.DOUBLE_REWARD]: 'adunit-xxxxxxxxxxxxxxxx',
    [AdTag.CRYSTAL]: 'adunit-xxxxxxxxxxxxxxxx',
};

/** 开发期开关：编辑器预览没有 wx 环境，打开后用 mock 直接返回成功 */
const DEV_MOCK = true;

const LOAD_TIMEOUT = 8000;

function getWx(): any {
    return (globalThis as any).wx || null;
}

interface AdEntry {
    tag: AdTag;
    ad: any;
    loading: Promise<void> | null;
}

export class AdReward {
    private static pool: Map<AdTag, AdEntry> = new Map();
    /** 上一次广告是否成功播出，用于埋点 */
    private static lastResult: string = '';

    /** 在游戏启动时调用一次即可 */
    static init(): void {
        const wx = getWx();
        if (!wx || !wx.createRewardedVideoAd) {
            console.warn('[Ad] 当前环境不支持激励视频（编辑器预览或基础库过低）');
            return;
        }
        for (const tag of Object.keys(AD_UNIT_IDS) as AdTag[]) {
            this.getEntry(tag);
        }
    }

    private static getEntry(tag: AdTag): AdEntry | null {
        const cached = this.pool.get(tag);
        if (cached) return cached;

        const wx = getWx();
        if (!wx || !wx.createRewardedVideoAd) return null;

        const ad = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_IDS[tag] });
        const entry: AdEntry = { tag, ad, loading: null };

        ad.onError((err: any) => {
            // 常见 errCode：1004 无合适广告、1005 广告组件审核中、1008 广告单元无效
            console.error('[Ad] error', tag, err && err.errCode, err && err.errMsg);
            entry.loading = null;
        });

        this.pool.set(tag, entry);
        this.preload(tag);
        return entry;
    }

    /** 预加载：结算页弹出前调用，让广告就绪 */
    static preload(tag: AdTag): void {
        const entry = this.getEntry(tag);
        if (!entry || entry.loading) return;
        entry.loading = entry.ad.load().catch((e: any) => {
            console.warn('[Ad] 预加载失败', tag, e);
            entry.loading = null;
        });
    }

    /**
     * 展示广告。
     * @returns true = 用户完整看完（isEnded === true）；false = 中途关闭 / 拉取失败 / 环境不支持
     */
    static show(tag: AdTag): Promise<boolean> {
        if (DEV_MOCK && !getWx()) {
            console.log('[Ad][MOCK] 模拟看完广告:', tag);
            return Promise.resolve(true);
        }

        const entry = this.getEntry(tag);
        if (!entry) return Promise.resolve(false);

        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (v: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { entry.ad.offClose(onClose); } catch (e) { /* ignore */ }
                this.lastResult = v ? 'complete' : 'abort';
                resolve(v);
            };

            // 超时保护：网络差的情况下不能让玩家一直等
            const timer = setTimeout(() => {
                console.warn('[Ad] 超时未播出', tag);
                finish(false);
            }, LOAD_TIMEOUT + 4000);

            const onClose = (res: any) => {
                // ⚠️ 关键：部分机型 res 为 undefined，必须做空值保护，
                //    否则老版本基础库下 isEnded 取不到，逻辑会走反。
                const ended = !!(res && res.isEnded === true);
                finish(ended);
            };

            entry.ad.onClose(onClose);

            // show 失败通常是因为没有预加载好，重新 load 再 show 一次
            entry.ad.show().catch(() => {
                entry.loading = null;
                entry.ad.load()
                    .then(() => entry.ad.show())
                    .catch((e: any) => {
                        console.warn('[Ad] 二次展示失败', tag, e);
                        finish(false);
                    });
            });
        });
    }

    /** 埋点用：读取上一次结果 */
    static getLastResult(): string {
        return this.lastResult;
    }
}
