import { DIRECTIVE_WORDS, EFFECT_WORDS } from "./parseDirective";
import { DIRECTIVE_MARK } from "./parseProse";
import { parseStoryFile, STORY_WORDS } from "./parseStoryFile";
import { parseFile } from "./parseFile";
import { RESERVED_PAGE_KEYS } from "./pages";
import type { Branch, Content, EncounterTable, Effect, Expr, GameInfo, Node, NodePresentation, Option, OptionResult, MapDef, PageDef, PageSection, PresentationDecl, PresentationField, Prose, ProsePart, VarDecl } from "./types";
import type { FileDeclarations, LoadError, Located, SourceFile } from "./loadTypes";

export function loadContent(files: SourceFile[]): { content: Content; errors: LoadError[] } {
    const errors: LoadError[] = [];
    const nodes: Located<Node>[] = [];
    const vars: Located<VarDecl>[] = [];
    const functions: Located<{ name: string; body: Expr }>[] = [];
    const presets: Located<{ name: string; decl: PresentationDecl }>[] = [];
    const maps: Located<MapDef>[] = [];
    const encounters: Located<EncounterTable>[] = [];
    const pages: Located<PageDef>[] = [];
    const games: Located<GameInfo>[] = [];
    for (const file of files) {
        const result = parseSourceFile(file);
        errors.push(...result.errors);
        nodes.push(...result.declarations.nodes);
        vars.push(...result.declarations.vars);
        functions.push(...result.declarations.functions);
        presets.push(...result.declarations.presets);
        maps.push(...result.declarations.maps);
        encounters.push(...result.declarations.encounters);
        pages.push(...result.declarations.pages);
        games.push(...result.declarations.game);
    }
    const functionDecls = collect(functions, f => f.name, "function", errors);
    const content: Content = {
        nodes: collect(nodes, n => n.id, "node", errors),
        vars: collect(vars, v => v.name, "variable", errors),
        functions: Object.fromEntries(Object.entries(functionDecls).map(([name, f]) => [name, f.body])),
        presets: Object.fromEntries(Object.entries(collect(presets, p => p.name, "preset", errors)).map(([name, p]) => [name, p.decl])),
        maps: collect(maps, m => m.id, "map", errors),
        encounters: collect(encounters, t => t.id, "encounter table", errors),
        pages: collect(pages, p => p.title, "page", errors),
    };
    if (games[0]) content.game = games[0].value;
    for (const extra of games.slice(1)) {
        errors.push({ file: extra.file, line: extra.line, message: `The game's version is already declared at ${games[0]!.file}:${games[0]!.line}` });
    }
    const functionLocations = new Map<string, Located<unknown>>();
    for (const located of functions) {
        if (!functionLocations.has(located.value.name)) functionLocations.set(located.value.name, located);
    }
    checkVariableNames(vars, content, errors);
    checkPageKeys(pages, content, errors);
    const resolver = new Resolver(content, errors, functionLocations);
    for (const located of functions) {
        const { name } = located.value;
        if (content.functions[name] === located.value.body) resolver.functionBody(name);
    }
    for (const located of nodes) {
        if (content.nodes[located.value.id] === located.value) {
            content.nodes[located.value.id] = resolver.node(located);
        }
    }
    for (const located of pages) {
        const { title } = located.value;
        if (content.pages[title] === located.value) content.pages[title] = resolver.page(located);
    }
    const keptMaps = maps.filter(located => content.maps[located.value.id] === located.value); // a map that's declared twice has been reported already
    for (const located of keptMaps) content.maps[located.value.id] = resolver.map(located);
    checkMapLinks(keptMaps, content, errors);
    for (const located of encounters) {
        const { id } = located.value;
        if (content.encounters[id] === located.value) content.encounters[id] = resolver.encounterTable(located);
    }
    for (const located of presets) {
        const { name } = located.value;
        const decl = content.presets[name];
        if (decl) content.presets[name] = resolver.presentation(decl, null, located, `preset '${name}'`);
    }
    return { content, errors };
}

function parseSourceFile(file: SourceFile): { declarations: FileDeclarations; errors: LoadError[] } {
    return file.path.endsWith(".story") ? parseStoryFile(file) : parseFile(file);
}

function collect<T>(declarations: Located<T>[], nameOf: (value: T) => string, what: string, errors: LoadError[]): Record<string, T> {
    const result: Record<string, T> = {};
    const firstSeen = new Map<string, Located<T>>();
    for (const located of declarations) {
        const name = nameOf(located.value);
        const previous = firstSeen.get(name);
        if (previous) {
            errors.push({
                file: located.file,
                line: located.line,
                message: `The ${what} '${name}' is already declared at ${previous.file}:${previous.line}`,
            });
        } else {
            firstSeen.set(name, located);
            result[name] = located.value;
        }
    }
    return result;
}

// The maps that maps point at have to exist, a map can't be its own parent however indirectly, and a location id names one place on one map.
function checkMapLinks(maps: Located<MapDef>[], content: Content, errors: LoadError[]): void {
    const idsSeen = new Map<string, string>(); // location id -> the map it's on
    const reported = new Set<string>();
    for (const located of maps) {
        const map = located.value;
        const report = (message: string): void => void errors.push({ file: located.file, line: located.line, message });
        if (map.parent !== undefined) {
            if (!content.maps[map.parent]) {
                report(`Unknown map '${map.parent}' (the parent of map '${map.id}')`);
            } else if (!reported.has(map.id)) {
                const chain = [map.id];
                for (let at = map.parent; ; at = content.maps[at]?.parent ?? "") {
                    if (at === "" || !content.maps[at]) break;
                    if (at === map.id) {
                        report(`The parents of map '${map.id}' lead back to it (${[...chain, map.id].join(" → ")})`);
                        chain.forEach(id => reported.add(id));
                        break;
                    }
                    if (chain.includes(at)) break; // a loop that doesn't include this map, reported where it starts
                    chain.push(at);
                }
            }
        }
        for (const location of map.locations) {
            if (location.map !== undefined && !content.maps[location.map]) {
                report(`Unknown map '${location.map}' (the map of location '${location.id}' of map '${map.id}')`);
            }
            const other = idsSeen.get(location.id);
            if (other !== undefined) report(`The location '${location.id}' of map '${map.id}' is already used by map '${other}'; a location id names one place`);
            else idsSeen.set(location.id, map.id);
        }
    }
}

// A page's key opens it, so it can't be one that already does something, or one that another page has.
function checkPageKeys(pages: Located<PageDef>[], content: Content, errors: LoadError[]): void {
    const used = new Map<string, Located<PageDef>>();
    for (const located of pages) {
        const { title, key } = located.value;
        if (!key || content.pages[title] !== located.value) continue; // a page that's declared twice has been reported already
        const reserved = RESERVED_PAGE_KEYS[key];
        const other = used.get(key);
        if (reserved) {
            errors.push({ file: located.file, line: located.line, message: `The key '${key}' can't open page '${title}', since it's already used for ${reserved}` });
        } else if (other) {
            errors.push({ file: located.file, line: located.line, message: `The key '${key}' is already used by page '${other.value.title}' (${other.file}:${other.line})` });
        } else {
            used.set(key, located);
        }
    }
}

function checkVariableNames(vars: Located<VarDecl>[], content: Content, errors: LoadError[]): void {
    for (const located of vars) {
        const fullName = located.value.name;
        const dot = fullName.indexOf(".");
        const shortName = dot === -1 ? fullName : fullName.slice(dot + 1);
        if (DIRECTIVE_WORDS.has(shortName) || EFFECT_WORDS.has(shortName) || STORY_WORDS.has(shortName)) {
            errors.push({
                file: located.file,
                line: located.line,
                message: `'${shortName}' can't be used as a variable name, since it has a special meaning in directives`,
            });
        }
        if (fullName === "rerolls" && located.value.type.kind !== "int") {
            errors.push({
                file: located.file,
                line: located.line,
                message: "'rerolls' has to be a whole number: it's how many re-rolls the player has",
            });
        }
        if (dot !== -1 && content.vars[shortName]) {
            errors.push({
                file: located.file,
                line: located.line,
                message: `The local variable '${fullName}' has the same name as the global '${shortName}'`,
            });
        }
    }
}

interface Scope {
    nodeId: string | null; // the node whose local variables are visible, if any
}

interface ExprContext {
    allowRandom: boolean; // only on the right side of an assignment
}

interface Unresolved {
    kind: "unresolved";
    name: string;
}

class Resolver {
    private readonly locationIds = new Set<string>();
    private readonly resolvedFunctions = new Map<string, Expr>();
    private readonly resolving = new Set<string>();
    private location: { file: string; line: number } = { file: "", line: 1 };
    private where = "";
    private readOnly = false; // while a page is being resolved, which can only show things

    constructor(private readonly content: Content, private readonly errors: LoadError[], private readonly functionLocations: Map<string, Located<unknown>>) {
        for (const map of Object.values(content.maps)) {
            map.locations.forEach(location => this.locationIds.add(location.id));
        }
    }

    map(located: Located<MapDef>): MapDef {
        const map = located.value;
        this.location = located;
        const scope: Scope = { nodeId: null };
        const requires = map.requires ? (this.where = `the requirement of map '${map.id}'`, this.condition(map.requires, scope)) : undefined;
        const locations = map.locations.map(location => {
            this.where = `location '${location.id}' of map '${map.id}'`;
            if (location.node !== undefined) this.checkNode(location.node);
            const resolved = { ...location };
            if (location.requires) resolved.requires = this.condition(location.requires, scope);
            if (location.unlocked) resolved.unlocked = this.condition(location.unlocked, scope);
            if (location.encounters) this.checkEncounterTable(location.encounters);
            return resolved;
        });
        if (map.encounters) {
            this.where = `the encounters of map '${map.id}'`;
            this.checkEncounterTable(map.encounters);
        }
        const resolved: MapDef = { ...map, locations };
        if (requires) resolved.requires = requires;
        return resolved;
    }

    encounterTable(located: Located<EncounterTable>): EncounterTable {
        const table = located.value;
        this.location = located;
        const scope: Scope = { nodeId: null };
        const entries = table.entries.map((entry, index) => {
            this.where = `entry ${index + 1} of encounter table '${table.id}'`;
            this.checkNode(entry.node);
            if (!entry.when) return entry;
            return { ...entry, when: this.condition(entry.when, scope) };
        });
        return { ...table, entries };
    }

    private checkEncounterTable(name: string): void {
        if (!this.content.encounters[name]) this.error(`Unknown encounter table '${name}'`);
    }

    page(located: Located<PageDef>): PageDef {
        const page = located.value;
        this.location = located;
        const scope: Scope = { nodeId: null };
        this.readOnly = true;
        try {
            const result: PageDef = { ...page };
            if (page.when) {
                this.where = `the {when} of page '${page.title}'`;
                result.when = this.condition(page.when, scope);
            }
            this.where = `the text of page '${page.title}'`;
            result.text = this.prose(page.text, scope);
            result.sections = page.sections.map(section => {
                this.where = `section '${section.title}' of page '${page.title}'`;
                const resolved: PageSection = { title: section.title, text: this.prose(section.text, scope) };
                if (section.when) resolved.when = this.condition(section.when, scope);
                return resolved;
            });
            return result;
        } finally {
            this.readOnly = false;
        }
    }

    node(located: Located<Node>): Node {
        const node = located.value;
        this.location = located;
        const nodeScope: Scope = { nodeId: node.id };
        this.where = `the text of node '${node.id}'`;
        const text = this.prose(node.text, nodeScope);
        const options = node.options.map(option => {
            this.where = `option ${option.index + 1} of node '${node.id}'`;
            return this.option(option, nodeScope);
        });
        const result: Node = { id: node.id, text, options };
        if (node.presentation) {
            result.presentation = this.presentation(node.presentation, node.id, located, `the presentation of node '${node.id}'`);
        }
        return result;
    }

    private option(option: Option, scope: Scope): Option {
        const result: Option = { index: option.index, label: option.label, result: option.result };
        if (option.requires) result.requires = this.condition(option.requires, scope);
        result.label = this.prose(option.label, scope);
        result.result = this.optionResult(option.result, scope);
        return result;
    }

    private optionResult(result: OptionResult, scope: Scope): OptionResult {
        if (result.kind === "plain") {
            return { kind: "plain", text: this.prose(result.text, scope) };
        }
        const errorsBefore = this.errors.length;
        const chance = this.expr(result.chance, scope, { allowRandom: false });
        if (this.errors.length === errorsBefore && !this.isInteger(chance)) {
            this.error("The chance of a roll has to be a whole number of percent, like 60 or 40 + stealth * 10");
        }
        const resolved: OptionResult = {
            kind: "roll",
            chance,
            success: this.prose(result.success, scope),
            failure: this.prose(result.failure, scope),
        };
        if (result.noReroll) resolved.noReroll = true;
        if (result.noOdds) resolved.noOdds = true;
        return resolved;
    }

    presentation<T extends PresentationDecl | NodePresentation>(decl: T, nodeId: string | null, location: { file: string; line: number }, where: string): T {
        this.location = location;
        this.where = where;
        const scope: Scope = { nodeId };
        const result = { ...decl };
        if ("preset" in result && result.preset !== undefined && !this.content.presets[result.preset]) {
            this.error(`Unknown preset '${result.preset}'`);
        }
        const field = <V>(f: PresentationField<V> | undefined): PresentationField<V> | undefined =>
            f?.map(entry => {
                if (entry.when === undefined) return entry;
                return { when: this.condition(entry.when, scope), value: entry.value };
            });
        for (const entry of result.location ?? []) {
            if (entry.value !== null && !this.locationIds.has(entry.value)) {
                this.error(`Unknown location '${entry.value}' (no map has a location with that id)`);
            }
        }
        if (result.image) result.image = field(result.image)!;
        if (result.theme) result.theme = field(result.theme)!;
        if (result.location) result.location = field(result.location)!;
        if (result.music) result.music = field(result.music)!;
        if (result.ambience) result.ambience = field(result.ambience)!;
        return result;
    }

    private prose(prose: Prose, scope: Scope): Prose {
        const result = this.parts(prose, scope);
        this.checkNothingAfterPush(result);
        return result;
    }

    private parts(prose: Prose, scope: Scope): Prose {
        return prose.map(part => this.prosePart(part, scope));
    }

    private prosePart(part: ProsePart, scope: Scope): ProsePart {
        switch (part.kind) {
            case "text":
                return part;
            case "value":
                return this.output(part.expr, scope);
            case "switch":
                return { kind: "switch", branches: part.branches.map(branch => this.branch(branch, scope)) };
            case "do":
                if (this.readOnly) {
                    this.error("A page can only show things; {do ...} isn't allowed in one, since it would change the game");
                    return part;
                }
                return { kind: "do", effect: this.effect(part.effect, scope) };
        }
    }

    private branch(branch: Branch, scope: Scope): Branch {
        if (branch.cond === null) return { cond: null, body: this.parts(branch.body, scope) };
        return { cond: this.condition(branch.cond, scope), body: this.parts(branch.body, scope) };
    }

    private output(expr: Expr, scope: Scope): ProsePart {
        const errorsBefore = this.errors.length;
        const resolved = this.expr(expr, scope, { allowRandom: false });
        if (this.errors.length === errorsBefore && !this.isInteger(resolved)) {
            this.error("Only whole numbers can be displayed in text");
        }
        return { kind: "value", expr: resolved };
    }

    private effect(effect: Effect, scope: Scope): Effect {
        switch (effect.kind) {
            case "assign":
                return this.assignment(effect, scope);
            case "goto":
                this.checkNode(effect.node);
                return effect;
            case "push": {
                this.checkNode(effect.node);
                if (effect.onReturn === undefined) return effect;
                return { ...effect, onReturn: this.prose(effect.onReturn, scope) };
            }
            case "open_map":
                if (!this.content.maps[effect.map]) this.error(`Unknown map '${effect.map}'`);
                return effect;
            case "return":
            case "game_over":
                return effect;
        }
    }

    private assignment(effect: Extract<Effect, { kind: "assign" }>, scope: Scope): Effect {
        const target = this.variableName(effect.target, scope);
        if (target === undefined) return effect;
        const decl = this.content.vars[target]!;
        const enumValue = this.enumLiteral(effect.value, decl, scope);
        const value = enumValue ?? this.expr(effect.value, scope, { allowRandom: true });
        if ((effect.op === "+=" || effect.op === "-=") && decl.type.kind !== "int") {
            this.error(`'${effect.op}' only works on whole-number variables, and '${target}' isn't one`);
        } else if (!this.fitsType(value, decl)) {
            const expected = { bool: "true or false", int: "a whole number", enum: "one of its values" }[decl.type.kind];
            this.error(`'${target}' can only be assigned ${expected}`);
        }
        return { kind: "assign", op: effect.op, target, value };
    }

    private condition(expr: Expr, scope: Scope): Expr {
        return this.expr(expr, scope, { allowRandom: false });
    }

    functionBody(name: string): Expr {
        const cached = this.resolvedFunctions.get(name);
        if (cached) return cached;
        const raw = this.content.functions[name];
        if (!raw) {
            this.error(`Unknown function '${name}'`);
            return { kind: "literal", value: false };
        }
        if (this.resolving.has(name)) {
            this.error(`The function '${name}' calls itself, directly or through other functions`);
            return { kind: "literal", value: false };
        }
        const saved = { location: this.location, where: this.where };
        this.location = this.functionLocations.get(name) ?? this.location;
        this.where = `the body of function '${name}'`;
        this.resolving.add(name);
        const resolved = this.expr(raw, { nodeId: null }, { allowRandom: false });
        this.resolving.delete(name);
        this.location = saved.location;
        this.where = saved.where;
        this.resolvedFunctions.set(name, resolved);
        return resolved;
    }

    private expr(expr: Expr, scope: Scope, context: ExprContext): Expr {
        const result = this.exprOrName(expr, scope, context);
        if (result.kind === "unresolved") {
            this.error(`Unknown variable '${result.name}'`);
            return { kind: "literal", value: false };
        }
        return result;
    }

    private exprOrName(expr: Expr, scope: Scope, context: ExprContext): Expr | Unresolved {
        switch (expr.kind) {
            case "literal":
                return expr;
            case "var":
                return this.name(expr.name, scope);
            case "function_ref":
                return this.functionBody(expr.name);
            case "not":
                return { kind: "not", operand: this.expr(expr.operand, scope, context) };
            case "and":
            case "or":
                return {
                    kind: expr.kind,
                    left: this.expr(expr.left, scope, context),
                    right: this.expr(expr.right, scope, context),
                };
            case "compare":
                return this.compare(expr, scope, context);
            case "arith":
                return {
                    kind: "arith",
                    op: expr.op,
                    left: this.expr(expr.left, scope, context),
                    right: this.expr(expr.right, scope, context),
                };
            case "random":
            case "chance":
                if (!context.allowRandom) {
                    this.error(`${expr.kind}() can only be used when assigning a variable, like {do roll = ${expr.kind}(...)}`);
                }
                return expr.kind === "random"
                    ? { kind: "random", min: this.expr(expr.min, scope, context), max: this.expr(expr.max, scope, context) }
                    : { kind: "chance", percent: this.expr(expr.percent, scope, context) };
        }
    }

    private compare(expr: Extract<Expr, { kind: "compare" }>, scope: Scope, context: ExprContext): Expr {
        let left = this.exprOrName(expr.left, scope, context);
        let right = this.exprOrName(expr.right, scope, context);
        if (right.kind === "unresolved") right = this.asEnumValue(right, left);
        if (left.kind === "unresolved") left = this.asEnumValue(left, right);
        const unresolvedLeft = left.kind === "unresolved" ? left : undefined;
        const unresolvedRight = right.kind === "unresolved" ? right : undefined;
        if (unresolvedLeft || unresolvedRight) {
            for (const u of [unresolvedLeft, unresolvedRight]) if (u) this.error(`Unknown variable '${u.name}'`);
            return { kind: "literal", value: false };
        }
        return { kind: "compare", op: expr.op, left: left as Expr, right: right as Expr };
    }

    private asEnumValue(name: Unresolved, other: Expr | Unresolved): Expr | Unresolved {
        if (other.kind !== "var") return name;
        const decl = this.content.vars[other.name];
        if (decl?.type.kind !== "enum") return name;
        if (!decl.type.values.includes(name.name)) {
            this.error(`'${name.name}' isn't a value of '${other.name}' (expected one of: ${decl.type.values.join(", ")})`);
            return { kind: "literal", value: decl.type.values[0]! };
        }
        return { kind: "literal", value: name.name };
    }

    private enumLiteral(value: Expr, decl: VarDecl, scope: Scope): Expr | undefined {
        if (decl.type.kind !== "enum" || value.kind !== "var") return undefined;
        const resolved = this.name(value.name, scope);
        if (resolved.kind !== "unresolved") return undefined; // it's a real variable
        return this.asEnumValue(resolved, { kind: "var", name: decl.name }) as Expr;
    }

    private name(name: string, scope: Scope): Expr | Unresolved {
        const [first, second] = splitName(name);
        if (second === undefined) {
            const full = this.variableName(first, scope, false);
            return full === undefined ? { kind: "unresolved", name: first } : { kind: "var", name: full };
        }
        if (this.content.vars[name]) return { kind: "var", name };
        this.error(this.content.nodes[first] ? `Node '${first}' has no variable '${second}'` : `Unknown name '${name}' (not a node's variable)`);
        return { kind: "literal", value: false };
    }

    private variableName(name: string, scope: Scope, report = true): string | undefined {
        if (name.includes(".")) {
            if (this.content.vars[name]) return name;
        } else {
            if (scope.nodeId !== null && this.content.vars[`${scope.nodeId}.${name}`]) return `${scope.nodeId}.${name}`;
            if (this.content.vars[name]) return name;
        }
        if (report) this.error(`Unknown variable '${name}'`);
        return undefined;
    }

    private checkNode(id: string): void {
        if (!this.content.nodes[id]) this.error(`Unknown node '${id}'`);
    }

    private fitsType(expr: Expr, decl: VarDecl): boolean {
        switch (decl.type.kind) {
            case "int":
                return this.isInteger(expr);
            case "bool":
                return this.isBoolean(expr);
            case "enum":
                if (expr.kind === "literal") return typeof expr.value === "string";
                return expr.kind === "var" && this.content.vars[expr.name]?.type === decl.type;
        }
    }

    private isBoolean(expr: Expr): boolean {
        switch (expr.kind) {
            case "literal":
                return typeof expr.value === "boolean";
            case "var":
                return this.content.vars[expr.name]?.type.kind === "bool";
            case "not":
            case "and":
            case "or":
            case "compare":
            case "chance":
                return true;
            default:
                return false;
        }
    }

    private isInteger(expr: Expr): boolean {
        switch (expr.kind) {
            case "literal":
                return typeof expr.value === "number";
            case "var":
                return this.content.vars[expr.name]?.type.kind === "int";
            case "arith":
            case "random":
                return true;
            default:
                return false;
        }
    }

    private checkNothingAfterPush(prose: Prose): void {
        const visit = (parts: Prose, pushed: boolean): boolean => {
            for (const part of parts) {
                if (pushed && producesSomething(part)) {
                    this.error("Nothing can come after a push on the same path; put alternative text in an {else} or {default}");
                    return pushed;
                }
                if (part.kind === "do" && part.effect.kind === "push") pushed = true;
                if (part.kind === "switch") {
                    const anyBranchPushes = part.branches.map(b => visit(b.body, pushed)).some(Boolean);
                    pushed = pushed || anyBranchPushes;
                }
            }
            return pushed;
        };
        visit(prose, false);
    }

    private error(message: string): void {
        this.errors.push({ file: this.location.file, line: this.location.line, message: `In ${this.where}: ${message}` });
    }
}

function producesSomething(part: ProsePart): boolean {
    if (part.kind === "text") return part.text.replaceAll(DIRECTIVE_MARK, "").trim() !== "";
    return part.kind === "value" || part.kind === "do";
}

function splitName(name: string): [string, string | undefined] {
    const dot = name.indexOf(".");
    return dot === -1 ? [name, undefined] : [name.slice(0, dot), name.slice(dot + 1)];
}