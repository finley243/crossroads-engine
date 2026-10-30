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

/** The locations the player could travel to: the available ones, except the one they're already at. */
export function travelLocations(content: Content, state: GameState, map: MapDef, rng: Rng): MapLocation[] {
    const here = currentLocationId(content, state, rng);
    return availableLocations(content, state, map, rng).filter(location => location.id !== here);
}
