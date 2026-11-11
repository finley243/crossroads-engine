import { condition, type EvalContext } from "./evaluate";
import { resolvePresentation } from "./presentation";
import type { Content, GameState, MapDef, MapLocation, Rng } from "./types";

/** Whether a map can be looked at from another one right now: it exists, and its requirement is met. */
export function isMapAvailable(content: Content, state: GameState, mapId: string, rng: Rng): boolean {
    const map = content.maps[mapId];
    return map !== undefined && (!map.requires || condition(map.requires, { content, state, rng }));
}

/** The locations on a map that are there right now. A marker that only opens a map is there only while that map is available. */
export function availableLocations(content: Content, state: GameState, map: MapDef, rng: Rng): MapLocation[] {
    const ctx: EvalContext = { content, state, rng };
    return map.locations
        .filter(location => !location.requires || condition(location.requires, ctx))
        .filter(location => location.node !== undefined || (location.map !== undefined && isMapAvailable(content, state, location.map, rng)));
}

// The maps above one: its parent, that map's parent, and so on. (A loop of parents is a load error, so this ends.)
function ancestorsOf(content: Content, mapId: string): string[] {
    const chain: string[] = [];
    for (let at = content.maps[mapId]?.parent; at !== undefined && content.maps[at] && !chain.includes(at); at = content.maps[at]!.parent) chain.push(at);
    return chain;
}

/** Whether a location is on a map, or on one nested under it: a map whose parent is that map, or whose parent's parent is, and so on. */
export function mapHoldsLocation(content: Content, mapId: string, locationId: string | null): boolean {
    if (locationId === null) return false;
    return Object.values(content.maps).some(map =>
        (map.id === mapId || ancestorsOf(content, map.id).includes(mapId)) && map.locations.some(location => location.id === locationId));
}

/**
 * Whether a marker that opens a map should show "you are here" because the player is somewhere on that map or under it.
 * Not a marker that opens a map above the one it's on, a link back up, which would claim the player wherever they were below.
 */
export function markerHoldsLocation(content: Content, holderId: string, location: MapLocation, locationId: string | null): boolean {
    if (location.map === undefined) return false;
    if (ancestorsOf(content, holderId).includes(location.map)) return false;
    return mapHoldsLocation(content, location.map, locationId);
}

/** The id of the location the player is at, from the presentation of the node they're in. */
export function currentLocationId(content: Content, state: GameState, rng: Rng): string | null {
    return resolvePresentation(content, state, rng).location;
}

/** Whether a location shown on the map can be traveled to yet. */
export function isUnlocked(content: Content, state: GameState, location: MapLocation, rng: Rng): boolean {
    if (!location.unlocked) return true;
    return condition(location.unlocked, { content, state, rng });
}

/** The locations the player could travel to: the unlocked ones, except the one they're already at. */
export function travelLocations(content: Content, state: GameState, map: MapDef, rng: Rng): MapLocation[] {
    const here = currentLocationId(content, state, rng);
    return availableLocations(content, state, map, rng).filter(location => location.node !== undefined && location.id !== here && isUnlocked(content, state, location, rng));
}
