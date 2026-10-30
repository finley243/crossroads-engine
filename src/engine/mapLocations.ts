import { condition, type EvalContext } from "./evaluate";
import { resolvePresentation } from "./presentation";
import type { Content, GameState, MapDef, MapLocation, Rng } from "./types";

/** The locations on a map whose requirements are met right now. */
export function availableLocations(content: Content, state: GameState, map: MapDef, rng: Rng): MapLocation[] {
    const ctx: EvalContext = { content, state, bindings: {}, rng };
    return map.locations.filter(location => !location.requires || condition(location.requires, ctx) !== null);
}

/** The id of the location the player is at, from the presentation of the node they're in. */
export function currentLocationId(content: Content, state: GameState, rng: Rng): string | null {
    return resolvePresentation(content, state, rng).location;
}

/** Whether a location shown on the map can be traveled to yet. */
export function isUnlocked(content: Content, state: GameState, location: MapLocation, rng: Rng): boolean {
    if (!location.unlocked) return true;
    return condition(location.unlocked, { content, state, bindings: {}, rng }) !== null;
}

/** The locations the player could travel to: the unlocked ones, except the one they're already at. */
export function travelLocations(content: Content, state: GameState, map: MapDef, rng: Rng): MapLocation[] {
    const here = currentLocationId(content, state, rng);
    return availableLocations(content, state, map, rng).filter(location => location.id !== here && isUnlocked(content, state, location, rng));
}
