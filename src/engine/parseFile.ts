import { isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar, YAMLMap, type Node as YamlNode } from "yaml";
import type { AmbienceState, EncounterEntry, Expr, MapDef, MapLocation, MusicState, NodePresentation, PresentationDecl, PresentationField, Value, VarDecl } from "./types";
import { KEYWORDS, tokenize, TokenStream } from "./tokenize";
import { parseExpression } from "./parseExpression";
import { ParseError } from "./errors";
import { NAME, type FileDeclarations, type LoadError, type Located, type SourceFile } from "./loadTypes";

export function parseFile(file: SourceFile): { declarations: FileDeclarations; errors: LoadError[] } {
    return new FileParser(file).parse();
}

class FileParser {
    private readonly lineCounter = new LineCounter();
    private readonly errors: LoadError[] = [];
    private readonly declarations: FileDeclarations = { nodes: [], vars: [], functions: [], presets: [], maps: [], encounters: [], pages: [] };

    constructor(private readonly file: SourceFile) {}

    parse(): { declarations: FileDeclarations; errors: LoadError[] } {
        const doc = parseDocument(this.file.text, { lineCounter: this.lineCounter });
        for (const err of doc.errors) {
            this.errors.push({ file: this.file.path, line: err.linePos?.[0]?.line ?? 1, message: err.message });
        }
        if (doc.errors.length > 0) return this.result();
        const root = doc.contents;
        if (root === null) return this.result();
        if (!isMap(root)) {
            this.error(root, "A content file must be a map");
            return this.result();
        }
        const fields = this.fields(root, ["vars", "functions", "presets", "maps", "encounters"], "the top level of the file");
        this.forEachEntry(fields.get("vars"), "vars", (name, node) => this.parseVar(name, node, null));
        this.forEachEntry(fields.get("functions"), "functions", (name, node) => this.parseFunction(name, node));
        this.forEachEntry(fields.get("presets"), "presets", (name, node) => this.parsePreset(name, node));
        this.forEachEntry(fields.get("maps"), "maps", (id, node) => this.parseMap(id, node));
        this.forEachEntry(fields.get("encounters"), "encounters", (id, node) => this.parseEncounterTable(id, node));
        return this.result();
    }

    private result() {
        return { declarations: this.declarations, errors: this.errors };
    }

    private parseVar(name: string, node: YamlNode | null, nodeId: string | null): void {
        const fullName = nodeId === null ? name : `${nodeId}.${name}`;
        const decl = (type: VarDecl["type"], value: Value): void => {
            this.declarations.vars.push(this.locate({ name: fullName, type, default: value }, node));
        };
        if (isScalar(node) && typeof node.value === "boolean") return decl({ kind: "bool" }, node.value);
        if (isScalar(node) && typeof node.value === "number") {
            if (!Number.isInteger(node.value)) return this.error(node, `'${name}' must be an integer`);
            return decl({ kind: "int" }, node.value);
        }
        if (isMap(node)) {
            const fields = this.fields(node, ["enum", "default"], `the declaration of '${name}'`);
            const values = this.stringList(fields.get("enum"), `the values of '${name}'`);
            if (!values || values.length === 0) return this.error(node, `'${name}' needs a list of values under 'enum'`);
            const invalid = values.find(v => !NAME.test(v));
            if (invalid !== undefined) return this.error(node, `'${invalid}' isn't a valid enum value name`);
            const defaultNode = fields.get("default");
            const def = defaultNode === undefined ? values[0]! : this.string(defaultNode, `the default of '${name}'`);
            if (def === undefined) return;
            if (!values.includes(def)) return this.error(defaultNode ?? node, `The default '${def}' isn't one of the values of '${name}'`);
            return decl({ kind: "enum", values }, def);
        }
        this.error(node, `'${name}' must be declared as true/false, an integer, or { enum: [...], default: ... }`);
    }

    private parseFunction(name: string, node: YamlNode | null): void {
        if (KEYWORDS.has(name)) return this.error(node, `'${name}' can't be used as a function name, since it's a reserved word`);
        const body = this.expression(node, `the body of function '${name}'`);
        if (body) this.declarations.functions.push(this.locate({ name, body }, node));
    }

    private parsePresentation(node: YamlNode | null, where: string, allowPreset: true): NodePresentation | undefined;
    private parsePresentation(node: YamlNode | null, where: string, allowPreset: false): PresentationDecl | undefined;
    private parsePresentation(node: YamlNode | null, where: string, allowPreset: boolean): NodePresentation | undefined {
        if (!isMap(node)) {
            this.error(node, `${where} must be a map`);
            return undefined;
        }
        const keys = ["image", "theme", "location", "music", "ambience"];
        const fields = this.fields(node, allowPreset ? ["preset", ...keys] : keys, where);
        const result: NodePresentation = {};
        const preset = fields.get("preset");
        if (preset !== undefined) {
            const name = this.string(preset, `the preset in ${where}`);
            if (name !== undefined) result.preset = name;
        }
        const str = (n: YamlNode | null, w: string) => this.stringOrNull(n, w);
        const image = this.presentationField(fields.get("image"), `the image in ${where}`, str);
        const theme = this.presentationField(fields.get("theme"), `the theme in ${where}`, str);
        const location = this.presentationField(fields.get("location"), `the location in ${where}`, str);
        const music = this.presentationField(fields.get("music"), `the music in ${where}`, (n, w) => this.music(n, w));
        const ambience = this.presentationField(fields.get("ambience"), `the ambience in ${where}`, (n, w) => this.ambience(n, w));
        if (image) result.image = image;
        if (theme) result.theme = theme;
        if (location) result.location = location;
        if (music) result.music = music;
        if (ambience) result.ambience = ambience;
        return result;
    }

    private presentationField<T>(node: YamlNode | null | undefined, where: string, parseValue: (node: YamlNode | null, where: string) => T | undefined): PresentationField<T> | undefined {
        if (node === undefined) return undefined;
        if (!isSeq(node)) {
            const value = parseValue(node, where);
            return value === undefined ? undefined : [{ value }];
        }
        const entries: PresentationField<T> = [];
        for (const item of node.items as (YamlNode | null)[]) {
            if (!isMap(item)) {
                this.error(item, `Each entry in ${where} must be a map with 'value' and optionally 'when'`);
                continue;
            }
            const fields = this.fields(item, ["when", "value"], `an entry in ${where}`);
            if (!fields.has("value")) {
                this.error(item, `An entry in ${where} is missing 'value'`);
                continue;
            }
            const value = parseValue(fields.get("value") ?? null, where);
            if (value === undefined) continue;
            const whenNode = fields.get("when");
            if (whenNode === undefined) {
                entries.push({ value });
            } else {
                const when = this.expression(whenNode, `a condition in ${where}`);
                if (when) entries.push({ when, value });
            }
        }
        return entries;
    }

    private music(node: YamlNode | null, where: string): MusicState | null | undefined {
        if (node === null || (isScalar(node) && node.value === null)) return null;
        if (isScalar(node)) {
            const track = this.string(node, where);
            return track === undefined ? undefined : { track };
        }
        if (isMap(node)) {
            const fields = this.fields(node, ["track", "filter"], where);
            const trackNode = fields.get("track");
            if (trackNode === undefined) {
                this.error(node, `${where} needs a 'track'`);
                return undefined;
            }
            const track = this.string(trackNode, where);
            if (track === undefined) return undefined;
            const filterNode = fields.get("filter");
            if (filterNode === undefined) return { track };
            const filter = this.string(filterNode, `the filter in ${where}`);
            return filter === undefined ? undefined : { track, filter };
        }
        this.error(node, `${where} must be a track name, { track, filter }, or null`);
        return undefined;
    }

    private ambience(node: YamlNode | null, where: string): AmbienceState | null | undefined {
        if (node === null || (isScalar(node) && node.value === null)) return null;
        if (isScalar(node)) {
            const track = this.string(node, where);
            return track === undefined ? undefined : { track };
        }
        if (isMap(node)) {
            const fields = this.fields(node, ["track"], where);
            const trackNode = this.required(fields, "track", node, where);
            const track = trackNode === undefined ? undefined : this.string(trackNode, where);
            return track === undefined ? undefined : { track };
        }
        this.error(node, `${where} must be a track name, { track }, or null`);
        return undefined;
    }

    private parseMap(id: string, node: YamlNode | null): void {
        const where = `map '${id}'`;
        if (!isMap(node)) return this.error(node, `${where} must be a map`);
        const fields = this.fields(node, ["image", "width", "height", "locations", "encounters"], where);

        const imageNode = this.required(fields, "image", node, where);
        const widthNode = this.required(fields, "width", node, where);
        const heightNode = this.required(fields, "height", node, where);
        const image = imageNode === undefined ? undefined : this.string(imageNode, `the image of ${where}`);
        const width = widthNode === undefined ? undefined : this.integer(widthNode, `the width of ${where}`);
        const height = heightNode === undefined ? undefined : this.integer(heightNode, `the height of ${where}`);
        if (width !== undefined && width <= 0) this.error(widthNode ?? node, `The width of ${where} must be more than 0`);
        if (height !== undefined && height <= 0) this.error(heightNode ?? node, `The height of ${where} must be more than 0`);

        const locations: MapLocation[] = [];
        this.forEachEntry(fields.get("locations"), `the locations of ${where}`, (locationId, locationNode) => {
            const location = this.parseLocation(locationId, locationNode, where);
            if (!location) return;
            const outside = (location.x < 0 || location.x > (width ?? Infinity)) || (location.y < 0 || location.y > (height ?? Infinity));
            if (outside) this.error(locationNode, `Location '${locationId}' is outside the ${width} x ${height} image of ${where}`);
            locations.push(location);
        });

        const encounters = fields.has("encounters") ? this.encounterRef(fields.get("encounters") ?? null, `the encounters of ${where}`) : undefined;

        if (image === undefined || width === undefined || height === undefined) return;
        const map: MapDef = { id, image, width, height, locations };
        if (encounters !== undefined) map.encounters = encounters;
        this.declarations.maps.push(this.locate(map, node));
    }

    private parseLocation(id: string, node: YamlNode | null, mapWhere: string): MapLocation | undefined {
        const where = `location '${id}' of ${mapWhere}`;
        if (!isMap(node)) {
            this.error(node, `${where} must be a map`);
            return undefined;
        }
        const fields = this.fields(node, ["name", "description", "x", "y", "node", "requires", "unlocked", "locked_note", "encounters"], where);

        const nameNode = this.required(fields, "name", node, where);
        const xNode = this.required(fields, "x", node, where);
        const yNode = this.required(fields, "y", node, where);
        const targetNode = this.required(fields, "node", node, where);
        const name = nameNode === undefined ? undefined : this.string(nameNode, `the name of ${where}`);
        const x = xNode === undefined ? undefined : this.integer(xNode, `x of ${where}`);
        const y = yNode === undefined ? undefined : this.integer(yNode, `y of ${where}`);
        const target = targetNode === undefined ? undefined : this.string(targetNode, `the node of ${where}`);
        const description = fields.has("description") ? this.string(fields.get("description") ?? null, `the description of ${where}`) : "";
        if (name === undefined || x === undefined || y === undefined || target === undefined || description === undefined) return undefined;

        const location: MapLocation = { id, name, description, x, y, node: target };
        const requiresNode = fields.get("requires");
        if (requiresNode !== undefined) {
            const requires = this.expression(requiresNode, `the requirement of ${where}`);
            if (!requires) return undefined;
            location.requires = requires;
        }
        const unlockedNode = fields.get("unlocked");
        if (unlockedNode !== undefined) {
            const unlocked = this.expression(unlockedNode, `the unlock condition of ${where}`);
            if (!unlocked) return undefined;
            location.unlocked = unlocked;
        }
        const noteNode = fields.get("locked_note");
        if (noteNode !== undefined) {
            if (unlockedNode === undefined) this.error(noteNode, `${where} has a 'locked_note' but no 'unlocked' condition, so it's never locked`);
            const note = this.string(noteNode, `the locked note of ${where}`);
            if (note === undefined) return undefined;
            location.lockedNote = note;
        }
        if (fields.has("encounters")) {
            const encounters = this.encounterRef(fields.get("encounters") ?? null, `the encounters of ${where}`);
            if (encounters !== undefined) location.encounters = encounters;
        }
        return location;
    }

    // The name of an encounter table, or "none" for no encounters at all (which comes out as null).
    private encounterRef(node: YamlNode | null, where: string): string | null | undefined {
        const name = this.string(node, where);
        if (name === undefined) return undefined;
        return name === "none" ? null : name;
    }

    private parseEncounterTable(id: string, node: YamlNode | null): void {
        const where = `encounter table '${id}'`;
        if (!isMap(node)) return this.error(node, `${where} must be a map with 'entries', and optionally 'nothing'`);
        if (id === "none") this.error(node, "'none' can't be the name of an encounter table, since it means no encounters");
        const fields = this.fields(node, ["nothing", "entries"], where);

        const nothing = fields.has("nothing") ? this.weight(fields.get("nothing") ?? null, `the 'nothing' weight of ${where}`, true) : 0;
        const entriesNode = this.required(fields, "entries", node, where);
        if (entriesNode === undefined) return;
        if (!isSeq(entriesNode)) return this.error(entriesNode, `The entries of ${where} must be a list`);
        const entries: EncounterEntry[] = [];
        (entriesNode.items as (YamlNode | null)[]).forEach((item, index) => {
            const entry = this.parseEncounterEntry(item, index, where);
            if (entry) entries.push(entry);
        });
        if (nothing === undefined || entries.length !== entriesNode.items.length) return;
        this.declarations.encounters.push(this.locate({ id, nothing, entries }, node));
    }

    private parseEncounterEntry(item: YamlNode | null, index: number, tableWhere: string): EncounterEntry | undefined {
        const where = `entry ${index + 1} of ${tableWhere}`;
        if (!isMap(item)) {
            this.error(item, `${where} must be a map with 'node', and optionally 'weight' and 'when'`);
            return undefined;
        }
        const fields = this.fields(item, ["node", "weight", "when"], where);
        const nodeNode = this.required(fields, "node", item, where);
        const node = nodeNode === undefined ? undefined : this.string(nodeNode, `the node of ${where}`);
        const weight = fields.has("weight") ? this.weight(fields.get("weight") ?? null, `the weight of ${where}`, false) : 1;
        if (node === undefined || weight === undefined) return undefined;

        const entry: EncounterEntry = { node, weight };
        const whenNode = fields.get("when");
        if (whenNode !== undefined) {
            const when = this.expression(whenNode, `the condition of ${where}`);
            if (!when) return undefined;
            entry.when = when;
        }
        return entry;
    }

    private weight(node: YamlNode | null, where: string, allowZero: boolean): number | undefined {
        const value = this.integer(node, where);
        if (value === undefined) return undefined;
        if (value < (allowZero ? 0 : 1)) {
            this.error(node, `${where} must be ${allowZero ? "0 or more" : "1 or more"}`);
            return undefined;
        }
        return value;
    }

    private parsePreset(name: string, node: YamlNode | null): void {
        const decl = this.parsePresentation(node, `preset '${name}'`, false);
        if (decl) this.declarations.presets.push(this.locate({ name, decl }, node));
    }

    private expression(node: YamlNode | null, where: string): Expr | undefined {
        if (isScalar(node) && typeof node.value === "boolean") {
            return { kind: "literal", value: node.value }; // "requires: false" is valid, if odd
        }
        const source = this.string(node, where);
        if (source === undefined || node === null) return undefined;
        try {
            const stream = new TokenStream(tokenize(source));
            const expr = parseExpression(stream);
            stream.expect("eof", "the end of the condition");
            return expr;
        } catch (e) {
            return this.parseFailure(e, node, source, where);
        }
    }

    private parseFailure(e: unknown, node: YamlNode, source: string, where: string): undefined {
        if (!(e instanceof ParseError)) throw e;
        const linesBefore = source.slice(0, e.position).split("\n").length - 1;
        this.errors.push({ file: this.file.path, line: this.contentLine(node) + linesBefore, message: `In ${where}: ${e.message}` });
        return undefined;
    }

    private contentLine(node: YamlNode): number {
        const line = this.lineOf(node);
        const isBlock = isScalar(node) && (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED);
        return isBlock ? line + 1 : line;
    }

    private fields(map: YAMLMap, allowed: string[], where: string): Map<string, YamlNode | null> {
        const result = new Map<string, YamlNode | null>();
        for (const pair of map.items) {
            const keyNode = pair.key as YamlNode | null;
            const key = isScalar(keyNode) ? String(keyNode.value) : undefined;
            if (key === undefined) {
                this.error(keyNode, `Keys in ${where} must be plain names`);
            } else if (!allowed.includes(key)) {
                this.error(keyNode, `Unknown key '${key}' in ${where}; expected one of: ${allowed.join(", ")}`);
            } else {
                result.set(key, pair.value as YamlNode | null);
            }
        }
        return result;
    }

    private forEachEntry(node: YamlNode | null | undefined, where: string, fn: (name: string, value: YamlNode | null) => void): void {
        if (node === undefined || node === null) return;
        if (!isMap(node)) return this.error(node, `'${where}' must be a map`);
        for (const pair of node.items) {
            const keyNode = pair.key as YamlNode | null;
            const name = isScalar(keyNode) ? String(keyNode.value) : undefined;
            if (name === undefined || !NAME.test(name)) {
                this.error(keyNode, `'${name ?? "?"}' in ${where} isn't a valid name (letters, digits, and underscores; no dots)`);
                continue;
            }
            fn(name, pair.value as YamlNode | null);
        }
    }

    private required(fields: Map<string, YamlNode | null>, key: string, parent: YamlNode, where: string): YamlNode | null | undefined {
        if (!fields.has(key)) {
            this.error(parent, `${where} needs '${key}'`);
            return undefined;
        }
        return fields.get(key) ?? null;
    }

    private string(node: YamlNode | null, where: string): string | undefined {
        if (isScalar(node) && typeof node.value === "string") return node.value;
        this.error(node, `Expected text for ${where}`);
        return undefined;
    }

    private stringOrNull(node: YamlNode | null, where: string): string | null | undefined {
        if (node === null || (isScalar(node) && node.value === null)) return null;
        return this.string(node, where);
    }

    private integer(node: YamlNode | null, where: string): number | undefined {
        if (isScalar(node) && typeof node.value === "number" && Number.isInteger(node.value)) return node.value;
        this.error(node, `Expected a whole number for ${where}`);
        return undefined;
    }

    private stringList(node: YamlNode | null | undefined, where: string): string[] | undefined {
        if (!isSeq(node)) {
            this.error(node ?? null, `Expected a list for ${where}`);
            return undefined;
        }
        const result: string[] = [];
        for (const item of node.items as (YamlNode | null)[]) {
            const s = this.string(item, `an entry in ${where}`);
            if (s === undefined) return undefined;
            result.push(s);
        }
        return result;
    }

    private lineOf(node: YamlNode | null): number {
        const offset = node?.range?.[0];
        return offset === undefined ? 1 : this.lineCounter.linePos(offset).line;
    }

    private locate<T>(value: T, node: YamlNode | null): Located<T> {
        return { value, file: this.file.path, line: this.lineOf(node) };
    }

    private error(node: YamlNode | null, message: string): void {
        this.errors.push({ file: this.file.path, line: this.lineOf(node), message });
    }


}