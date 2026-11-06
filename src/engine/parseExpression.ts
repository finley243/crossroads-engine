import { ParseError } from "./errors";
import { describe, type Token, type TokenStream } from "./tokenize";
import type { Expr } from "./types";

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
    let left = parseTerm(stream);
    for (;;) {
        const token = stream.peek();
        if (token.kind !== "operator" || (token.text !== "+" && token.text !== "-")) {
            return left;
        }
        stream.next();
        left = { kind: "arith", op: token.text, left, right: parseTerm(stream) };
    }
}

// Multiplication binds tighter than addition and subtraction.
function parseTerm(stream: TokenStream): Expr {
    let left = parseUnary(stream);
    while (stream.match("operator", "*")) {
        left = { kind: "arith", op: "*", left, right: parseUnary(stream) };
    }
    return left;
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
    let hasDot = false;
    let name = stream.next().text;
    while (stream.match("dot")) {
        hasDot = true;
        const part = stream.next();
        if (part.kind !== "name") {
            throw new ParseError(`Expected a name after '.' but found ${describe(part)}`, part.position);
        }
        name += "." + part.text;
    }
    if (stream.peek()?.kind === "left_paren") {
        let leftParen = stream.next();
        if (hasDot) throw new ParseError(`Function name cannot have a dot`, leftParen.position);
        // Currently, functions cannot have arguments, but this is where they would be parsed
        stream.expect("right_paren", "')' after function call");
        return { kind: "function_ref", name };
    }
    return { kind: "var", name };
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
