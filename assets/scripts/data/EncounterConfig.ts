/** 每波按时间持续补怪；数量为无同屏限流时的投放估算。 */
export const ENCOUNTER_WAVE_DURATION = 30;
export const ENCOUNTER_WAVE_COUNT = 3;
export const ENCOUNTER_MAX_ALIVE = 240;

export function encounterFor(levelId: number, countMul: number, boost = 0) {
    const base = 12 + Math.min(12, Math.floor((Math.max(1, levelId) - 1) / 10));
    const waves = Array.from({ length: ENCOUNTER_WAVE_COUNT }, (_, i) => ({
        duration: ENCOUNTER_WAVE_DURATION,
        spawnInterval: 1,
        spawnCount: Math.round((base + i * 4) * countMul * (1 + boost * .5)),
        hpMul: 1 + i * .25,
        atkMul: 1 + i * .15,
    }));
    return {
        waves,
        enemies: waves.reduce((n, w) => n + Math.ceil(w.duration / w.spawnInterval) * w.spawnCount, 0),
        batchSize: waves[0].spawnCount,
        batchInterval: waves[0].spawnInterval,
        maxAlive: ENCOUNTER_MAX_ALIVE,
    };
}
