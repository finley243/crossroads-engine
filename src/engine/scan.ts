import { ParseError } from "./errors";

export const LITERAL_ASTERISK = "\uE001";

export type RawSegment =
    | { kind: "text"; text: string; position: number }
    | { kind: "directive"; source: string; position: number } // source is whatever is between the braces
    | { kind: "comment"; position: number };

export function scanSource(source: string): RawSegment[] {
    const segments: RawSegment[] = [];
    let text = "";
    let textStart = 0;
    let atLineStart = true;
    const appendText = (s: string, position: number) => {
        if (text === "") textStart = position;
        text += s;
    };
    const flushText = () => {
        if (text !== "") segments.push({ kind: "text", text, position: textStart });
        text = "";
    };
    let i = 0;
    while (i < source.length) {
        const c = source[i]!;
        if (atLineStart && (c === " " || c === "\t")) {
            i++;
            continue;
        }
        atLineStart = false;
        if (c === "\\") {
            const next = source[i + 1];
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
            const end = findDirectiveEnd(source, i);
            const inner = source.slice(i + 1, end);
            segments.push(inner.startsWith("#") ? { kind: "comment", position: i } : { kind: "directive", source: inner, position: i });
            i = end + 1;
        } else if (c === "}") {
            throw new ParseError("Unexpected '}' (write \\} for a literal brace)", i);
        } else {
            appendText(c, i);
            if (c === "\n") atLineStart = true;
            i++;
        }
    }
    flushText();
    return segments;
}

function findDirectiveEnd(source: string, start: number): number {
    for (let i = start + 1; i < source.length; i++) {
        if (source[i] === "}") return i;
        if (source[i] === "{") break;
    }
    throw new ParseError("This directive is never closed with '}'", start);
}

export function lineLookup(source: string): (offset: number) => number {
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === "\n") lineStarts.push(i + 1);
    }
    return offset => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (lineStarts[middle]! <= offset) low = middle;
            else high = middle - 1;
        }
        return low + 1;
    };
}