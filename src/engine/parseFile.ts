import { isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar, YAMLMap, type Node as YamlNode } from "yaml";
import type { AmbienceState, Difficulty, Expr, ItemDef, MapDef, MapLocation, MusicState, Node, NodePresentation, Option, OptionResult, PresentationDecl, PresentationField, Prose, Value, VarDecl } from "./types";
import { tokenize, TokenStream } from "./tokenize";
import { parseExpression } from "./parseExpression";
import { parseProse } from "./parseProse";
import { ParseError } from "./errors";

export interface SourceFile {
    path: string;
    text: string;
}

export interface LoadError {
    file: string;
    line: number; // indexed from 1
    message: string;
}

export interface Located<T> {
    value: T;
    file: string;
    line: number;
}

export interface FileDeclarations {
    nodes: Located<Node>[];
    items: Located<ItemDef>[];
    vars: Located<VarDecl>[];
    presets: Located<{ name: string; decl: PresentationDecl }>[];
    maps: Located<MapDef>[];
}

export function parseFile(file: SourceFile): { declarations: FileDeclarations; errors: LoadError[] } {
    return new FileParser(file).parse();
}

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DIFFICULTIES = new Set<string>(["likely", "even", "unlikely"]);

class FileParser {
    private readonly lineCounter = new LineCounter();
    private readonly errors: LoadError[] = [];
    private readonly declarations: FileDeclarations = { nodes: [], items: [], vars: [], presets: [], maps: [] };

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
        const fields = this.fields(root, ["vars", "nodes", "items", "presets", "maps"], "the top level of the file");
        this.forEachEntry(fields.get("vars"), "vars", (name, node) => this.parseVar(name, node, null));
        this.forEachEntry(fields.get("nodes"), "nodes", (id, node) => this.parseNode(id, node));
        this.forEachEntry(fields.get("items"), "items", (id, node) => this.parseItem(id, node));
        this.forEachEntry(fields.get("presets"), "presets", (name, node) => this.parsePreset(name, node));
        this.forEachEntry(fields.get("maps"), "maps", (id, node) => this.parseMap(id, node));
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

    private parseNode(id: string, node: YamlNode | null): void {
        if (!isMap(node)) return this.error(node, `Node '${id}' must be a map`);
        const fields = this.fields(node, ["vars", "text", "presentation", "options"], `node '${id}'`);
        this.forEachEntry(fields.get("vars"), `the vars of node '${id}'`, (name, n) => this.parseVar(name, n, id));
        const textNode = fields.get("text");
        const text = textNode === undefined ? [] : this.prose(textNode, `the text of node '${id}'`) ?? [];
        const options: Option[] = [];
        const optionsNode = fields.get("options");
        if (optionsNode !== undefined && optionsNode !== null) {
            if (!isSeq(optionsNode)) {
                this.error(optionsNode, `The options of node '${id}' must be a list`);
            } else {
                optionsNode.items.forEach((item, index) => {
                    const option = this.parseOption(item as YamlNode | null, index, id);
                    if (option) options.push(option);
                });
            }
        }
        const result: Node = { id, text, options };
        const presentationNode = fields.get("presentation");
        if (presentationNode !== undefined) {
            const presentation = this.parsePresentation(presentationNode, `the presentation of node '${id}'`, true);
            if (presentation) result.presentation = presentation;
        }
        this.declarations.nodes.push(this.locate(result, node));
    }

    private parseOption(node: YamlNode | null, index: number, nodeId: string): Option | undefined {
        const where = `option ${index + 1} of node '${nodeId}'`;
        if (!isMap(node)) {
            this.error(node, `${where} must be a map`);
            return undefined;
        }
        const fields = this.fields(node, ["label", "requires", "text", "roll", "success", "failure"], where);
        const labelNode = fields.get("label");
        if (labelNode === undefined) {
            this.error(node, `${where} needs a 'label'`);
            return undefined;
        }
        if (isSeq(labelNode)) {
            this.error(labelNode, `The label of ${where} looks like a list; labels starting with '[' must be quoted`);
            return undefined;
        }
        const label = this.prose(labelNode, `the label of ${where}`);
        if (!label) return undefined;
        const result = this.parseOptionResult(fields, node, where);
        if (!result) return undefined;
        const option: Option = { index, label, result };
        const requiresNode = fields.get("requires");
        if (requiresNode !== undefined) {
            const requires = this.expression(requiresNode, `the requirement of ${where}`);
            if (!requires) return undefined;
            option.requires = requires;
        }
        return option;
    }

    private parseOptionResult(fields: Map<string, YamlNode | null>, node: YamlNode, where: string): OptionResult | undefined {
        const rollNode = fields.get("roll");
        if (rollNode === undefined) {
            for (const key of ["success", "failure"]) {
                if (fields.has(key)) this.error(fields.get(key) ?? node, `'${key}' only applies to options with a 'roll'`);
            }
            const textNode = fields.get("text");
            const text = textNode === undefined ? [] : this.prose(textNode, `the text of ${where}`);
            return text ? { kind: "plain", text } : undefined;
        }
        if (fields.has("text")) {
            this.error(fields.get("text") ?? node, `An option with a 'roll' uses 'success' and 'failure' instead of 'text'`);
        }
        const difficulty = this.string(rollNode, `the roll of ${where}`);
        if (difficulty === undefined) return undefined;
        if (!DIFFICULTIES.has(difficulty)) {
            this.error(rollNode, `Unknown difficulty '${difficulty}'; expected likely, even, or unlikely`);
            return undefined;
        }
        const outcome = (key: "success" | "failure"): Prose | undefined => {
            const n = fields.get(key);
            if (n === undefined) {
                this.error(node, `${where} has a 'roll', so it needs '${key}' text`);
                return undefined;
            }
            return this.prose(n, `the ${key} text of ${where}`);
        };
        const success = outcome("success");
        const failure = outcome("failure");
        if (!success || !failure) return undefined;
        return { kind: "roll", difficulty: difficulty as Difficulty, success, failure };
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

    private parseItem(id: string, node: YamlNode | null): void {
        const where = `item '${id}'`;
        if (!isMap(node)) return this.error(node, `${where} must be a map`);
        const fields = this.fields(
            node,
            ["name", "short", "description", "tags", "kind", "slot", "capacity", "consumable", "charges"],
            where,
        );
        const nameNode = this.required(fields, "name", node, where);
        const name = nameNode === undefined ? undefined : this.string(nameNode, `the name of ${where}`);
        if (name === undefined) return;
        const short = fields.has("short") ? this.string(fields.get("short") ?? null, `the short name of ${where}`) : name;
        const description = fields.has("description") ? this.string(fields.get("description") ?? null, `the description of ${where}`) : "";
        const tags = fields.has("tags") ? this.stringList(fields.get("tags"), `the tags of ${where}`) : [];
        if (short === undefined || description === undefined || tags === undefined) return;
        if (!tags.includes(id)) tags.push(id); // every item is implicitly tagged with its own id
        const base = { id, name, short, description, tags };
        let charges: { max: number; reset: string } | undefined;
        const chargesNode = fields.get("charges");
        if (chargesNode !== undefined) {
            if (!isMap(chargesNode)) return this.error(chargesNode, `The charges of ${where} must be { max, reset }`);
            const cf = this.fields(chargesNode, ["max", "reset"], `the charges of ${where}`);
            const maxNode = this.required(cf, "max", chargesNode, `The charges of ${where}`);
            const resetNode = this.required(cf, "reset", chargesNode, `The charges of ${where}`);
            const max = maxNode === undefined ? undefined : this.integer(maxNode, `the maximum charges of ${where}`);
            const reset = resetNode === undefined ? undefined : this.string(resetNode, `the reset group of ${where}`);
            if (max === undefined || reset === undefined) return;
            charges = { max, reset };
        }
        const kindNode = this.required(fields, "kind", node, where);
        const kind = kindNode === undefined ? undefined : this.string(kindNode, `the kind of ${where}`);
        let item: ItemDef;
        if (kind === "cyberware") {
            const slotNode = this.required(fields, "slot", node, `Cyberware ${where}`);
            const capacityNode = this.required(fields, "capacity", node, `Cyberware ${where}`);
            const slot = slotNode === undefined ? undefined : this.string(slotNode, `the slot of ${where}`);
            const capacity = capacityNode === undefined ? undefined : this.integer(capacityNode, `the capacity of ${where}`);
            if (fields.has("consumable")) this.error(fields.get("consumable") ?? node, `Cyberware can't be consumable`);
            if (slot === undefined || capacity === undefined) return;
            item = { ...base, kind, slot, capacity };
        } else if (kind === "carried") {
            for (const key of ["slot", "capacity"]) {
                if (fields.has(key)) this.error(fields.get(key) ?? node, `'${key}' only applies to cyberware`);
            }
            item = { ...base, kind };
            if (fields.has("consumable")) {
                const consumable = this.boolean(fields.get("consumable") ?? null, `'consumable' on ${where}`);
                if (consumable === undefined) return;
                item.consumable = consumable;
            }
        } else {
            if (kind !== undefined) this.error(fields.get("kind") ?? node, `Unknown item kind '${kind}'; expected cyberware or carried`);
            return;
        }
        if (charges) item.charges = charges;
        this.declarations.items.push(this.locate(item, node));
    }

    private parseMap(id: string, node: YamlNode | null): void {
        const where = `map '${id}'`;
        if (!isMap(node)) return this.error(node, `${where} must be a map`);
        const fields = this.fields(node, ["image", "width", "height", "locations"], where);

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

        if (image === undefined || width === undefined || height === undefined) return;
        this.declarations.maps.push(this.locate({ id, image, width, height, locations }, node));
    }

    private parseLocation(id: string, node: YamlNode | null, mapWhere: string): MapLocation | undefined {
        const where = `location '${id}' of ${mapWhere}`;
        if (!isMap(node)) {
            this.error(node, `${where} must be a map`);
            return undefined;
        }
        const fields = this.fields(node, ["name", "description", "x", "y", "node", "requires", "unlocked", "locked_note"], where);

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
        return location;
    }

    private parsePreset(name: string, node: YamlNode | null): void {
        const decl = this.parsePresentation(node, `preset '${name}'`, false);
        if (decl) this.declarations.presets.push(this.locate({ name, decl }, node));
    }
    
    private prose(node: YamlNode | null, where: string): Prose | undefined {
        const source = this.string(node, where);
        if (source === undefined || node === null) return undefined;
        try {
            return parseProse(source);
        } catch (e) {
            return this.parseFailure(e, node, source, where);
        }
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

    private boolean(node: YamlNode | null, where: string): boolean | undefined {
        if (isScalar(node) && typeof node.value === "boolean") return node.value;
        this.error(node, `Expected true or false for ${where}`);
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