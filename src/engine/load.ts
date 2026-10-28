import { DIRECTIVE_WORDS, EFFECT_WORDS } from "./parseDirective";
import { DIRECTIVE_MARK } from "./parseProse";
import { parseFile, type LoadError, type Located, type SourceFile } from "./parseFile";
import type { Branch, Content, Effect, Expr, ItemDef, Node, NodePresentation, Option, OptionResult, PresentationDecl, PresentationField, Prose, ProsePart, TagExpr, VarDecl } from "./types";

export type { LoadError, SourceFile } from "./parseFile";

export function loadContent(files: SourceFile[]): { content: Content; errors: LoadError[] } {
    const errors: LoadError[] = [];
    const nodes: Located<Node>[] = [];
    const items: Located<ItemDef>[] = [];
    const vars: Located<VarDecl>[] = [];
    const presets: Located<{ name: string; decl: PresentationDecl }>[] = [];
    for (const file of files) {
        const result = parseFile(file);
        errors.push(...result.errors);
        nodes.push(...result.declarations.nodes);
        items.push(...result.declarations.items);
        vars.push(...result.declarations.vars);
        presets.push(...result.declarations.presets);
    }
    const content: Content = {
        nodes: collect(nodes, n => n.id, "node", errors),
        items: collect(items, i => i.id, "item", errors),
        vars: collect(vars, v => v.name, "variable", errors),
        presets: Object.fromEntries(Object.entries(collect(presets, p => p.name, "preset", errors)).map(([name, p]) => [name, p.decl]))
    };
    checkVariableNames(vars, content, errors);
    const resolver = new Resolver(content, errors);
    for (const located of nodes) {
        if (content.nodes[located.value.id] === located.value) {
            content.nodes[located.value.id] = resolver.node(located);
        }
    }
    for (const located of presets) {
        const { name } = located.value;
        const decl = content.presets[name];
        if (decl) content.presets[name] = resolver.presentation(decl, null, located, `preset '${name}'`);
    }
    return { content, errors };
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

function checkVariableNames(vars: Located<VarDecl>[], content: Content, errors: LoadError[]): void {
    for (const located of vars) {
        const fullName = located.value.name;
        const dot = fullName.indexOf(".");
        const shortName = dot === -1 ? fullName : fullName.slice(dot + 1);
        if (DIRECTIVE_WORDS.has(shortName) || EFFECT_WORDS.has(shortName)) {
            errors.push({
                file: located.file,
                line: located.line,
                message: `'${shortName}' can't be used as a variable name, since it has a special meaning in directives`,
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
    nodeId: string | null;
    bindings: Set<string>;
}

interface ExprContext {
    allowRandom: boolean; // only on the right side of an assignment
}

const ITEM_PROPS = new Set(["uses", "has_uses", "count"]);
const ITEM_TEXT_FIELDS = new Set(["name", "short"]);

interface Unresolved {
    kind: "unresolved";
    name: string;
}

class Resolver {
    private readonly tags = new Set<string>();
    private readonly resetGroups = new Set<string>();
    private location: { file: string; line: number } = { file: "", line: 1 };
    private where = "";

    constructor(private readonly content: Content, private readonly errors: LoadError[]) {
        for (const item of Object.values(content.items)) {
            item.tags.forEach(tag => this.tags.add(tag));
            if (item.charges) this.resetGroups.add(item.charges.reset);
        }
    }

    node(located: Located<Node>): Node {
        const node = located.value;
        this.location = located;
        const nodeScope: Scope = { nodeId: node.id, bindings: new Set() };
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

    private option(option: Option, nodeScope: Scope): Option {
        let scope = nodeScope;
        const result: Option = { index: option.index, label: option.label, result: option.result };
        if (option.requires) {
            const { expr, bindings } = this.condition(option.requires, nodeScope);
            result.requires = expr;
            scope = withBindings(nodeScope, bindings);
        }
        result.label = this.prose(option.label, scope);
        result.result = this.optionResult(option.result, scope);
        return result;
    }

    private optionResult(result: OptionResult, scope: Scope): OptionResult {
        if (result.kind === "plain") {
            return { kind: "plain", text: this.prose(result.text, scope) };
        }
        return {
            kind: "roll",
            difficulty: result.difficulty,
            success: this.prose(result.success, scope),
            failure: this.prose(result.failure, scope),
        };
    }

    presentation<T extends PresentationDecl | NodePresentation>(decl: T, nodeId: string | null, location: { file: string; line: number }, where: string): T {
        this.location = location;
        this.where = where;
        const scope: Scope = { nodeId, bindings: new Set() };
        const result = { ...decl };
        if ("preset" in result && result.preset !== undefined && !this.content.presets[result.preset]) {
            this.error(`Unknown preset '${result.preset}'`);
        }
        const field = <V>(f: PresentationField<V> | undefined): PresentationField<V> | undefined =>
            f?.map(entry => {
                if (entry.when === undefined) return entry;
                const { expr, bindings } = this.condition(entry.when, scope);
                if (bindings.length > 0) this.error("Item bindings can't be made in presentation conditions");
                return { when: expr, value: entry.value };
            });
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
            case "item_text":
                return part;
            case "value":
                return this.output(part.expr, scope);
            case "switch":
                return { kind: "switch", branches: part.branches.map(branch => this.branch(branch, scope)) };
            case "do":
                return { kind: "do", effect: this.effect(part.effect, scope) };
        }
    }

    private branch(branch: Branch, scope: Scope): Branch {
        if (branch.cond === null) return { cond: null, body: this.parts(branch.body, scope) };
        const { expr, bindings } = this.condition(branch.cond, scope);
        return { cond: expr, body: this.parts(branch.body, withBindings(scope, bindings)) };
    }

    private output(expr: Expr, scope: Scope): ProsePart {
        if (expr.kind === "var") {
            const [first, field] = splitName(expr.name);
            if (field !== undefined && scope.bindings.has(first) && ITEM_TEXT_FIELDS.has(field)) {
                return { kind: "item_text", binding: first, field: field as "name" | "short" };
            }
        }
        const errorsBefore = this.errors.length;
        const resolved = this.expr(expr, scope, { allowRandom: false });
        if (this.errors.length === errorsBefore && !this.isInteger(resolved)) {
            this.error("Only whole numbers and bound item names (like {d.name}) can be displayed in text");
        }
        return { kind: "value", expr: resolved };
    }

    private effect(effect: Effect, scope: Scope): Effect {
        switch (effect.kind) {
            case "assign":
                return this.assignment(effect, scope);
            case "use_item":
                if (!scope.bindings.has(effect.binding)) {
                    this.error(`'${effect.binding}' isn't a bound item here; bind one first with item(...) as ${effect.binding}`);
                }
                return effect;
            case "give_item":
            case "take_item": {
                if (!this.content.items[effect.item]) this.error(`Unknown item '${effect.item}'`);
                if (effect.count === undefined) return effect;
                const count = this.expr(effect.count, scope, { allowRandom: false });
                if (!this.isInteger(count)) this.error(`The count for ${effect.kind} must be a whole number`);
                return { ...effect, count };
            }
            case "reset_charges":
                if (!this.resetGroups.has(effect.group)) {
                    this.error(`No item has charges that reset with the group '${effect.group}'`);
                }
                return effect;
            case "goto":
                this.checkNode(effect.node);
                return effect;
            case "push": {
                this.checkNode(effect.node);
                if (effect.onReturn === undefined) return effect;
                return { ...effect, onReturn: this.prose(effect.onReturn, scope) };
            }
            case "return":
            case "open_map":
            case "open_shop":
                return effect; // TODO - maps/shops must be added to Content first
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

    private condition(expr: Expr, scope: Scope): { expr: Expr; bindings: string[] } {
        const bindings: string[] = [];
        const visit = (e: Expr, guaranteed: boolean): Expr => {
            if (e.kind === "item" && e.bind !== undefined) {
                if (!guaranteed) this.error(`The item binding '${e.bind}' can't be made inside 'or' or 'not'`);
                if (scope.bindings.has(e.bind) || bindings.includes(e.bind)) {
                    this.error(`'${e.bind}' is already bound here; choose a different name`);
                }
                if (this.content.nodes[e.bind]) {
                    this.error(`The binding '${e.bind}' has the same name as a node`);
                }
                this.tagExpr(e.tags);
                bindings.push(e.bind);
                return e;
            }
            if (e.kind === "and") {
                const left = visit(e.left, guaranteed);
                return { kind: "and", left, right: visit(e.right, guaranteed) };
            }
            if (e.kind === "or") return { kind: "or", left: visit(e.left, false), right: visit(e.right, false) };
            if (e.kind === "not") return { kind: "not", operand: visit(e.operand, false) };
            return this.expr(e, withBindings(scope, bindings), { allowRandom: false });
        };
        return { expr: visit(expr, true), bindings };
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
            case "item":
                if (expr.bind !== undefined) this.error(`The item binding '${expr.bind}' can only be made in a condition`);
                this.tagExpr(expr.tags);
                return expr;
            case "item_count":
                this.tagExpr(expr.tags);
                return expr;
            case "item_prop":
                return expr;
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
            if (scope.bindings.has(first)) {
                this.error(`'${first}' is a bound item, not a value; use one of its properties, like ${first}.uses`);
                return { kind: "literal", value: false };
            }
            const full = this.variableName(first, scope, false);
            return full === undefined ? { kind: "unresolved", name: first } : { kind: "var", name: full };
        } else if (scope.bindings.has(first)) {
            if (ITEM_PROPS.has(second)) {
                return { kind: "item_prop", binding: first, prop: second as "uses" | "has_uses" | "count" };
            }
            if (ITEM_TEXT_FIELDS.has(second)) {
                this.error(`${name} is text, so it can only be displayed, like {${name}}, not used in a condition`);
            } else {
                this.error(`Bound items don't have a property '${second}' (expected uses, has_uses, or count)`);
            }
            return { kind: "literal", value: false };
        } else {
            if (this.content.vars[name]) return { kind: "var", name };
            this.error(
                this.content.nodes[first]
                    ? `Node '${first}' has no variable '${second}'`
                    : `Unknown name '${name}' (not a bound item or a node's variable)`,
            );
            return { kind: "literal", value: false };
        }
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

    private tagExpr(tags: TagExpr): void {
        switch (tags.kind) {
            case "tag":
                if (!this.tags.has(tags.name)) this.error(`No item has the tag '${tags.name}'`);
                return;
            case "not":
                return this.tagExpr(tags.operand);
            case "and":
            case "or":
                this.tagExpr(tags.left);
                this.tagExpr(tags.right);
        }
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
            case "item":
            case "chance":
                return true;
            case "item_prop":
                return expr.prop === "has_uses";
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
            case "item_count":
                return true;
            case "item_prop":
                return expr.prop !== "has_uses";
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
    return part.kind === "value" || part.kind === "item_text" || part.kind === "do";
}

function withBindings(scope: Scope, bindings: string[]): Scope {
    if (bindings.length === 0) return scope;
    return { nodeId: scope.nodeId, bindings: new Set([...scope.bindings, ...bindings]) };
}

function splitName(name: string): [string, string | undefined] {
    const dot = name.indexOf(".");
    return dot === -1 ? [name, undefined] : [name.slice(0, dot), name.slice(dot + 1)];
}