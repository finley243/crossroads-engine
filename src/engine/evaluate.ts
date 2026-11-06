import { RuntimeError } from "./errors";
import { DIRECTIVE_MARK } from "./parseProse";
import type { Content, Effect, Expr, GameState, Prose, Rng, Transition, Value } from "./types";

export interface EvalContext {
    content: Content;
    state: GameState;
    rng: Rng;
}

export function evaluateProse(prose: Prose, context: EvalContext): { text: string; transition?: Transition } {
    const out: string[] = [];
    let transition: Transition | undefined;
    const run = (parts: Prose): void => {
        for (const part of parts) {
            switch (part.kind) {
                case "text":
                    out.push(part.text);
                    break;
                case "value":
                    out.push(String(evaluate(part.expr, context)));
                    break;
                case "switch":
                    for (const branch of part.branches) {
                        if (branch.cond === null || condition(branch.cond, context)) {
                            run(branch.body);
                            break;
                        }
                    }
                    break;
                case "do": {
                    const t = applyEffect(part.effect, context);
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
    run(prose);
    return transition ? { text: out.join(""), transition } : { text: out.join("") };
}

export function finishText(text: string): string {
    return text
        .replace(new RegExp(`^[ \\t]*(?:${DIRECTIVE_MARK}[ \\t]*)+(?:\\n|$)`, "gm"), "")
        .replaceAll(DIRECTIVE_MARK, "")
        .replace(/\s+$/, "");
}

export function condition(expr: Expr, context: EvalContext): boolean {
    const result = evaluate(expr, context);
    if (typeof result !== "boolean") throw new RuntimeError(`A condition produced ${JSON.stringify(result)}, not true or false`);
    return result;
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
            return expr.op === "+" ? left + right : expr.op === "-" ? left - right : left * right;
        }
        case "random": {
            const min = int(evaluate(expr.min, context));
            const max = int(evaluate(expr.max, context));
            return min + Math.floor(context.rng() * (max - min + 1));
        }
        case "chance":
            return context.rng() * 100 < int(evaluate(expr.percent, context));
        case "function_ref":
            throw new RuntimeError(`The function '${expr.name}' was never resolved; this is an engine bug`);
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

/** Evaluates an expression that has to give a whole number, such as the chance of a roll. */
export function evaluateInt(expr: Expr, context: EvalContext): number {
    return int(evaluate(expr, context));
}

function bool(value: Value): boolean {
    if (typeof value !== "boolean") throw new RuntimeError(`Expected true or false, got ${JSON.stringify(value)}`);
    return value;
}

function int(value: Value): number {
    if (typeof value !== "number") throw new RuntimeError(`Expected a number, got ${JSON.stringify(value)}`);
    return value;
}

export function applyEffect(effect: Effect, context: EvalContext): Transition | undefined {
    const { state } = context;
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
        case "goto":
            return { kind: "goto", node: effect.node, pause: effect.pause ?? false, clear: effect.clear ?? false };
        case "push": {
            const t: Transition = { kind: "push", node: effect.node, pause: effect.pause ?? false };
            if (effect.onReturn) t.onReturn = effect.onReturn;
            return t;
        }
        case "return":
            return { kind: "return", pause: effect.pause ?? false };
        case "open_map":
            return { kind: "open_map", map: effect.map, cancelable: effect.cancelable };
    }
}
