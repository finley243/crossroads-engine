import { evaluateProse } from "./evaluate";
import { refreshOptions } from "./step";
import type { Content, GameState, HistoryEntry, PendingRoll, Prose, Rng, SaveData, Screen, StackFrame, Transition, Value, VarDecl } from "./types";

/** The layout of a save file. A change that older engines couldn't read bumps it. */
export const SAVE_FORMAT = 1;

/** A save keeps no more than this many scenes of history, the latest ones, so that a long game's saves stay a reasonable size. */
export const MAX_SAVED_HISTORY = 5000;

/** What a list of saves shows about each one, without having to read all of it. */
export interface SaveHeader {
    format: number;
    game?: string; // the game's version when it was saved
    savedAt: string; // an ISO date and time
    summary: { node: string; text: string }; // where the player was, and how that scene began
}

export interface SaveFile extends SaveHeader {
    data: SaveData;
}

/** A save that can't be read at all. The message is for the player. */
export class SaveError extends Error {}

export function writeSave(content: Content, state: GameState, savedAt: Date = new Date()): string {
    const { options: _options, ...data } = state;
    const latest = state.history[state.history.length - 1];
    const header: SaveHeader = {
        format: SAVE_FORMAT,
        savedAt: savedAt.toISOString(),
        summary: { node: state.node, text: snippet(latest?.text ?? "") },
    };
    if (content.game?.version) header.game = content.game.version;
    if (data.history.length > MAX_SAVED_HISTORY) data.history = data.history.slice(-MAX_SAVED_HISTORY);
    const file: SaveFile = { ...header, data };
    return JSON.stringify(file);
}

function snippet(text: string): string {
    const plain = text.replace(/[*_]+/g, "").replace(/\s+/g, " ").trim();
    return plain.length > 140 ? `${plain.slice(0, 139).trimEnd()}…` : plain;
}

/** Reads a save file's text, checking that it's built the way a save is. It says nothing about whether it fits the game. */
export function readSave(text: string): SaveFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new SaveError("This isn't a save file; it can't be read as one.");
    }
    if (!isObject(parsed)) throw new SaveError("This isn't a save file; it can't be read as one.");
    if (typeof parsed.format !== "number") throw new SaveError("This isn't a save file; it doesn't say which kind it is.");
    if (parsed.format > SAVE_FORMAT) throw new SaveError("This save was made by a newer version of the game, which this one can't read.");
    if (parsed.format < SAVE_FORMAT) throw new SaveError("This save is from an older kind than this version of the game can read.");
    const data = parsed.data;
    if (!isObject(data) || !isObject(data.vars) || typeof data.node !== "string" || !Array.isArray(data.stack) || !Array.isArray(data.history) || !isObject(data.screen)) {
        throw new SaveError("This save is damaged: parts of it are missing.");
    }
    if (typeof parsed.savedAt !== "string" || !isObject(parsed.summary)) throw new SaveError("This save is damaged: parts of it are missing.");
    return parsed as unknown as SaveFile;
}

/** The header of a save, or nothing if the text isn't a readable save. For lists of saves. */
export function readHeader(text: string): SaveHeader | undefined {
    try {
        const { data: _data, ...header } = readSave(text);
        return header;
    } catch {
        return undefined;
    }
}

function parseVersion(version: string | undefined): [number, number, number] | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** When a save is from a different major or minor version of the game, so that it may not fit. A different patch version is fine. */
export function versionMismatch(content: Content, header: SaveHeader): { saved: string; current: string } | undefined {
    const current = parseVersion(content.game?.version);
    const saved = parseVersion(header.game);
    if (!current || !saved) return undefined;
    return current[0] === saved[0] && current[1] === saved[1] ? undefined : { saved: header.game!, current: content.game!.version! };
}

/**
 * Turns a save into a state of the game, fixing what no longer fits the content. A variable that's gone is ignored,
 * one with a value it can't have now goes back to its default, and what points at a node or map that's gone is dropped.
 * If the node itself is gone, the game carries on from the latest scene in the history whose node still exists.
 * `warnings` says what was changed, and a save that can't be made to work throws a SaveError.
 */
export function restoreSave(content: Content, file: SaveFile, rng: Rng): { state: GameState; warnings: string[] } {
    const data = file.data;
    const warnings: string[] = [];

    const vars: Record<string, Value> = {};
    for (const [name, value] of Object.entries(data.vars)) {
        const decl = content.vars[name];
        if (!decl) warnings.push(`'${name}' doesn't exist any more, so its saved value was left out`);
        else if (!fits(decl, value)) warnings.push(`'${name}' had a saved value that it can't have now, so it was set back to ${JSON.stringify(decl.default)}`);
        else vars[name] = value;
    }

    let history = data.history.filter(isHistoryEntry);
    if (history.length < data.history.length) warnings.push(`${data.history.length - history.length} damaged scene(s) were left out of the history`);

    let node = data.node;
    let continued = true; // whether the game carries on from where it was saved, and not from an earlier scene
    if (!content.nodes[node]) {
        const index = history.findLastIndex(entry => content.nodes[entry.node] !== undefined);
        if (index === -1) throw new SaveError(`This save is at '${node}', which doesn't exist any more, and neither does anywhere else it has been.`);
        warnings.push(`'${node}' doesn't exist any more, so the game carries on from '${history[index]!.node}', the latest place in the history that does`);
        node = history[index]!.node;
        history = history.slice(0, index + 1); // so that the scene shown is the one for this node
        continued = false;
    }
    if (history.length === 0) throw new SaveError("This save has no history, so there's no scene to show.");

    const state: GameState = { vars, node, stack: [], screen: { kind: "node" }, history, options: [] };
    if (continued) {
        for (const frame of data.stack) {
            const kept = validFrame(content, state, frame, warnings);
            if (kept) state.stack.push(kept);
        }
        const screen = validScreen(content, data.screen);
        if (screen) state.screen = screen;
        else warnings.push(`The map the game was showing doesn't exist any more, so it carries on without it`);
        if (data.pending !== undefined) {
            if (validTransition(content, state, data.pending)) state.pending = data.pending;
            else warnings.push("What the game was about to do next doesn't fit any more, so it was left out");
        }
        if (data.pendingRoll !== undefined) {
            if (validRoll(content, node, data.pendingRoll)) state.pendingRoll = data.pendingRoll;
            else warnings.push("The roll that was waiting doesn't fit any more, so it was left out");
        }
    } else if (data.stack.length > 0 || data.pending !== undefined || data.pendingRoll !== undefined) {
        warnings.push("What the game was in the middle of couldn't be kept");
    }
    return { state: refreshOptions(content, state, rng), warnings };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fits(decl: VarDecl, value: unknown): boolean {
    switch (decl.type.kind) {
        case "bool": return typeof value === "boolean";
        case "int": return typeof value === "number" && Number.isInteger(value);
        case "enum": return typeof value === "string" && decl.type.values.includes(value);
    }
}

function isHistoryEntry(entry: unknown): entry is HistoryEntry {
    return isObject(entry) && typeof entry.node === "string" && typeof entry.text === "string" && (entry.option === undefined || typeof entry.option === "string");
}

function validScreen(content: Content, screen: unknown): Screen | undefined {
    if (!isObject(screen)) return undefined;
    if (screen.kind === "node") return { kind: "node" };
    if (screen.kind === "game_over") return { kind: "game_over" };
    if (screen.kind === "map" && typeof screen.map === "string" && typeof screen.cancelable === "boolean" && content.maps[screen.map]) {
        return { kind: "map", map: screen.map, cancelable: screen.cancelable };
    }
    return undefined;
}

// Whether everything that saved text points at still exists: the variables it reads or sets, and the nodes and maps it goes to.
// It's part of the content as it was when the game was saved, so it can be out of date.
function refsExist(content: Content, value: unknown): boolean {
    if (Array.isArray(value)) return value.every(item => refsExist(content, item));
    if (!isObject(value)) return true;
    switch (value.kind) {
        case "var":
            if (typeof value.name !== "string" || !content.vars[value.name]) return false;
            break;
        case "assign":
            if (typeof value.target !== "string" || !content.vars[value.target]) return false;
            break;
        case "goto":
        case "push":
            if (typeof value.node !== "string" || !content.nodes[value.node]) return false;
            break;
        case "open_map":
            if (typeof value.map !== "string" || !content.maps[value.map]) return false;
            break;
    }
    return Object.values(value).every(item => refsExist(content, item));
}

// Whether saved text still works with the game as it is now: what it points at exists, and it runs on a copy of the state.
function runs(content: Content, state: GameState, prose: unknown): boolean {
    if (!Array.isArray(prose) || !refsExist(content, prose)) return false;
    try {
        evaluateProse(prose as Prose, { content, state: structuredClone(state), rng: () => 0.5 }); // not the game's dice
        return true;
    } catch {
        return false;
    }
}

function validFrame(content: Content, state: GameState, frame: unknown, warnings: string[]): StackFrame | undefined {
    if (!isObject(frame) || typeof frame.node !== "string" || !content.nodes[frame.node]) {
        warnings.push(`A place the game would have gone back to (${isObject(frame) ? `'${String(frame.node)}'` : "damaged"}) doesn't exist any more, so it was left out`);
        return undefined;
    }
    const kept: StackFrame = { node: frame.node };
    if (frame.trip === true) kept.trip = true;
    if (frame.onReturn !== undefined) {
        if (runs(content, state, frame.onReturn)) kept.onReturn = frame.onReturn as Prose;
        else warnings.push(`What the game would have done on going back to '${frame.node}' doesn't fit any more, so it was left out`);
    }
    return kept;
}

function validTransition(content: Content, state: GameState, transition: unknown): transition is Transition {
    if (!isObject(transition)) return false;
    switch (transition.kind) {
        case "goto":
            return typeof transition.node === "string" && content.nodes[transition.node] !== undefined;
        case "push":
            return typeof transition.node === "string" && content.nodes[transition.node] !== undefined && (transition.onReturn === undefined || runs(content, state, transition.onReturn));
        case "return":
        case "game_over":
            return true;
        case "open_map":
            return typeof transition.map === "string" && content.maps[transition.map] !== undefined;
        default:
            return false;
    }
}

function validRoll(content: Content, node: string, roll: unknown): roll is PendingRoll {
    if (!isObject(roll)) return false;
    const option = typeof roll.option === "number" ? content.nodes[node]?.options[roll.option] : undefined;
    return option?.result.kind === "roll"
        && typeof roll.label === "string"
        && typeof roll.chance === "number" && roll.chance >= 0 && roll.chance <= 100
        && typeof roll.success === "boolean"
        && typeof roll.attempt === "number" && Number.isInteger(roll.attempt) && roll.attempt >= 1;
}
