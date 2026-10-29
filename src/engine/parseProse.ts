import { ParseError } from "./errors";
import { parseDirective, type Directive } from "./parseDirective";
import { scanSource, type RawSegment } from "./scan";
import type { Branch, Effect, Expr, Prose, ProsePart } from "./types";

// Temporarily inserted wherever a statement directive appeared ({if}, {case}, {do}, ...).
// All lines containing only these marks and whitespace are removed, to prevent statement-only lines from leaving extra whitespace.
export const DIRECTIVE_MARK = "\uE000";

const mark = (): ProsePart => ({ kind: "text", text: DIRECTIVE_MARK });

type Segment =
    | { kind: "text"; text: string; position: number }
    | { kind: "directive"; directive: Directive; position: number }
    | { kind: "comment"; position: number };

function parseDirectives(raw: RawSegment[]): Segment[] {
    return raw.map((segment): Segment => {
        if (segment.kind !== "directive") return segment;
        try {
            return { kind: "directive", directive: parseDirective(segment.source), position: segment.position };
        } catch (e) {
            if (e instanceof ParseError) throw new ParseError(e.message, segment.position + 1 + e.position);
            throw e;
        }
    });
}
 
// Drop blank text at the very start and end, so authors can space things out in the file freely.
function trimSegments(segments: RawSegment[]): RawSegment[] {
    const result = [...segments];
    const isBlank = (segment: RawSegment | undefined) => segment?.kind === "text" && segment.text.trim() === "";
    while (isBlank(result[0])) result.shift();
    while (isBlank(result[result.length - 1])) result.pop();
 
    const first = result[0];
    if (first?.kind === "text") {
        const text = first.text.trimStart();
        result[0] = { kind: "text", text, position: first.position + first.text.length - text.length };
    }
    const last = result[result.length - 1];
    if (last?.kind === "text") {
        result[result.length - 1] = { kind: "text", text: last.text.trimEnd(), position: last.position };
    }
    return result;
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
    return parseProseSegments(scanSource(src));
}
 
export function parseProseSegments(raw: RawSegment[], trim = false): Prose {
    const stream = new SegmentStream(parseDirectives(trim ? trimSegments(raw) : raw));
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
        if (segment.kind === "comment") {
            stream.next();
            parts.push(mark());
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
                parts.push(mark(), parsePushBlock(stream, directive.node, directive.pause, segment.position));
                break;
            case "do":
                parts.push(mark(), { kind: "do", effect: directive.effect });
                break;
            case "output":
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
    for (let segment = stream.peek(); segment && segment.kind !== "directive"; segment = stream.peek()) {
        if (segment.kind === "text" && segment.text.trim() !== "") {
            throw new ParseError("Only whitespace can appear between {switch} and its first {case}", segment.position);
        }
        stream.next();
        leading.push(segment.kind === "text" ? { kind: "text", text: segment.text } : mark());
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

function parsePushBlock(stream: SegmentStream, node: string, pause: boolean, openedAt: number): ProsePart {
    const body = parseBody(stream, PUSH_BODY_END);
    expectClose(stream, PUSH_BODY_END, "{push}", openedAt);
    const effect: Effect = { kind: "push", node, pause, onReturn: [mark(), ...body, mark()] };
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