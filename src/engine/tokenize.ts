import { ParseError } from "./errors";

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
    position: number;
}

const KEYWORDS = new Set([
    "and", "or", "not", "as", "true", "false", "item", "count", "random", "chance"
]);

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
        else if (group.punct) tokens.push({ kind: PUNCTUATION[group.punct]!, text: group.punct, position });
    }
    tokens.push({ kind: "eof", text: "", position: src.length })
    return tokens;
};

export class TokenStream {
    private index = 0;
    constructor(private tokens: Token[]) {}

    peek(): Token { return this.tokens[this.index]!; }
    next(): Token {
        const token = this.tokens[this.index]!;
        if (token.kind !== "eof") this.index++;
        return token;
    }
    check(kind: TokenKind, text?: string): boolean {
        const token = this.peek();
        return token.kind === kind && (text === undefined || token.text === text);
    }
    match(kind: TokenKind, text?: string): boolean {
        if (!this.check(kind, text)) return false;
        this.next();
        return true;
    }
    expect(kind: TokenKind, description: string, text?: string): Token {
        if (!this.check(kind, text)) {
            const actual = this.peek();
            throw new ParseError(`Expected ${description} but found ${describe(actual)}`, actual.position);
        }
        return this.next();
    }
}

export function describe(token: Token): string {
    return token.kind === "eof" ? "the end of the expression" : `'${token.text}'`;
}