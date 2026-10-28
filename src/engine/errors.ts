export class ParseError extends Error {
    constructor(message: string, public position: number) {
        super(message);
    }
}

export class RuntimeError extends Error {}