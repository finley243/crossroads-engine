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
    | { kind: "item_count"; tags: TagExpr; state?: ItemState }
    | { kind: "item_prop"; binding: string; prop: "uses" | "has_uses" | "count" }
    // Randomness: the loader only allows these on the right side of an assignment.
    | { kind: "random"; min: Expr; max: Expr }
    | { kind: "chance"; percent: Expr };


// Effects

export type Effect =
    | { kind: "assign"; op: "=" | "+=" | "-="; target: string; value: Expr }
    | { kind: "use_item"; binding: string } // spend a charge from, or consume one of, the bound item
    | { kind: "give_item"; item: string; count?: Expr }
    | { kind: "take_item"; item: string; count?: Expr }
    | { kind: "reset_charges"; group: string }
    | { kind: "goto"; node: string; pause?: boolean }
    | { kind: "push"; node: string; onReturn?: Prose; pause?: boolean }
    | { kind: "return" }
    | { kind: "open_map"; map: string }
    | { kind: "open_shop"; shop: string };

export type Transition =
    | { kind: "goto"; node: string; pause: boolean }
    | { kind: "push"; node: string; pause: boolean; onReturn?: Prose; bindings: Bindings }
    | { kind: "return" }
    | { kind: "open_map"; map: string }
    | { kind: "open_shop"; shop: string };


// Prose

export type Prose = ProsePart[];

export type ProsePart =
    | { kind: "text"; text: string } // text with markdown and styling tags
    | { kind: "value"; expr: Expr }
    | { kind: "item_text"; binding: string; field: "name" | "short" } // displays the bound item's name
    | { kind: "switch"; branches: Branch[] } // {if} parses into a switch
    | { kind: "do"; effect: Effect };

export interface Branch {
    cond: Expr | null; // null means "else"/"default"
    body: Prose;
}


// Presentation

export interface MusicState {
    track: string;
    filter?: string;
}
 
export interface AmbienceState {
    track: string;
}
 
export type PresentationField<T> = { when?: Expr; value: T }[];
 
export interface PresentationDecl {
    // null explicitly means "none" (silence, no image, default theme).
    // In a regular node, an omitted field also means "none".
    // In an overlay node, an omitted field inherits from the node below.
    image?: PresentationField<string | null>;
    theme?: PresentationField<string | null>;
    location?: PresentationField<string | null>;
    music?: PresentationField<MusicState | null>;
    ambience?: PresentationField<AmbienceState | null>;
}
 
export interface NodePresentation extends PresentationDecl {
    preset?: string; // fields declared here override the preset's
}



// Nodes

export type Difficulty = "likely" | "even" | "unlikely";

export type OptionResult = 
    | { kind: "plain"; text: Prose }
    | { kind: "roll"; difficulty: Difficulty; success: Prose; failure: Prose };

export interface Option {
    index: number;
    label: Prose;
    requires?: Expr;
    result: OptionResult;
}

export interface Node {
    id: string;
    text: Prose;
    options: Option[];
    presentation?: NodePresentation;
}


// Items

export interface ItemBase {
    id: string;
    name: string;
    short: string;
    description: string;
    tags: string[];
    charges?: { max: number; reset: string };
}

export type ItemDef = ItemBase & (
    | { kind: "cyberware"; slot: string; capacity: number }
    | { kind: "carried"; consumable?: boolean }
);


// Loaded content

export interface Content {
    nodes: Record<string, Node>;
    items: Record<string, ItemDef>;
    vars: Record<string, VarDecl>;
    presets: Record<string, PresentationDecl>;
}


// Game state

export type Bindings = Record<string, string>; // binding name -> item ID

export interface ItemInstance {
    id: string;
    count: number;
    charges?: number;
    disabled?: boolean;
}

export interface HistoryEntry {
    node: string;
    option?: string; // the label of the option that led to this node, if any
    text: string; // the text that was displayed to the player at this node
}

export interface AvailableOption {
    index: number;
    label: string;
    bindings: Bindings;
}

export interface StackFrame {
    node: string;
    onReturn?: Prose;
    bindings: Bindings;
}

export type Screen =
    | { kind: "node" }
    | { kind: "map"; map: string; canTravel: boolean }
    | { kind: "shop"; shop: string };

export interface SaveData {
    contentVersion: number;
    vars: Record<string, Value>;
    node: string;
    stack: StackFrame[];
    inventory: Record<string, ItemInstance>;
    screen: Screen;
    history: HistoryEntry[];
    pending?: Transition;
}

export interface GameState extends SaveData {
    options: AvailableOption[];
}


// Engine IO

export type Rng = () => number;

export interface PresentationState {
    image: string | null;
    theme: string | null;
    location: string | null;
    music: MusicState | null;
    ambience: AmbienceState | null;
}

export interface OptionView {
    index: number;
    label: string;
}

export interface SceneView {
    latestEntry: HistoryEntry;
    options: OptionView[];
    presentation: PresentationState;
}