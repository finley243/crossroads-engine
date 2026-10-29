import { ParseError } from "./errors";
import { parseExpression } from "./parseExpression";
import { TokenStream } from "./tokenize";
import type { Expr, MusicState, PresentationField, Value, VarType } from "./types";

export interface VarHeader {
    name: string;
    type: VarType;
    default: Value;
}

export function parseVarHeader(stream: TokenStream): VarHeader {
    const name = stream.expect("name", "a variable name").text;
    if (stream.match("colon")) return parseEnumVar(stream, name);
    stream.expect("operator", "'=' and a starting value", "=");
    if (stream.match("keyword", "true")) return { name, type: { kind: "bool" }, default: true };
    if (stream.match("keyword", "false")) return { name, type: { kind: "bool" }, default: false };
    const negative = stream.match("operator", "-");
    const number = Number(stream.expect("number", "true, false, or a whole number").text);
    return { name, type: { kind: "int" }, default: negative ? -number : number };
}

function parseEnumVar(stream: TokenStream, name: string): VarHeader {
    const values = [stream.expect("name", "a value").text];
    while (stream.match("bar")) values.push(stream.expect("name", "a value after '|'").text);
    let start = values[0]!; // the first value, unless one is given
    if (stream.match("operator", "=")) {
        const token = stream.expect("name", "one of the values");
        if (!values.includes(token.text)) {
            throw new ParseError(`'${token.text}' isn't one of the values (${values.join(", ")})`, token.position);
        }
        start = token.text;
    }
    return { name, type: { kind: "enum", values }, default: start };
}

function parseFieldEntries<V>(stream: TokenStream, parseValue: (stream: TokenStream) => V): PresentationField<V> {
    const entries: PresentationField<V> = [];
    let alwaysApplies = false;
    for (;;) {
        if (stream.match("name", "else")) {
            entries.push({ value: parseValue(stream) });
            alwaysApplies = true;
            break;
        }
        const value = parseValue(stream);
        if (!stream.match("name", "if")) {
            entries.push({ value });
            alwaysApplies = true;
            break;
        }
        entries.push({ when: parseExpression(stream), value });
        if (!stream.match("comma")) break;
    }
    if (alwaysApplies && !stream.check("eof")) {
        throw new ParseError("Nothing can come after an entry that always applies (one with no 'if', or 'else')", stream.peek().position);
    }
    return entries;
}

function parseNameOrNone(stream: TokenStream): string | null {
    const name = stream.expect("name", "a name, or 'none'").text;
    return name === "none" ? null : name;
}

function parseMusicValue(stream: TokenStream): MusicState | null {
    const track = parseNameOrNone(stream);
    if (track === null) return null;
    if (!stream.match("name", "filter")) return { track };
    return { track, filter: stream.expect("name", "a filter name").text };
}

function parseAmbienceValue(stream: TokenStream): { track: string } | null {
    const track = parseNameOrNone(stream);
    return track === null ? null : { track };
}

export const parseNameField = (stream: TokenStream) => parseFieldEntries(stream, parseNameOrNone);
export const parseMusicField = (stream: TokenStream) => parseFieldEntries(stream, parseMusicValue);
export const parseAmbienceField = (stream: TokenStream) => parseFieldEntries(stream, parseAmbienceValue);

export interface OptionClauses {
    requires?: Expr;
    roll?: { difficulty: string; position: number };
}

export function parseOptionClauses(stream: TokenStream): OptionClauses {
    const clauses: OptionClauses = {};
    if (stream.check("eof")) return clauses;
    for (;;) {
        const word = stream.expect("name", "'if' or 'roll'");
        if (word.text === "if") {
            if (clauses.requires) throw new ParseError("This option already has an 'if'", word.position);
            clauses.requires = parseExpression(stream);
        } else if (word.text === "roll") {
            if (clauses.roll) throw new ParseError("This option already has a 'roll'", word.position);
            const difficulty = stream.expect("name", "a difficulty after 'roll'");
            clauses.roll = { difficulty: difficulty.text, position: difficulty.position };
        } else {
            throw new ParseError(`Expected 'if' or 'roll' but found '${word.text}'`, word.position);
        }
        if (!stream.match("comma")) break;
    }
    return clauses;
}