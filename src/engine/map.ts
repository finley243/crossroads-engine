import { RuntimeError } from "./errors";
import { availableLocations, currentLocationId, isUnlocked } from "./mapLocations";
import { advance } from "./step";
import type { Content, GameState, MapDef, MapView, Rng } from "./types";

export function mapView(content: Content, state: GameState, mapId: string, rng: Rng): MapView {
    const map = findMap(content, mapId);
    const currentLocation = currentLocationId(content, state, rng);
    return {
        id: map.id,
        image: map.image,
        width: map.width,
        height: map.height,
        locations: availableLocations(content, state, map, rng).map(location => {
            const current = location.id === currentLocation;
            const locked = !isUnlocked(content, state, location, rng);
            return {
                id: location.id,
                name: location.name,
                description: location.description,
                x: location.x,
                y: location.y,
                current,
                locked,
                lockedNote: location.lockedNote ?? "",
                travelable: !current && !locked,
            };
        }),
    };
}

export function defaultMapId(content: Content, state: GameState, rng: Rng): string | undefined {
    const currentLocation = currentLocationId(content, state, rng);
    const maps = Object.values(content.maps);
    const withCurrentLocation = maps.find(map => map.locations.some(location => location.id === currentLocation));
    return (withCurrentLocation ?? maps[0])?.id;
}

export function travel(content: Content, state: GameState, locationId: string, rng: Rng): GameState {
    if (state.screen.kind !== "map") throw new RuntimeError("There's no map open to travel from");
    const map = findMap(content, state.screen.map);
    const destination = availableLocations(content, state, map, rng).find(location => location.id === locationId);
    if (!destination) throw new RuntimeError(`'${locationId}' isn't available on the map '${map.id}' right now`);
    if (destination.id === currentLocationId(content, state, rng)) {
        throw new RuntimeError(`You're already at ${destination.name}`);
    }
    if (!isUnlocked(content, state, destination, rng)) {
        throw new RuntimeError(destination.lockedNote ? `${destination.name} is locked: ${destination.lockedNote}` : `${destination.name} is locked`);
    }

    const s = structuredClone(state);
    delete s.pending;
    advance(s, content, rng, { kind: "goto", node: destination.node, pause: false, clear: true }, [], destination.name);
    return s;
}

export function closeMap(state: GameState): GameState {
    if (state.screen.kind !== "map") throw new RuntimeError("There's no map open");
    if (!state.screen.cancelable) throw new RuntimeError(`The map '${state.screen.map}' can't be canceled; the player has to travel`);
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
