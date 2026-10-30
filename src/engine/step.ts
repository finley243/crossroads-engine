import { RuntimeError } from "./errors";
import { condition, evaluateProse, finishText, type EvalContext } from "./evaluate";
import { travelLocations } from "./mapLocations";
import { resolvePresentation } from "./presentation";
import type { AvailableOption, Bindings, Content, Difficulty, GameState, HistoryEntry, OptionView, Rng, SceneView, Transition } from "./types";

export const DIFFICULTY_CHANCES: Record<Difficulty, number> = {
    likely: 75,
    even: 50,
    unlikely: 25
}

export const SCENE_BREAK = "\uE002";
export const CONTINUE_LABEL = "Continue";
const MAX_TRANSITIONS_PER_STEP = 50;

export function newGame(content: Content, startNode: string, rng: Rng, contentVersion = 1): GameState {
    const state: GameState = {
        contentVersion,
        vars: {},
        node: startNode,
        stack: [],
        inventory: {},
        screen: { kind: "node" },
        history: [],
        options: []
    };
    const pieces: string[] = [];
    const entered = enterNode(state, content, startNode, rng);
    pieces.push(entered.text);
    advance(state, content, rng, entered.transition, pieces, undefined);
    return state;
}

export function step(content: Content, state: GameState, optionIndex: number, rng: Rng): GameState {
    if (state.screen.kind !== "node") throw new RuntimeError(`Options can't be chosen while a ${state.screen.kind} is open`);
    const s = structuredClone(state);
    if (s.pending) {
        if (optionIndex !== 0) throw new RuntimeError("Only 'Continue' is available here");
        const transition = s.pending;
        delete s.pending;
        advance(s, content, rng, transition, [], CONTINUE_LABEL);
        return s;
    }
    const available = s.options.find(o => o.index === optionIndex);
    const option = content.nodes[s.node]?.options[optionIndex];
    if (!available || !option) throw new RuntimeError(`Option ${optionIndex} isn't available in '${s.node}'`);
    const ctx: EvalContext = { content, state: s, bindings: available.bindings, rng };
    const prose =
        option.result.kind === "plain"
            ? option.result.text
            : rng() * 100 < DIFFICULTY_CHANCES[option.result.difficulty]
              ? option.result.success
              : option.result.failure;
    const result = evaluateProse(prose, ctx);
    advance(s, content, rng, result.transition, [result.text], available.label);
    return s;
}

export function refreshOptions(content: Content, state: GameState, rng: Rng): GameState {
    const s = structuredClone(state);
    s.options = s.pending ? [] : computeOptions(s, content, rng);
    return s;
}

export function sceneView(content: Content, state: GameState, rng: Rng): SceneView {
    const latestEntry = state.history[state.history.length - 1];
    if (!latestEntry) throw new RuntimeError("The game has no history yet");
    const options: OptionView[] = state.pending
        ? [{ index: 0, label: CONTINUE_LABEL }]
        : state.options.map(o => ({ index: o.index, label: o.label }));
    return { latestEntry, options, presentation: resolvePresentation(content, state, rng) };
}

export function advance(s: GameState, content: Content, rng: Rng, first: Transition | undefined, pieces: string[], label: string | undefined): void {
    let transition = first;
    let count = 0;
    while (transition) {
        if (++count > MAX_TRANSITIONS_PER_STEP) {
            throw new RuntimeError(`More than ${MAX_TRANSITIONS_PER_STEP} transitions in one step; is there a loop?`);
        }
        if ((transition.kind === "goto" || transition.kind === "push") && transition.pause
            && pieces.some(p => finishText(p) !== "")) {
            s.pending = { ...transition, pause: false };
            break;
        }
        const next = carryOut(s, content, rng, transition);
        pieces.push(next.text);
        transition = next.transition;
    }
    record(s, pieces, label);
    s.options = s.pending ? [] : computeOptions(s, content, rng);
}

function carryOut(s: GameState, content: Content, rng: Rng, t: Transition): { text: string; transition?: Transition } {
    switch (t.kind) {
        case "goto":
            return enterNode(s, content, t.node, rng);
        case "push": {
            const frame: GameState["stack"][number] = { node: s.node, bindings: t.bindings };
            if (t.onReturn) frame.onReturn = t.onReturn;
            s.stack.push(frame);
            return enterNode(s, content, t.node, rng);
        }
        case "return": {
            const frame = s.stack.pop();
            if (!frame) throw new RuntimeError(`'return' in '${s.node}', but there's no node to return to`);
            s.node = frame.node;
            s.screen = { kind: "node" };
            // The node's own text isn't shown again; only the push's return text, if any.
            if (!frame.onReturn) return { text: "" };
            return evaluateProse(frame.onReturn, { content, state: s, bindings: frame.bindings, rng });
        }
        case "open_map": {
            const map = content.maps[t.map];
            if (!map) throw new RuntimeError(`Unknown map '${t.map}'`);
            s.screen = { kind: "map", map: t.map, cancelable: t.cancelable };
            // A map that can't be canceled has to have somewhere to go, or the player would be stuck on it.
            if (!t.cancelable && travelLocations(content, s, map, rng).length === 0) {
                throw new RuntimeError(`The map '${t.map}' was opened with nocancel, but there's nowhere to travel to`);
            }
            return { text: "" };
        }
        case "open_shop":
            s.screen = { kind: "shop", shop: t.shop };
            return { text: "" };
    }
}

function enterNode(s: GameState, content: Content, nodeId: string, rng: Rng): { text: string; transition?: Transition } {
    const node = content.nodes[nodeId];
    if (!node) throw new RuntimeError(`Unknown node '${nodeId}'`);
    s.node = nodeId;
    s.screen = { kind: "node" };
    return evaluateProse(node.text, { content, state: s, bindings: {}, rng });
}

function record(s: GameState, pieces: string[], label: string | undefined): void {
    const text = pieces
        .map(finishText)
        .filter(p => p !== "")
        .join(`\n\n${SCENE_BREAK}\n\n`);
    const entry: HistoryEntry = { node: s.node, text };
    if (label !== undefined) entry.option = label;
    s.history.push(entry);
}

function computeOptions(s: GameState, content: Content, rng: Rng): AvailableOption[] {
    const node = content.nodes[s.node];
    if (!node) return [];
    const result: AvailableOption[] = [];
    for (const option of node.options) {
        const ctx: EvalContext = { content, state: s, bindings: {}, rng };
        const bindings: Bindings | null = option.requires ? condition(option.requires, ctx) : {};
        if (!bindings) continue;
        const label = finishText(evaluateProse(option.label, { ...ctx, bindings }).text);
        result.push({ index: option.index, label, bindings });
    }
    return result;
}
