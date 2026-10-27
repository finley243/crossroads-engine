export type TokenKind =
    | "name"
    | "number"
    | "keyword"
    | "operator"
    | "left_paren"
    | "right_paren"
    | "comma"
    | "dot"
    | "eof";

export interface Token {
    kind: TokenKind;
    text: string;
    position: number; // position in source file, for error logging
}

export class ParseError extends Error {
    constructor(message: string, public position: number) {
        super(message);
    }
}

const KEYWORDS = new Set([
    "and", "or", "not", "as", "true", "false", "item", "count", "random", "chance"
]);

// must be checked in order, so that 2-char operators are matched before 1-char operators
const OPERATORS = ["==", "!=", "<=", ">=", "+=", "-=", "<", ">", "=", "+", "-"];

const PUNCTUATION: Record<string, TokenKind> = {
    "(": "left_paren",
    ")": "right_paren",
    ",": "comma",
    ".": "dot",
};

const TOKEN = /(?<ws>\s+)|(?<name>[A-Za-z_]\w*)|(?<number>\d+)|(?<op>==|!=|<=|>=|\+=|-=|[<>=+-])|(?<punct>[(),.])/y;

export function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < src.length) {
        const position = TOKEN.lastIndex;
        const match = TOKEN.exec(src);
        if (!match?.groups) throw new ParseError(`Unexpected character '${src[position]}'`, position);
        const group = match.groups;
        if (group.ws) continue;
        if (group.name) tokens.push({ kind: KEYWORDS.has(group.name) ? "keyword" : "name", text: group.name, position: position });
        else if (group.number) tokens.push({ kind: "number", text: group.number, position });
        else if (group.op) tokens.push({ kind: "operator", text: group.op, position });
        else if (group.punct) tokens.push({ kind: PUNCTUATION[group.punct]!, text: "", position });
    }
    tokens.push({ kind: "eof", text: "", position: src.length })
    return tokens;
}