import { RuntimeError } from "./errors";
import { clampChance } from "./chances";
import { condition, evaluate, evaluateInt, evaluateProse, finishText, type EvalContext } from "./evaluate";
import { travelLocations } from "./mapLocations";
import { resolvePresentation } from "./presentation";
import type { AvailableOption, Content, GameState, HistoryEntry, OptionView, Rng, RollView, SceneView, Transition } from "./types";

export const SCENE_BREAK = "\uE002";
export const CONTINUE_LABEL = "Continue";
export const ACCEPT_LABEL = "Accept";
export const ROLL_ACCEPT = 0; // the option indexes while a roll is waiting
export const ROLL_REROLL = 1;
const MAX_TRANSITIONS_PER_STEP = 50;

export function newGame(content: Content, startNode: string, rng: Rng, contentVersion = 1): GameState {
    const state: GameState = {
        contentVersion,
        vars: {},
        node: startNode,
        stack: [],
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
    if (s.pendingRoll) {
        stepPendingRoll(s, content, optionIndex, rng);
        return s;
    }
    const available = s.options.find(o => o.index === optionIndex);
    const option = content.nodes[s.node]?.options[optionIndex];
    if (!available || !option) throw new RuntimeError(`Option ${optionIndex} isn't available in '${s.node}'`);
    const ctx: EvalContext = { content, state: s, rng };
    let prose = option.result.kind === "plain" ? option.result.text : undefined;
    if (option.result.kind === "roll") {
        const chance = clampChance(evaluateInt(option.result.chance, ctx));
        const success = rng() * 100 < chance;
        // The outcome isn't applied until the roll has been shown and accepted, so that the player sees how it went,
        // and can re-roll a failure if they're able to.
        s.pendingRoll = { option: optionIndex, label: available.label, chance, success, attempt: 1 };
        s.options = [];
        return s;
    }
    const result = evaluateProse(prose!, ctx);
    advance(s, content, rng, result.transition, [result.text], available.label);
    return s;
}

// Re-rolls are on when the content declares a whole-number variable called 'rerolls'.
function rerollsEnabled(content: Content): boolean {
    return content.vars["rerolls"]?.type.kind === "int";
}

// Whether the roll that's waiting can be re-rolled: it failed, the option allows it, and there's a re-roll to spend.
function canReroll(content: Content, s: GameState): boolean {
    const roll = s.pendingRoll;
    if (!roll || roll.success || rerollsLeft(content, s) <= 0) return false;
    const result = content.nodes[s.node]?.options[roll.option]?.result;
    return result?.kind === "roll" && !result.noReroll;
}

function rerollsLeft(content: Content, s: GameState): number {
    if (!rerollsEnabled(content)) return 0;
    const value = evaluate({ kind: "var", name: "rerolls" }, { content, state: s, rng: Math.random });
    return typeof value === "number" ? value : 0;
}

function stepPendingRoll(s: GameState, content: Content, optionIndex: number, rng: Rng): void {
    const roll = s.pendingRoll!;
    if (optionIndex === ROLL_REROLL) {
        if (!canReroll(content, s)) throw new RuntimeError("There's no re-roll to spend here");
        s.vars["rerolls"] = rerollsLeft(content, s) - 1;
        s.pendingRoll = { ...roll, success: rng() * 100 < roll.chance, attempt: roll.attempt + 1 };
        return;
    }
    if (optionIndex !== ROLL_ACCEPT) throw new RuntimeError("Only 'Accept' and 'Re-roll' are available while a roll is waiting");
    const option = content.nodes[s.node]?.options[roll.option];
    if (option?.result.kind !== "roll") throw new RuntimeError(`The roll that was waiting isn't an option of '${s.node}'`);
    delete s.pendingRoll;
    const result = evaluateProse(roll.success ? option.result.success : option.result.failure, { content, state: s, rng });
    advance(s, content, rng, result.transition, [result.text], roll.label);
}

export function refreshOptions(content: Content, state: GameState, rng: Rng): GameState {
    const s = structuredClone(state);
    s.options = s.pending || s.pendingRoll ? [] : computeOptions(s, content, rng);
    return s;
}

export function sceneView(content: Content, state: GameState, rng: Rng): SceneView {
    const latestEntry = state.history[state.history.length - 1];
    if (!latestEntry) throw new RuntimeError("The game has no history yet");
    const presentation = resolvePresentation(content, state, rng);
    if (state.pendingRoll) {
        const { chance, success, attempt } = state.pendingRoll;
        const left = rerollsLeft(content, state);
        const rerollable = canReroll(content, state);
        const options: OptionView[] = rerollable
            ? [{ index: ROLL_REROLL, label: `Re-roll (${left} left)` }, { index: ROLL_ACCEPT, label: ACCEPT_LABEL }]
            : [{ index: ROLL_ACCEPT, label: ACCEPT_LABEL }];
        const roll: RollView = { chance, success, attempt, rerollsLeft: left, canReroll: rerollable };
        return { latestEntry, options, presentation, roll };
    }
    const options: OptionView[] = state.pending
        ? [{ index: 0, label: CONTINUE_LABEL }]
        : state.options.map(o => ({ index: o.index, label: o.label }));
    return { latestEntry, options, presentation };
}

export function advance(s: GameState, content: Content, rng: Rng, first: Transition | undefined, pieces: string[], label: string | undefined): void {
    let transition = first;
    let count = 0;
    while (transition) {
        if (++count > MAX_TRANSITIONS_PER_STEP) {
            throw new RuntimeError(`More than ${MAX_TRANSITIONS_PER_STEP} transitions in one step; is there a loop?`);
        }
        if (transition.kind === "open_map") checkMapCanBeLeft(s, content, rng, transition);
        if (transition.kind === "return" && s.stack.length === 0) {
            throw new RuntimeError(`'return' in '${s.node}', but there's no node to return to`); // before asking the player to continue
        }
        if (pausesBeforeRunning(transition) && pieces.some(p => finishText(p) !== "")) {
            s.pending = transition.kind === "goto" || transition.kind === "push" || transition.kind === "return"
                ? { ...transition, pause: false }
                : transition;
            break;
        }
        const next = carryOut(s, content, rng, transition);
        pieces.push(next.text);
        transition = next.transition;
    }
    record(s, pieces, label);
    s.options = s.pending ? [] : computeOptions(s, content, rng);
}

// Any text before a transition is shown first with a Continue button if the author asked for a pause, and always
// before a map, since those cover the text the moment they open.
function pausesBeforeRunning(t: Transition): boolean {
    switch (t.kind) {
        case "goto":
        case "push":
            return t.pause;
        case "open_map":
            return true;
        case "return":
            return t.pause;
    }
}

// A map that can't be canceled has to have somewhere to go, or the player would be stuck on it.
function checkMapCanBeLeft(s: GameState, content: Content, rng: Rng, t: { map: string; cancelable: boolean }): void {
    const map = content.maps[t.map];
    if (!map) throw new RuntimeError(`Unknown map '${t.map}'`);
    if (!t.cancelable && travelLocations(content, s, map, rng).length === 0) {
        throw new RuntimeError(`The map '${t.map}' was opened with nocancel, but there's nowhere to travel to`);
    }
}

function carryOut(s: GameState, content: Content, rng: Rng, t: Transition): { text: string; transition?: Transition } {
    switch (t.kind) {
        case "goto":
            if (t.clear) s.stack = []; // whatever was pushed is abandoned, without running its return text
            return enterNode(s, content, t.node, rng);
        case "push": {
            const frame: GameState["stack"][number] = { node: s.node };
            if (t.onReturn) frame.onReturn = t.onReturn;
            if (t.trip) frame.trip = true;
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
            return evaluateProse(frame.onReturn, { content, state: s, rng });
        }
        case "open_map":
            s.screen = { kind: "map", map: t.map, cancelable: t.cancelable };
            return { text: "" };
    }
}

function enterNode(s: GameState, content: Content, nodeId: string, rng: Rng): { text: string; transition?: Transition } {
    const node = content.nodes[nodeId];
    if (!node) throw new RuntimeError(`Unknown node '${nodeId}'`);
    s.node = nodeId;
    s.screen = { kind: "node" };
    return evaluateProse(node.text, { content, state: s, rng });
}

function record(s: GameState, pieces: string[], label: string | undefined): void {
    const text = pieces
        .map(finishText)
        .filter(p => p !== "")
        .join(`\n\n${SCENE_BREAK}\n\n`);
    // Continuing on to a map adds nothing to read, so it isn't worth an entry of its own.
    if (text === "" && label === CONTINUE_LABEL && s.screen.kind !== "node") return;
    const entry: HistoryEntry = { node: s.node, text };
    if (label !== undefined) entry.option = label;
    s.history.push(entry);
}

function computeOptions(s: GameState, content: Content, rng: Rng): AvailableOption[] {
    const node = content.nodes[s.node];
    if (!node) return [];
    const result: AvailableOption[] = [];
    for (const option of node.options) {
        const ctx: EvalContext = { content, state: s, rng };
        if (option.requires && !condition(option.requires, ctx)) continue;
        const label = finishText(evaluateProse(option.label, ctx).text);
        result.push({ index: option.index, label });
    }
    return result;
}
