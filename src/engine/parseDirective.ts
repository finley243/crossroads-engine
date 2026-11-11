import { ParseError } from "./errors";
import { parseExpression } from "./parseExpression";
import { describe, tokenize, TokenStream } from "./tokenize";
import type { Effect, Expr } from "./types";

export type Directive =
    | { kind: "if"; cond: Expr }
    | { kind: "elseif"; cond: Expr }
    | { kind: "else" }
    | { kind: "endif" }
    | { kind: "switch" }
    | { kind: "case"; cond: Expr }
    | { kind: "default" }
    | { kind: "endswitch" }
    | { kind: "push"; node: string; pause: boolean }
    | { kind: "endpush" }
    | { kind: "do"; effect: Effect }
    | { kind: "output"; expr: Expr };

export const DIRECTIVE_WORDS = new Set(["if", "elseif", "else", "endif", "switch", "case", "default", "endswitch", "push", "endpush", "do"]);
export const EFFECT_WORDS = new Set(["goto", "return", "open_map", "push", "game_over"]);

type AssignOp = "=" | "+=" | "-=";
const ASSIGN_OPS = new Set(["=", "+=", "-="]);

export function parseDirective(src: string): Directive {
    const stream = new TokenStream(tokenize(src));
    const first = stream.peek();
    if (first.kind === "eof") {
        throw new ParseError("Empty directive", first.position);
    }
    if (first.kind === "name" && EFFECT_WORDS.has(first.text) && !DIRECTIVE_WORDS.has(first.text)) {
        throw new ParseError(`Effects are written with 'do', like {do ${first.text} ...}`, first.position);
    }
    const directive = parseKeywordDirective(stream) ?? { kind: "output", expr: parseExpression(stream) };
    stream.expect("eof", "the end of the directive");
    return directive;
}

function parseKeywordDirective(stream: TokenStream): Directive | undefined {
    const first = stream.peek();
    if (first.kind !== "name" || !DIRECTIVE_WORDS.has(first.text)) return undefined;
    stream.next();
    switch (first.text) {
        case "if":
            return { kind: "if", cond: parseExpression(stream) };
        case "elseif":
            return { kind: "elseif", cond: parseExpression(stream) };
        case "case":
            return { kind: "case", cond: parseExpression(stream) };
        case "else":
            return { kind: "else" };
        case "endif":
            return { kind: "endif" };
        case "switch":
            return { kind: "switch" };
        case "default":
            return { kind: "default" };
        case "endswitch":
            return { kind: "endswitch" };
        case "endpush":
            return { kind: "endpush" };
        case "push": {
            const { node, pause } = parseTarget(stream, "a node name after 'push'", false);
            return { kind: "push", node, pause };
        }
        case "do":
            return { kind: "do", effect: parseEffect(stream) };
    }
    return undefined;
}

function parseEffect(stream: TokenStream): Effect {
    const word = stream.peek();
    if (word.kind === "name" && EFFECT_WORDS.has(word.text)) {
        stream.next();
        switch (word.text) {
            case "goto": {
                const { node, pause, clear } = parseTarget(stream, "a node name after 'goto'", true);
                return { kind: "goto", node, pause, clear };
            }
            case "return":
                return { kind: "return", pause: stream.match("name", "pause") };
            case "open_map": {
                const map = expectName(stream, "a map name after 'open_map'");
                return { kind: "open_map", map, cancelable: !stream.match("name", "nocancel") };
            }
            case "game_over":
                return { kind: "game_over" };
            case "push": {
                const { node, pause } = parseTarget(stream, "a node name after 'push'", false);
                return { kind: "push", node, pause };
            }
        }
    }
    return parseAssignment(stream);
}

function parseAssignment(stream: TokenStream): Effect {
    const target = parseQualifiedName(stream, "a variable name or an effect after 'do'");
    const op = stream.peek();
    if (op.kind !== "operator" || !ASSIGN_OPS.has(op.text)) {
        throw new ParseError(
            `Expected '=', '+=', or '-=' after '${target}' but found ${describe(op)}`,
            op.position,
        );
    }
    stream.next();
    return { kind: "assign", op: op.text as AssignOp, target, value: parseExpression(stream) };
}

// A node name, then the optional words that change how the transition happens, in either order.
function parseTarget(stream: TokenStream, description: string, allowClear: boolean): { node: string; pause: boolean; clear: boolean } {
    const node = expectName(stream, description);
    let pause = false;
    let clear = false;
    for (;;) {
        const next = stream.peek();
        if (!pause && stream.match("name", "pause")) {
            pause = true;
        } else if (!clear && next.kind === "name" && next.text === "clear") {
            if (!allowClear) throw new ParseError("'clear' can only be used with goto", next.position);
            stream.next();
            clear = true;
        } else {
            return { node, pause, clear };
        }
    }
}

function expectName(stream: TokenStream, description: string): string {
    return stream.expect("name", description).text;
}

function parseQualifiedName(stream: TokenStream, description: string): string {
    let name = expectName(stream, description);
    while (stream.match("dot")) {
        name += "." + expectName(stream, "a name after '.'");
    }
    return name;
}