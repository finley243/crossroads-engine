// Variables

export type Value = boolean | number | string;

export type VarType =
    | { kind: "bool" }
    | { kind: "int" }
    | { kind: "enum"; values: string[] };

export interface VarDecl {
    name: string;
    type: VarType;
    default: Value;
}


// Expressions

export type ItemState = "usable" | "blocked" | "owned";

export type TagExpr =
    | { kind: "tag"; name: string }
    | { kind: "not"; operand: TagExpr }
    | { kind: "and"; left: TagExpr; right: TagExpr }
    | { kind: "or"; left: TagExpr; right: TagExpr };

export type Expr =
    | { kind: "literal"; value: Value }
    | { kind: "var"; name: string } // always the full name after loading
    | { kind: "not"; operand: Expr }
    | { kind: "and"; left: Expr; right: Expr }
    | { kind: "or"; left: Expr; right: Expr }
    | { kind: "compare"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
    | { kind: "arith"; op: "+" | "-"; left: Expr; right: Expr }
    | { kind: "item"; tags: TagExpr; state: ItemState; bind?: string }
    | { kind: "item_count"; tags: TagExpr; state: ItemState }
    | { kind: "item_uses"; tags: TagExpr }
    // Randomness: the loader only allows these on the right side of an assignment.
    | { kind: "random"; min: Expr; max: Expr }
    | { kind: "chance"; percent: Expr };


// Effects

export type Effect =
    | { kind: "assign"; op: "=" | "+=" | "-="; target: string; value: Expr }
    /** Spend a charge from, or consume one of, the item bound with `as`. */
    | { kind: "use_item"; binding: string }
    | { kind: "give_item"; item: string; count?: Expr }
    | { kind: "take_item"; item: string; count?: Expr };


// Prose

export type Prose = ProsePart[];

export type ProsePart =
    | { kind: "text"; text: string } // text with markdown and styling tags
    | { kind: "var_token"; name: string } // displays the value of a variable
    | { kind: "item_token"; binding: string; field: "name" | "short" } // displays an item name
    | { kind: "switch"; branches: Branch[] } // {if} parses into a switch
    | { kind: "do"; effect: Effect };

export interface Branch {
    cond: Expr | null; // null means "else"/"default"
    body: Prose;
}


// Nodes

export type Difficulty = "likely" | "even" | "unlikely";

export interface Outcome {
    text: Prose;
    next?: string;
}

export interface Option {
    index: number;
    label: Prose;
    requires?: Expr;
    result: Outcome | { difficulty: Difficulty; success: Outcome; failure: Outcome };
}

export interface PresentationChange {
    image?: string;
    theme?: string;
    music?: { track?: string; filter?: string } | null;
    ambience?: { track: string } | null;
}

export interface Node {
    id: string;
    text: Prose;
    options: Option[];
    presentation?: PresentationChange;
}


// Items

export interface ItemDef {
    id: string;
    name: string;
    short: string;
    description: string;
    tags: string[];
    kind: "cyberware" | "carried";
    slot?: string; // cyberware only
    capacity?: number; // cyberware only
    charges?: { max: number; reset: "mission" | "scene" };
    consumable?: boolean;
}


// Loaded content

export interface Content {
    nodes: Record<string, Node>;
    items: Record<string, ItemDef>;
    vars: Record<string, VarDecl>;
}


// Game state

export interface ItemInstance {
    id: string;
    count: number;
    charges?: number;
    disabled?: boolean;
}

export interface HistoryEntry {
    option?: string; // the label of the option that led to this node, if any
    text: string; // the text that was displayed to the player at this node
}

export interface PresentationState {
    image?: string;
    theme?: string;
    music?: { track: string; filter?: string };
    ambience?: { track: string };
}

export interface GameState {
    vars: Record<string, Value>;
    node: string;
    stack: string[];
    inventory: Record<string, ItemInstance>;
    presentation: PresentationState;
    history: HistoryEntry[];
}


// Engine IO

export type Rng = () => number;

export interface OptionView {
    index: number;
    label: string;
}

export interface SceneView {
    latestEntry: HistoryEntry;
    options: OptionView[];
    presentation: PresentationState;
}