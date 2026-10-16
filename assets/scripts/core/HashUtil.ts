/**
 * 存档签名工具
 *
 * 目标：让玩家不能直接用 fiddler / 微信开发者工具随手改 wx.setStorageSync 里的数值。
 * 手段：稳定序列化 + 加盐哈希。改动任意一个字段，签名就对不上，存档被判为篡改。
 *
 * 注意：小游戏包体最终会被反编译，盐值理论上能被挖出来。
 * 这里做的是"提高门槛"，足以挡掉 99% 的普通修改器玩家。
 * 如果数据涉及付费排行，必须再加服务端校验（见 README 的进阶方案）。
 */

/** 签名盐值：上线前替换成你自己的随机串，不要提交到公开仓库 */
const SALT = 'mg_lv_carry_2026_x7K9pQ';

/**
 * 稳定序列化：递归按 key 排序。
 * 必须用这个而不是 JSON.stringify——后者受 key 插入顺序影响，
 * 同一份数据两次序列化结果可能不同，签名会误判。
 */
export function stableStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number') {
        // 统一保留 6 位小数，避免浮点误差导致签名漂移
        return Number.isInteger(value) ? String(value) : value.toFixed(6);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const parts: string[] = [];
        for (const k of keys) {
            const v = (value as Record<string, unknown>)[k];
            if (v === undefined) continue;
            parts.push(JSON.stringify(k) + ':' + stableStringify(v));
        }
        return '{' + parts.join(',') + '}';
    }
    return 'null';
}

/** FNV-1a 32 位哈希 */
function fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

/** 对字符串做多轮混淆哈希，输出 16 位十六进制 */
function digest(str: string): string {
    const a = fnv1a(SALT + '#' + str + '#' + SALT);
    const b = fnv1a(str + '@' + a.toString(36) + '@' + SALT);
    const c = fnv1a(a.toString(16) + '%' + b.toString(16));
    return (
        a.toString(16).padStart(8, '0') +
        b.toString(16).padStart(8, '0') +
        c.toString(16).padStart(8, '0')
    ).slice(0, 24);
}

/** 对任意数据生成签名 */
export function sign(data: unknown): string {
    return digest(stableStringify(data));
}

/** 校验数据签名是否匹配 */
export function verify(data: unknown, sig: string): boolean {
    if (!sig || typeof sig !== 'string') return false;
    return digest(stableStringify(data)) === sig;
}

/** 生成闯关唯一 ID */
export function makeRunId(levelId: number): string {
    const t = Date.now().toString(36);
    const r = Math.floor(Math.random() * 0xffffff).toString(36);
    return 'L' + levelId + '-' + t + '-' + r;
}
