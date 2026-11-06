const MIN_CHANCE = 0;
const MAX_CHANCE = 100;

export function clampChance(percent: number): number {
    return Math.min(MAX_CHANCE, Math.max(MIN_CHANCE, percent));
}
