import { RuntimeError } from "./errors";
import { DIRECTIVE_MARK } from "./parseProse";
import type { Bindings, Content, Effect, Expr, GameState, ItemDef, ItemInstance, ItemState, Prose, Rng, TagExpr, Transition, Value } from "./types";

export interface EvalContext {
    content: Content;
    state: GameState;
    bindings: Bindings;
    rng: Rng;
}

export function evaluateProse(prose: Prose, context: EvalContext): { text: string; transition?: Transition } {
    const out: string[] = [];
    let transition: Transition | undefined;
    const run = (parts: Prose, bindings: Bindings): void => {
        for (const part of parts) {
            switch (part.kind) {
                case "text":
                    out.push(part.text);
                    break;
                case "value":
                    out.push(String(evaluate(part.expr, { ...context, bindings })));
                    break;
                case "item_text": {
                    const def = boundItem(part.binding, { ...context, bindings }).def;
                    out.push(part.field === "name" ? def.name : def.short);
                    break;
                }
                case "switch":
                    for (const branch of part.branches) {
                        const branchBindings = branch.cond === null ? bindings : condition(branch.cond, { ...context, bindings });
                        if (branchBindings) {
                            run(branch.body, branchBindings);
                            break;
                        }
                    }
                    break;
                case "do": {
                    const t = applyEffect(part.effect, { ...context, bindings });
                    if (t) {
                        if (transition) {
                            throw new RuntimeError(`Two transitions in one passage (${transition.kind}, then ${t.kind})`);
                        }
                        transition = t;
                    }
                    break;
                }
            }
        }
    }
    run(prose, context.bindings);
    return transition ? { text: out.join(""), transition } : { text: out.join("") };
}

export function finishText(text: string): string {
    return text
        .replace(new RegExp(`^[ \\t]*(?:${DIRECTIVE_MARK}[ \\t]*)+(?:\\n|$)`, "gm"), "")
        .replaceAll(DIRECTIVE_MARK, "")
        .replace(/\s+$/, "");
}

export function condition(expr: Expr, context: EvalContext): Bindings | null {
    const bindings: Bindings = { ...context.bindings };
    const result = evaluate(expr, { ...context, bindings });
    if (typeof result !== "boolean") throw new RuntimeError(`A condition produced ${JSON.stringify(result)}, not true or false`);
    return result ? bindings : null;
}

export function evaluate(expr: Expr, context: EvalContext): Value {
    switch (expr.kind) {
        case "literal":
            return expr.value;
        case "var":
            return readVar(expr.name, context);
        case "not":
            return !bool(evaluate(expr.operand, context));
        case "and":
            return bool(evaluate(expr.left, context)) && bool(evaluate(expr.right, context));
        case "or":
            return bool(evaluate(expr.left, context)) || bool(evaluate(expr.right, context));
        case "compare":
            return compare(expr.op, evaluate(expr.left, context), evaluate(expr.right, context));
        case "arith": {
            const left = int(evaluate(expr.left, context));
            const right = int(evaluate(expr.right, context));
            return expr.op === "+" ? left + right : left - right;
        }
        case "item": {
            const found = findItem(expr.tags, expr.state, context);
            if (found && expr.bind !== undefined) context.bindings[expr.bind] = found.id;
            return found !== undefined;
        }
        case "item_count":
            return inventory(context)
                .filter(({ instance, def }) => matchesTags(expr.tags, def) && inState(instance, def, expr.state ?? "owned"))
                .reduce((sum, { instance }) => sum + instance.count, 0);
        case "item_prop":
            return itemProp(expr.binding, expr.prop, context);
        case "random": {
            const min = int(evaluate(expr.min, context));
            const max = int(evaluate(expr.max, context));
            return min + Math.floor(context.rng() * (max - min + 1));
        }
        case "chance":
            return context.rng() * 100 < int(evaluate(expr.percent, context));
    }
}

function itemProp(binding: string, prop: Extract<Expr, { kind: "item_prop" }>["prop"], context: EvalContext): Value {
    const { instance, def } = boundItem(binding, context);
    switch (prop) {
        case "uses":
            return def.charges ? (instance.charges ?? 0) : 0;
        case "has_uses":
            return def.charges !== undefined;
        case "count":
            return instance.count;
    }
}

function readVar(name: string, context: EvalContext): Value {
    const value = context.state.vars[name];
    if (value !== undefined) return value;
    const decl = context.content.vars[name];
    if (decl) return decl.default;
    return false;
}

function compare(op: Extract<Expr, { kind: "compare" }>["op"], left: Value, right: Value): boolean {
    switch (op) {
        case "==":
            return left === right;
        case "!=":
            return left !== right;
        case "<":
            return int(left) < int(right);
        case "<=":
            return int(left) <= int(right);
        case ">":
            return int(left) > int(right);
        case ">=":
            return int(left) >= int(right);
    }
}

function bool(value: Value): boolean {
    if (typeof value !== "boolean") throw new RuntimeError(`Expected true or false, got ${JSON.stringify(value)}`);
    return value;
}

function int(value: Value): number {
    if (typeof value !== "number") throw new RuntimeError(`Expected a number, got ${JSON.stringify(value)}`);
    return value;
}

interface OwnedItem {
    instance: ItemInstance;
    def: ItemDef;
}

function inventory(context: EvalContext): OwnedItem[] {
    const result: OwnedItem[] = [];
    for (const instance of Object.values(context.state.inventory)) {
        const def = context.content.items[instance.id];
        if (def && instance.count > 0) result.push({ instance, def });
    }
    return result;
}

function inState(instance: ItemInstance, def: ItemDef, state: ItemState): boolean {
    if (instance.count <= 0) return false;
    const usable = !instance.disabled && (def.charges === undefined || (instance.charges ?? 0) > 0);
    switch (state) {
        case "owned":
            return true;
        case "usable":
            return usable;
        case "blocked":
            return !usable;
    }
}

function matchesTags(tags: TagExpr, def: ItemDef): boolean {
    switch (tags.kind) {
        case "tag":
            return def.tags.includes(tags.name);
        case "not":
            return !matchesTags(tags.operand, def);
        case "and":
            return matchesTags(tags.left, def) && matchesTags(tags.right, def);
        case "or":
            return matchesTags(tags.left, def) || matchesTags(tags.right, def);
    }
}

function findItem(tags: TagExpr, state: ItemState, context: EvalContext): ItemInstance | undefined {
    const matches = inventory(context).filter(({ instance, def }) => matchesTags(tags, def) && inState(instance, def, state));
    const isConsumable = (def: ItemDef) => def.kind === "carried" && def.consumable === true;
    return (matches.find(m => !isConsumable(m.def)) ?? matches[0])?.instance;
}

function boundItem(binding: string, context: EvalContext): OwnedItem {
    const id = context.bindings[binding];
    const instance = id === undefined ? undefined : context.state.inventory[id];
    const def = id === undefined ? undefined : context.content.items[id];
    if (!instance || !def) throw new RuntimeError(`'${binding}' isn't bound to an item the player has`);
    return { instance, def };
}

export function applyEffect(effect: Effect, context: EvalContext): Transition | undefined {
    const { state, content } = context;
    switch (effect.kind) {
        case "assign": {
            const value = evaluate(effect.value, context);
            if (effect.op === "=") {
                state.vars[effect.target] = value;
            } else {
                const current = int(readVar(effect.target, context));
                state.vars[effect.target] = effect.op === "+=" ? current + int(value) : current - int(value);
            }
            return undefined;
        }
        case "use_item": {
            const { instance, def } = boundItem(effect.binding, context);
            if (def.charges !== undefined) {
                instance.charges = Math.max(0, (instance.charges ?? 0) - 1);
            } else if (def.kind === "carried" && def.consumable) {
                removeItems(instance.id, 1, context);
            }
            return undefined;
        }
        case "give_item": {
            const count = effect.count === undefined ? 1 : int(evaluate(effect.count, context));
            const existing = state.inventory[effect.item];
            if (existing) {
                existing.count += count;
            } else {
                const def = content.items[effect.item];
                const instance: ItemInstance = { id: effect.item, count };
                if (def?.charges) instance.charges = def.charges.max;
                state.inventory[effect.item] = instance;
            }
            return undefined;
        }
        case "take_item": {
            const count = effect.count === undefined ? 1 : int(evaluate(effect.count, context));
            removeItems(effect.item, count, context);
            return undefined;
        }
        case "reset_charges":
            for (const instance of Object.values(state.inventory)) {
                const charges = content.items[instance.id]?.charges;
                if (charges?.reset === effect.group) instance.charges = charges.max;
            }
            return undefined;
        case "goto":
            return { kind: "goto", node: effect.node, pause: effect.pause ?? false };
        case "push": {
            const t: Transition = { kind: "push", node: effect.node, pause: effect.pause ?? false, bindings: { ...context.bindings } };
            if (effect.onReturn) t.onReturn = effect.onReturn;
            return t;
        }
        case "return":
            return { kind: "return" };
        case "open_map":
            return { kind: "open_map", map: effect.map };
        case "open_shop":
            return { kind: "open_shop", shop: effect.shop };
    }
}

function removeItems(id: string, count: number, context: EvalContext): void {
    const instance = context.state.inventory[id];
    const have = instance?.count ?? 0;
    if (!instance || have < count) {
        throw new RuntimeError(`Tried to take ${count} of '${id}', but the player only has ${have}`);
    }
    instance.count -= count;
    if (instance.count === 0) delete context.state.inventory[id];
}