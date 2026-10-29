import type { RawSegment } from "./scan";

export interface SectionKind {
    opener: string; // the word that starts this kind of section, like "node" for {node ...}
    parent?: string; // the kind of section this one must be inside; none means top level
    firstPart: string; // name of the part before any divider, like a node's "text"
    headers: Record<string, "once" | "many">; // directives allowed before the first part has any content
    dividers: Record<string, string[]>; // directives that start a new part, and which parts they may follow
}

export type SectionTable = Record<string, SectionKind>;

export interface Marker {
    word: string;
    args: string;
    argsPosition: number;
    position: number;
}

export interface Part {
    name: string;
    segments: RawSegment[];
    position: number;
}

export interface Section {
    kind: string;
    opener: Marker;
    headers: Marker[];
    parts: Part[]; // the first part is named after the kind's firstPart, then one per divider
    children: Section[];
}

export interface Problem {
    position: number;
    message: string;
}

export function readSections(segments: RawSegment[], table: SectionTable): { sections: Section[]; problems: Problem[] } {
    return new SectionReader(table).read(segments);
}

class SectionReader {
    private readonly sections: Section[] = [];
    private readonly problems: Problem[] = [];
    private readonly open: Section[] = []; // the sections currently open, outermost first
    private readonly started = new Set<Section>(); // sections whose first part has content

    private readonly openers = new Map<string, string>();
    private readonly headerOwners = new Map<string, string>();
    private readonly dividerOwners = new Map<string, string>();

    constructor(private readonly table: SectionTable) {
        for (const [kind, spec] of Object.entries(table)) {
            this.openers.set(spec.opener, kind);
            for (const word of Object.keys(spec.headers)) this.headerOwners.set(word, kind);
            for (const word of Object.keys(spec.dividers)) this.dividerOwners.set(word, kind);
        }
    }

    read(segments: RawSegment[]): { sections: Section[]; problems: Problem[] } {
        for (const segment of segments) {
            if (segment.kind === "directive") this.readDirective(segment);
            else this.readText(segment);
        }
        return { sections: this.sections, problems: this.problems };
    }

    private readText(segment: RawSegment & { kind: "text" | "comment" }): void {
        const current = this.current();
        const hasContent = segment.kind === "text" && segment.text.trim() !== "";
        if (!current) {
            if (hasContent) this.problem(segment.position, "Text has to be inside a section; there's no section open yet");
            return;
        }
        this.lastPart(current).segments.push(segment);
        if (hasContent) this.started.add(current);
    }

    private readDirective(segment: RawSegment & { kind: "directive" }): void {
        const marker = toMarker(segment.source, segment.position);
        const openedKind = this.openers.get(marker.word);
        if (openedKind) return this.openSection(openedKind, marker);
        const headerOwner = this.headerOwners.get(marker.word);
        if (headerOwner) return this.addHeader(headerOwner, marker);
        const dividerOwner = this.dividerOwners.get(marker.word);
        if (dividerOwner) return this.addDivider(dividerOwner, marker);
        const current = this.current();
        if (!current) {
            this.problem(segment.position, "Directives have to be inside a section; there's no section open yet");
            return;
        }
        this.lastPart(current).segments.push(segment);
        this.started.add(current);
    }

    private openSection(kind: string, marker: Marker): void {
        const spec = this.table[kind]!;
        const section: Section = {
            kind,
            opener: marker,
            headers: [],
            parts: [{ name: spec.firstPart, segments: [], position: marker.position }],
            children: [],
        };
        if (spec.parent === undefined) {
            this.open.length = 0;
            this.sections.push(section);
        } else {
            const parentIndex = this.open.findLastIndex(s => s.kind === spec.parent);
            if (parentIndex === -1) {
                this.problem(marker.position, `{${spec.opener}} has to come after a {${this.table[spec.parent]!.opener}}`);
            } else {
                this.open.length = parentIndex + 1;
                this.open[parentIndex]!.children.push(section);
            }
        }
        this.open.push(section);
    }

    private addHeader(ownerKind: string, marker: Marker): void {
        const owner = this.table[ownerKind]!;
        const current = this.current();
        if (!current || current.kind !== ownerKind) {
            this.problem(marker.position, `{${marker.word}} belongs at the top of a ${ownerKind}, before its text`);
            return;
        }
        if (this.started.has(current)) {
            this.problem(marker.position, `{${marker.word}} has to come before the ${ownerKind}'s text`);
            return;
        }
        if (owner.headers[marker.word] === "once" && current.headers.some(h => h.word === marker.word)) {
            this.problem(marker.position, `{${marker.word}} can only be used once in a ${ownerKind}`);
            return;
        }
        current.headers.push(marker);
    }

    private addDivider(ownerKind: string, marker: Marker): void {
        const owner = this.table[ownerKind]!;
        const current = this.current();
        if (!current || current.kind !== ownerKind) {
            this.problem(marker.position, `{${marker.word}} can only be used inside a ${ownerKind} (opened with {${owner.opener}})`);
            return;
        }
        const previous = this.lastPart(current);
        const allowedAfter = owner.dividers[marker.word]!;
        if (current.parts.some(part => part.name === marker.word)) {
            this.problem(marker.position, `{${marker.word}} was already used in this ${ownerKind}`);
        } else if (!allowedAfter.includes(previous.name)) {
            const names = allowedAfter.map(name => (name === owner.firstPart ? `the ${ownerKind}'s ${name}` : `{${name}}`));
            this.problem(marker.position, `{${marker.word}} has to come after ${names.join(" or ")}`);
        }
        current.parts.push({ name: marker.word, segments: [], position: marker.position });
    }

    private current(): Section | undefined {
        return this.open[this.open.length - 1];
    }

    private lastPart(section: Section): Part {
        return section.parts[section.parts.length - 1]!;
    }

    private problem(position: number, message: string): void {
        this.problems.push({ position, message });
    }
}

function toMarker(source: string, position: number): Marker {
    const match = source.startsWith(">") ? /^>\s*/.exec(source) : /^\S*\s*/.exec(source);
    const prefix = match![0];
    const word = source.startsWith(">") ? ">" : prefix.trimEnd();
    return { word, args: source.slice(prefix.length), argsPosition: position + 1 + prefix.length, position };
}