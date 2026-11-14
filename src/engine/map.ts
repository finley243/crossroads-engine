import { RuntimeError } from "./errors";
import { encounterTableFor, rollEncounter } from "./encounters";
import { availableLocations, currentLocationId, isMapAvailable, isUnlocked, markerHoldsLocation } from "./mapLocations";
import { advance } from "./step";
import type { Content, GameState, MapDef, MapLocationView, MapView, Rng, Transition } from "./types";

export function mapView(content: Content, state: GameState, mapId: string, rng: Rng): MapView {
    const map = findMap(content, mapId);
    const currentLocation = currentLocationId(content, state, rng);
    const view: MapView = {
        id: map.id,
        name: map.name,
        image: map.image,
        width: map.width,
        height: map.height,
        locations: availableLocations(content, state, map, rng).map(location => {
            const here = location.id === currentLocation; // the location itself, which is the one that can't be traveled to
            const locked = !isUnlocked(content, state, location, rng);
            const result: MapLocationView = {
                id: location.id,
                name: location.name,
                description: location.description,
                x: location.x,
                y: location.y,
                current: here || markerHoldsLocation(content, map.id, location, currentLocation),
                locked,
                lockedNote: location.lockedNote ?? "",
                travelable: location.node !== undefined && !here && !locked,
                destination: location.node !== undefined,
            };
            if (location.map !== undefined && isMapAvailable(content, state, location.map, rng)) {
                result.opens = { map: location.map, name: content.maps[location.map]!.name };
            }
            return result;
        }),
    };
    if (map.parent !== undefined && isMapAvailable(content, state, map.parent, rng)) {
        view.parent = { map: map.parent, name: content.maps[map.parent]!.name };
    }
    return view;
}

export function defaultMapId(content: Content, state: GameState, rng: Rng): string | undefined {
    const currentLocation = currentLocationId(content, state, rng);
    if (currentLocation === null) return undefined; // a node with no location has no map
    return Object.values(content.maps).find(map => map.locations.some(location => location.id === currentLocation))?.id;
}

export function travel(content: Content, state: GameState, locationId: string, rng: Rng): GameState {
    if (state.screen.kind !== "map") throw new RuntimeError("There's no map open to travel from");
    const map = findMap(content, state.screen.map);
    const destination = availableLocations(content, state, map, rng).find(location => location.id === locationId);
    if (!destination) throw new RuntimeError(`'${locationId}' isn't available on the map '${map.id}' right now`);
    if (destination.node === undefined) throw new RuntimeError(`${destination.name} only opens a map, so it can't be traveled to`);
    if (destination.id === currentLocationId(content, state, rng)) {
        throw new RuntimeError(`You're already at ${destination.name}`);
    }
    if (!isUnlocked(content, state, destination, rng)) {
        throw new RuntimeError(destination.lockedNote ? `${destination.name} is locked: ${destination.lockedNote}` : `${destination.name} is locked`);
    }

    const s = structuredClone(state);
    s.stack = [];
    delete s.pending;
    // An encounter on the way goes on the stack like a pushed room, with a return that carries on to the destination.
    // The destination isn't entered until then, so its text comes after the encounter's.
    const table = encounterTableFor(map, destination);
    const encounter = table === undefined ? undefined : rollEncounter(content, s, table, rng);
    const first: Transition = encounter
        ? {
              kind: "push",
              node: encounter.node,
              pause: false,
              trip: true,
              onReturn: [{ kind: "do", effect: { kind: "goto", node: destination.node } }],
          }
        : { kind: "goto", node: destination.node, pause: false, clear: false };
    advance(s, content, rng, first, [], destination.name);
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
