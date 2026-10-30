import type { Direction } from "./input";

export interface Place {
    id: string;
    x: number;
    y: number;
}

const AXES: Record<Direction, { x: number; y: number }> = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
};

export function neighbor(from: { x: number; y: number }, places: Place[], direction: Direction, exclude?: string): Place | undefined {
    const axis = AXES[direction];
    let best: Place | undefined;
    let bestScore = Infinity;
    for (const place of places) {
        if (place.id === exclude) continue;
        const dx = place.x - from.x;
        const dy = place.y - from.y;
        const along = dx * axis.x + dy * axis.y;
        const across = Math.abs(dx * axis.y - dy * axis.x);
        if (along <= 0 || across > along) continue;
        const score = Math.hypot(along, 2 * across);
        if (score < bestScore) {
            best = place;
            bestScore = score;
        }
    }
    return best;
}

export function nearest(from: { x: number; y: number }, places: Place[], exclude?: string): Place | undefined {
    let best: Place | undefined;
    let bestDistance = Infinity;
    for (const place of places) {
        if (place.id === exclude) continue;
        const distance = Math.hypot(place.x - from.x, place.y - from.y);
        if (distance < bestDistance) {
            best = place;
            bestDistance = distance;
        }
    }
    return best;
}