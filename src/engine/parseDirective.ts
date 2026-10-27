import { parseExpression } from "./parseExpression";
import { describe, ParseError, tokenize, TokenStream } from "./tokenize";
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
    | { kind: "push"; node: string; continuous: boolean }
    | { kind: "endpush" }
    | { kind: "do"; effect: Effect }
    | { kind: "output"; expr: Expr };

export const DIRECTIVE_WORDS = new Set(["if", "else", "endif", "switch", "case", "default", "endswitch", "push", "endpush", "do"]);
export const EFFECT_WORDS = new Set(["goto", "return", "use_item", "give_item", "take_item", "reset_charges", "open_map", "open_shop", "push"]);

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
            const { node, continuous } = parseTarget(stream, "a node name after 'push'");
            return { kind: "push", node, continuous };
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
                const { node, continuous } = parseTarget(stream, "a node name after 'goto'");
                return { kind: "goto", node, continuous };
            }
            case "return":
                return { kind: "return" };
            case "use_item":
                return { kind: "use_item", binding: expectName(stream, "a binding name after 'use_item'") };
            case "give_item":
            case "take_item": {
                const kind = word.text;
                const item = expectName(stream, `an item name after '${kind}'`);
                if (stream.check("eof")) return { kind, item };
                return { kind, item, count: parseExpression(stream) };
            }
            case "reset_charges":
                return { kind: "reset_charges", group: expectName(stream, "a group name after 'reset_charges'") };
            case "open_map":
                return { kind: "open_map", map: expectName(stream, "a map name after 'open_map'") };
            case "open_shop":
                return { kind: "open_shop", shop: expectName(stream, "a shop name after 'open_shop'") };
            case "push":
                throw new ParseError(
                    "'push' has a body, so it's written as {push node} ... {endpush}, not inside {do}",
                    word.position,
                );
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

function parseTarget(stream: TokenStream, description: string): { node: string; continuous: boolean } {
    const node = expectName(stream, description);
    const continuous = stream.match("name", "continuous");
    return { node, continuous };
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