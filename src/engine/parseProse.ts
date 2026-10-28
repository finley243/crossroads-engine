import { parseDirective, type Directive } from "./parseDirective";
import { ParseError } from "./tokenize";
import type { Branch, Effect, Expr, Prose, ProsePart } from "./types";

// Temporarily inserted wherever a statement directive appeared ({if}, {case}, {do}, ...).
// All lines containing only these marks and whitespace are removed, to prevent statement-only lines from leaving extra whitespace.
export const DIRECTIVE_MARK = "\uE000";

export const LITERAL_ASTERISK = "\uE001";

const mark = (): ProsePart => ({ kind: "text", text: DIRECTIVE_MARK });

type Segment =
    | { kind: "text"; text: string; position: number }
    | { kind: "directive"; directive: Directive; position: number };

function stripIndentation(src: string): string {
    return src.split("\n").map(line => line.replace(/^[ \t]+/, "")).join("\n");
}

function scan(src: string): Segment[] {
    const segments: Segment[] = [];
    let text = "";
    let textStart = 0;
    const appendText = (s: string, position: number) => {
        if (text === "") textStart = position;
        text += s;
    }
    const flushText = () => {
        if (text !== "") segments.push({ kind: "text", text, position: textStart });
        text = "";
    }
    let i = 0;
    while (i < src.length) {
        const c = src[i]!;
        if (c === "\\") {
            const next = src[i + 1];
            if (next === "{" || next === "}" || next === "\\") {
                appendText(next, i);
                i += 2;
            } else if (next === "*") {
                appendText(LITERAL_ASTERISK, i);
                i += 2;
            } else {
                appendText(c, i);
                i++;
            }
        } else if (c === "{") {
            flushText();
            const end = findDirectiveEnd(src, i);
            const inner = src.slice(i + 1, end);
            segments.push({ kind: "directive", directive: parseDirectiveAt(inner, i + 1), position: i });
            i = end + 1;
        } else if (c === "}") {
            throw new ParseError("Unexpected '}' (write \\} for a literal brace)", i);
        } else {
            appendText(c, i);
            i++;
        }
    }
    flushText();
    return segments;
}

function findDirectiveEnd(src: string, start: number): number {
    for (let i = start + 1; i < src.length; i++) {
        if (src[i] === "}") return i;
        if (src[i] === "{") break;
    }
    throw new ParseError("This directive is never closed with '}'", start);
}

function parseDirectiveAt(inner: string, offset: number): Directive {
    try {
        return parseDirective(inner);
    } catch (e) {
        if (e instanceof ParseError) throw new ParseError(e.message, offset + e.position);
        throw e;
    }
}

class SegmentStream {
    private index = 0;

    constructor(private readonly segments: Segment[]) {}

    peek(): Segment | undefined {
        return this.segments[this.index];
    }
    
    next(): Segment | undefined {
        return this.segments[this.index++];
    }
}

type DirectiveKind = Directive["kind"];

const IF_BODY_END = new Set<DirectiveKind>(["endif", "else"]);
const ELSE_BODY_END = new Set<DirectiveKind>(["endif"]);
const CASE_BODY_END = new Set<DirectiveKind>(["case", "default", "endswitch"]);
const PUSH_BODY_END = new Set<DirectiveKind>(["endpush"]);

export function parseProse(src: string): Prose {
    const stream = new SegmentStream(scan(stripIndentation(src)));
    return parseBody(stream, new Set());
}

function parseBody(stream: SegmentStream, closes: Set<DirectiveKind>): Prose {
    const parts: Prose = [];
    for (let segment = stream.peek(); segment; segment = stream.peek()) {
        if (segment.kind === "text") {
            stream.next();
            parts.push({ kind: "text", text: segment.text });
            continue;
        }
        const directive = segment.directive;
        if (closes.has(directive.kind)) return parts;
        stream.next();
        switch (directive.kind) {
            case "if":
                parts.push(mark(), parseIf(stream, directive.cond, segment.position), mark());
                break;
            case "switch":
                parts.push(mark(), ...parseSwitch(stream, segment.position), mark());
                break;
            case "push":
                parts.push(mark(), parsePushBlock(stream, directive.node, directive.continuous, segment.position));
                break;
            case "do":
                parts.push(mark(), { kind: "do", effect: directive.effect });
                break;
            case "output":
                // Becomes item_text later if it turns out to be a bound item's name.
                parts.push({ kind: "value", expr: directive.expr });
                break;
            default:
                throw new ParseError(unmatchedCloseMessage(directive.kind), segment.position);
        }
    }
    return parts;
}

function parseIf(stream: SegmentStream, cond: Expr, openedAt: number): ProsePart {
    const branches: Branch[] = [{ cond, body: parseBody(stream, IF_BODY_END) }];
    if (expectClose(stream, IF_BODY_END, "{if}", openedAt) === "else") {
        branches.push({ cond: null, body: [mark(), ...parseBody(stream, ELSE_BODY_END)] });
        expectClose(stream, ELSE_BODY_END, "{if}", openedAt);
    }
    return { kind: "switch", branches };
}

function parseSwitch(stream: SegmentStream, openedAt: number): ProsePart[] {
    const leading: ProsePart[] = [];
    for (let segment = stream.peek(); segment?.kind === "text"; segment = stream.peek()) {
        if (segment.text.trim() !== "") {
            throw new ParseError("Only whitespace can appear between {switch} and its first {case}", segment.position);
        }
        stream.next();
        leading.push({ kind: "text", text: segment.text });
    }
    const branches: Branch[] = [];
    let hasDefault = false;
    for (;;) {
        const segment = stream.next();
        if (!segment) throw new ParseError("This {switch} is never closed with {endswitch}", openedAt);
        if (segment.kind !== "directive") {
            throw new ParseError("Expected {case}, {default}, or {endswitch}", segment.position);
        }
        const directive = segment.directive;
        if (directive.kind === "endswitch") break;
        if (directive.kind === "case" || directive.kind === "default") {
            if (hasDefault) {
                throw new ParseError(`{${directive.kind}} can't come after {default}`, segment.position);
            }
            if (directive.kind === "default") hasDefault = true;
            const cond = directive.kind === "case" ? directive.cond : null;
            branches.push({ cond, body: [mark(), ...parseBody(stream, CASE_BODY_END)] });
            continue;
        }
        throw new ParseError("Expected {case}, {default}, or {endswitch}", segment.position);
    }
    if (branches.length === 0) {
        throw new ParseError("This {switch} has no {case} or {default}", openedAt);
    }
    return [...leading, { kind: "switch", branches }];
}

function parsePushBlock(stream: SegmentStream, node: string, continuous: boolean, openedAt: number): ProsePart {
    const body = parseBody(stream, PUSH_BODY_END);
    expectClose(stream, PUSH_BODY_END, "{push}", openedAt);
    const effect: Effect = { kind: "push", node, continuous, onReturn: [mark(), ...body, mark()] };
    return { kind: "do", effect };
}

function expectClose(stream: SegmentStream, allowed: Set<DirectiveKind>, opener: string, openedAt: number): DirectiveKind {
    const segment = stream.next();
    if (!segment || segment.kind !== "directive" || !allowed.has(segment.directive.kind)) {
        throw new ParseError(`This ${opener} is never closed`, openedAt);
    }
    return segment.directive.kind;
}

function unmatchedCloseMessage(kind: DirectiveKind): string {
    switch (kind) {
        case "else":
        case "endif":
            return `{${kind}} without a matching {if}`;
        case "case":
        case "default":
        case "endswitch":
            return `{${kind}} without a matching {switch}`;
        case "endpush":
            return "{endpush} without a matching {push}";
        default:
            return `Unexpected {${kind}}`;
    }
}