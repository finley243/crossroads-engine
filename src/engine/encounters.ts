import { condition, type EvalContext } from "./evaluate";
import type { Content, EncounterEntry, GameState, MapDef, MapLocation, Rng } from "./types";

/** The table to roll when traveling to a location: its own if it names one, otherwise the map's, otherwise none. */
export function encounterTableFor(map: MapDef, destination: MapLocation): string | undefined {
    const name = destination.encounters !== undefined ? destination.encounters : map.encounters;
    return name ?? undefined; // null, which is "none", and not naming a table at all both mean no roll
}

/** Roll a table once: one of the entries whose conditions hold, in proportion to their weights, or nothing. */
export function rollEncounter(content: Content, state: GameState, tableId: string, rng: Rng): EncounterEntry | undefined {
    const table = content.encounters[tableId];
    if (!table) return undefined;
    const ctx: EvalContext = { content, state, bindings: {}, rng };
    const eligible = table.entries.filter(entry => !entry.when || condition(entry.when, ctx) !== null);
    const total = table.nothing + eligible.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) return undefined;
    let roll = rng() * total;
    for (const entry of eligible) {
        roll -= entry.weight;
        if (roll < 0) return entry;
    }
    return undefined; // the roll landed in the weight for nothing happening
}
