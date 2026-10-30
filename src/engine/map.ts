import { RuntimeError } from "./errors";
import { condition, type EvalContext } from "./evaluate";
import { advance, resolvePresentation } from "./step";
import type { Content, GameState, MapDef, MapLocation, MapView, Rng } from "./types";

export function mapView(content: Content, state: GameState, mapId: string, rng: Rng): MapView {
    const map = findMap(content, mapId);
    const currentLocation = resolvePresentation(content, state, rng).location;
    return {
        id: map.id,
        image: map.image,
        width: map.width,
        height: map.height,
        locations: availableLocations(content, state, map, rng).map(location => ({
            id: location.id,
            name: location.name,
            description: location.description,
            x: location.x,
            y: location.y,
            current: location.id === currentLocation,
        })),
    };
}

export function defaultMapId(content: Content, state: GameState, rng: Rng): string | undefined {
    const currentLocation = resolvePresentation(content, state, rng).location;
    const maps = Object.values(content.maps);
    const withCurrentLocation = maps.find(map => map.locations.some(location => location.id === currentLocation));
    return (withCurrentLocation ?? maps[0])?.id;
}

export function travel(content: Content, state: GameState, locationId: string, rng: Rng): GameState {
    if (state.screen.kind !== "map") throw new RuntimeError("There's no map open to travel from");
    const map = findMap(content, state.screen.map);
    const destination = availableLocations(content, state, map, rng).find(location => location.id === locationId);
    if (!destination) throw new RuntimeError(`'${locationId}' isn't available on the map '${map.id}' right now`);

    const s = structuredClone(state);
    s.stack = [];
    delete s.pending;
    advance(s, content, rng, { kind: "goto", node: destination.node, pause: false }, [], destination.name);
    return s;
}

export function closeMap(state: GameState): GameState {
    if (state.screen.kind !== "map") throw new RuntimeError("There's no map open");
    const s = structuredClone(state);
    s.screen = { kind: "node" };
    if (s.history[s.history.length - 1]?.text === "") s.history.pop();
    return s;
}

function findMap(content: Content, mapId: string): MapDef {
    const map = content.maps[mapId];
    if (!map) throw new RuntimeError(`Unknown map '${mapId}'`);
    return map;
}

function availableLocations(content: Content, state: GameState, map: MapDef, rng: Rng): MapLocation[] {
    const ctx: EvalContext = { content, state, bindings: {}, rng };
    return map.locations.filter(location => !location.requires || condition(location.requires, ctx) !== null);
}
