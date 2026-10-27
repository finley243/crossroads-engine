import { describe, ParseError, type Token, type TokenStream } from "./tokenize";
import type { Expr, ItemState, TagExpr } from "./types";

export function parseExpression(stream: TokenStream): Expr {
    return parseOr(stream);
}

type CompareOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function parseOr(stream: TokenStream): Expr {
    let left = parseAnd(stream);
    while (stream.match("keyword", "or")) {
        left = { kind: "or", left, right: parseAnd(stream) };
    }
    return left;
}

function parseAnd(stream: TokenStream): Expr {
    let left = parseNot(stream);
    while (stream.match("keyword", "and")) {
        left = { kind: "and", left, right: parseNot(stream) };
    }
    return left;
}

function parseNot(stream: TokenStream): Expr {
    if (stream.match("keyword", "not")) {
        return { kind: "not", operand: parseNot(stream) }
    }
    return parseComparison(stream);
}

function isComparison(token: Token): boolean {
    return token.kind === "operator" && COMPARISONS.has(token.text);
}

function parseComparison(stream: TokenStream): Expr {
    const left = parseArithmetic(stream);
    if (!isComparison(stream.peek())) return left;
    const op = stream.next().text as CompareOperator;
    const right = parseArithmetic(stream);
    const after = stream.peek();
    if (isComparison(after)) {
        throw new ParseError("Comparisons can't be chained; combine them with 'and'", after.position);
    }
    return { kind: "compare", op, left, right };
}

function parseArithmetic(stream: TokenStream): Expr {
    let left = parseUnary(stream);
    for (;;) {
        const token = stream.peek();
        if (token.kind !== "operator" || (token.text !== "+" && token.text !== "-")) {
            return left;
        }
        stream.next();
        left = { kind: "arith", op: token.text, left, right: parseUnary(stream) };
    }
}

function parseUnary(stream: TokenStream): Expr {
    if (stream.match("operator", "-")) {
        return { kind: "arith", op: "-", left: { kind: "literal", value: 0 }, right: parseUnary(stream) };
    }
    return parseSimple(stream);
}

function parseSimple(stream: TokenStream): Expr {
    const token = stream.peek();
    switch (token.kind) {
        case "number":
            stream.next();
            return { kind: "literal", value: Number(token.text) };
        case "left_paren": {
            stream.next();
            const inner = parseOr(stream);
            stream.expect("right_paren", "')'");
            return inner;
        }
        case "name":
            return parseName(stream);
        case "keyword":
            switch (token.text) {
                case "true":
                    stream.next();
                    return { kind: "literal", value: true };
                case "false":
                    stream.next();
                    return { kind: "literal", value: false };
                case "item":
                    return parseItem(stream);
                case "count":
                    return parseCount(stream);
                case "random":
                    return parseRandom(stream);
                case "chance":
                    return parseChance(stream);
            }
            break;
    }
    throw new ParseError(`Expected a value but found ${describe(token)}`, token.position);
}

function parseName(stream: TokenStream): Expr {
    let name = stream.next().text;
    while (stream.match("dot")) {
        const part = stream.next();
        // Allow keywords after a dot, so properties like "med.count" work.
        if (part.kind !== "name" && part.kind !== "keyword") {
            throw new ParseError(`Expected a name after '.' but found ${describe(part)}`, part.position);
        }
        name += "." + part.text;
    }
    return { kind: "var", name };
}

function parseItem(stream: TokenStream): Expr {
    stream.next();
    const tags = parseTagArgument(stream, "item");
    const state = parseStateSuffix(stream) ?? "usable";
 
    if (stream.match("keyword", "as")) {
        const bind = stream.expect("name", "a binding name after 'as'").text;
        return { kind: "item", tags, state, bind };
    }
    return { kind: "item", tags, state };
}
 
function parseCount(stream: TokenStream): Expr {
    stream.next();
    const tags = parseTagArgument(stream, "count");
    const state = parseStateSuffix(stream);
    return state === undefined ? { kind: "item_count", tags } : { kind: "item_count", tags, state };
}
 
function parseRandom(stream: TokenStream): Expr {
    stream.next();
    stream.expect("left_paren", "'(' after 'random'");
    const min = parseOr(stream);
    stream.expect("comma", "',' between the minimum and maximum");
    const max = parseOr(stream);
    stream.expect("right_paren", "')'");
    return { kind: "random", min, max };
}
 
function parseChance(stream: TokenStream): Expr {
    stream.next();
    stream.expect("left_paren", "'(' after 'chance'");
    const percent = parseOr(stream);
    stream.expect("right_paren", "')'");
    return { kind: "chance", percent };
}
 
function parseTagArgument(stream: TokenStream, keyword: string): TagExpr {
    stream.expect("left_paren", `'(' after '${keyword}'`);
    const tags = parseTagOr(stream);
    stream.expect("right_paren", "')'");
    return tags;
}
 
function parseStateSuffix(stream: TokenStream): ItemState | undefined {
    if (!stream.match("dot")) return undefined;
    const token = stream.expect("name", "an item state after '.'");
    if (token.text === "usable" || token.text === "blocked" || token.text === "owned") {
        return token.text;
    }
    throw new ParseError(
        `Unknown item state '${token.text}'; expected 'usable', 'blocked', or 'owned'`,
        token.position,
    );
}

function parseTagOr(stream: TokenStream): TagExpr {
    let left = parseTagAnd(stream);
    while (stream.match("keyword", "or")) {
        left = { kind: "or", left, right: parseTagAnd(stream) };
    }
    return left;
}
 
function parseTagAnd(stream: TokenStream): TagExpr {
    let left = parseTagNot(stream);
    while (stream.match("keyword", "and")) {
        left = { kind: "and", left, right: parseTagNot(stream) };
    }
    return left;
}
 
function parseTagNot(stream: TokenStream): TagExpr {
    if (stream.match("keyword", "not")) {
        return { kind: "not", operand: parseTagNot(stream) };
    }
    if (stream.match("left_paren")) {
        const inner = parseTagOr(stream);
        stream.expect("right_paren", "')'");
        return inner;
    }
    const tag = stream.expect("name", "a tag name");
    return { kind: "tag", name: tag.text };
}