import { ParseError } from "./errors";
import { NAME, type FileDeclarations, type LoadError, type SourceFile } from "./loadTypes";
import { parseProseSegments } from "./parseProse";
import { readSections, type Marker, type Part, type Section, type SectionTable } from "./readSections";
import { lineLookup, scanSource } from "./scan";
import {
    parseAmbienceField, parseMusicField, parseNameField, parseOptionClauses, parseVarHeader, type OptionClauses,
} from "./storyHeaders";
import { tokenize, TokenStream } from "./tokenize";
import type { Node, NodePresentation, Option, OptionResult, PresentationField, Prose } from "./types";

const SECTIONS: SectionTable = {
    node: {
        opener: "node",
        firstPart: "text",
        headers: { var: "many", preset: "once", image: "once", theme: "once", location: "once", music: "once", ambience: "once" },
        dividers: {},
    },
    option: {
        opener: ">",
        parent: "node",
        firstPart: "label",
        headers: {},
        dividers: { then: ["label"], "then success": ["label", "then failure"], "then failure": ["label", "then success"] },
        renamed: { success: "then success", failure: "then failure" },
    },
};

export const STORY_WORDS = new Set(
    Object.values(SECTIONS)
        .flatMap(kind => [kind.opener, ...Object.keys(kind.headers), ...Object.keys(kind.dividers), ...Object.keys(kind.renamed ?? {})])
        .filter(word => word !== ">"),
);

const PRESENTATION_FIELDS: Record<string, (stream: TokenStream) => PresentationField<unknown>> = {
    image: parseNameField,
    theme: parseNameField,
    location: parseNameField,
    music: parseMusicField,
    ambience: parseAmbienceField,
};

interface Context {
    file: string;
    lineAt: (offset: number) => number;
    errors: LoadError[];
}

export function parseStoryFile(file: SourceFile): { declarations: FileDeclarations; errors: LoadError[] } {
    const text = file.text.replaceAll("\r\n", "\n");
    const context: Context = { file: file.path, lineAt: lineLookup(text), errors: [] };
    const declarations: FileDeclarations = { nodes: [], vars: [], functions: [], presets: [], maps: [], encounters: [] };

    const segments = attempt(context, 0, () => scanSource(text));
    if (segments === undefined) return { declarations, errors: context.errors };

    const { sections, problems } = readSections(segments, SECTIONS);
    for (const problem of problems) report(context, problem.position, problem.message);

    for (const section of sections) buildNode(section, context, declarations);
    return { declarations, errors: context.errors };
}

function buildNode(section: Section, context: Context, declarations: FileDeclarations): void {
    const id = section.opener.args.trim();
    if (!NAME.test(id)) {
        const problem = id === "" ? "{node} needs a name, like {node my_node}" : `'${id}' isn't a valid node name (letters, digits, and underscores)`;
        report(context, section.opener.position, problem);
        return;
    }
    for (const header of section.headers.filter(h => h.word === "var")) {
        const variable = parseArgs(context, header, parseVarHeader);
        if (!variable) continue;
        const value = { name: `${id}.${variable.name}`, type: variable.type, default: variable.default };
        declarations.vars.push({ value, file: context.file, line: context.lineAt(header.position) });
    }
    const node: Node = {
        id,
        text: prose(section.parts[0]!, context) ?? [],
        options: section.children.flatMap((child, index) => buildOption(child, index, context) ?? []),
    };
    const presentation = buildPresentation(section.headers, context);
    if (presentation) node.presentation = presentation;
    declarations.nodes.push({ value: node, file: context.file, line: context.lineAt(section.opener.position) });
}

function buildPresentation(headers: Marker[], context: Context): NodePresentation | undefined {
    const presentation: Record<string, unknown> = {};
    for (const header of headers) {
        if (header.word === "preset") {
            const name = parseArgs(context, header, stream => stream.expect("name", "a preset name").text);
            if (name) presentation.preset = name;
            continue;
        }
        const parseField = PRESENTATION_FIELDS[header.word];
        if (!parseField) continue; // not a presentation directive (like {var})
        const field = parseArgs(context, header, parseField);
        if (field) presentation[header.word] = field;
    }
    return Object.keys(presentation).length > 0 ? (presentation as NodePresentation) : undefined;
}

function buildOption(section: Section, index: number, context: Context): Option | undefined {
    const clauses = parseArgs(context, section.opener, parseOptionClauses);
    const label = prose(section.parts[0]!, context);
    if (label?.length === 0) {
        report(context, section.opener.position, "This option has no label; write the text the player will see between {>} and {then}");
    }
    if (!findPart(section, "then") && !findPart(section, "then success") && !findPart(section, "then failure")) {
        report(context, section.opener.position, "This option never reaches {then}, which ends the label and starts what happens when it's chosen (for a roll, {then success} and {then failure})");
        return undefined;
    }
    const result = clauses && buildResult(section, clauses, context);
    if (!clauses || !label || label.length === 0 || !result) return undefined;
    const option: Option = { index, label, result };
    if (clauses.requires) option.requires = clauses.requires;
    return option;
}

function buildResult(section: Section, clauses: OptionClauses, context: Context): OptionResult | undefined {
    const plain = findPart(section, "then");
    const success = findPart(section, "then success");
    const failure = findPart(section, "then failure");
    if (plain) {
        if (success || failure) return undefined; // the section reader has already said that they can't be mixed
        if (clauses.roll) {
            report(context, section.opener.position, "This option has a roll, so it needs {then success} and {then failure} instead of {then}");
            return undefined;
        }
        const text = prose(plain, context);
        return text && { kind: "plain", text };
    }
    let valid = true;
    const fail = (position: number, message: string) => {
        report(context, position, message);
        valid = false;
    };
    if (!success || !failure) {
        const present = success ?? failure!;
        fail(present.position, `This option has {${present.name}} but is missing {${success ? "then failure" : "then success"}}`);
    }
    if (!clauses.roll) {
        fail(section.opener.position, "{then success} and {then failure} need a roll; add one to the option, like {> roll 60} or {> roll 40 + stealth * 10}");
    }
    if (!valid || !success || !failure || !clauses.roll) return undefined;
    const successText = prose(success, context);
    const failureText = prose(failure, context);
    if (!successText || !failureText) return undefined;
    return { kind: "roll", chance: clauses.roll, success: successText, failure: failureText };
}

function findPart(section: Section, name: string): Part | undefined {
    return section.parts.find(part => part.name === name);
}

function prose(part: Part, context: Context): Prose | undefined {
    return attempt(context, 0, () => parseProseSegments(part.segments, true));
}

function parseArgs<T>(context: Context, marker: Marker, parse: (stream: TokenStream) => T): T | undefined {
    return attempt(context, marker.argsPosition, () => {
        const stream = new TokenStream(tokenize(marker.args));
        const result = parse(stream);
        stream.expect("eof", `the end of {${marker.word}}`);
        return result;
    });
}

function attempt<T>(context: Context, base: number, parse: () => T): T | undefined {
    try {
        return parse();
    } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        report(context, base + e.position, e.message);
        return undefined;
    }
}

function report(context: Context, offset: number, message: string): void {
    context.errors.push({ file: context.file, line: context.lineAt(offset), message });
}