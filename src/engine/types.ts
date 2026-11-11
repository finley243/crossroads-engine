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

export type Expr =
    | { kind: "literal"; value: Value }
    | { kind: "var"; name: string } // always the full name after loading
    | { kind: "not"; operand: Expr }
    | { kind: "and"; left: Expr; right: Expr }
    | { kind: "or"; left: Expr; right: Expr }
    | { kind: "compare"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
    | { kind: "arith"; op: "+" | "-" | "*"; left: Expr; right: Expr }
    // Randomness: the loader only allows these on the right side of an assignment.
    | { kind: "random"; min: Expr; max: Expr }
    | { kind: "chance"; percent: Expr }
    | { kind: "function_ref"; name: string };


// Effects

export type Effect =
    | { kind: "assign"; op: "=" | "+=" | "-="; target: string; value: Expr }
    | { kind: "goto"; node: string; pause?: boolean; clear?: boolean }
    | { kind: "push"; node: string; onReturn?: Prose; pause?: boolean }
    | { kind: "return"; pause?: boolean }
    | { kind: "open_map"; map: string; cancelable: boolean };

export type Transition =
    | { kind: "goto"; node: string; pause: boolean; clear: boolean }
    | { kind: "push"; node: string; pause: boolean; onReturn?: Prose; trip?: boolean }
    | { kind: "return"; pause: boolean }
    | { kind: "open_map"; map: string; cancelable: boolean };


// Prose

export type Prose = ProsePart[];

export type ProsePart =
    | { kind: "text"; text: string } // text with markdown and styling tags
    | { kind: "value"; expr: Expr }
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


export type OptionResult = 
    | { kind: "plain"; text: Prose }
    | { kind: "roll"; chance: Expr; success: Prose; failure: Prose; noReroll?: boolean }; // chance is a whole number of percent

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


// Loaded content

// Maps

export interface MapLocation {
    id: string; // what nodes name in their {location} presentation, so the map can show "you are here"
    name: string;
    description: string;
    x: number; // pixels in the map's image
    y: number;
    node?: string; // the node that traveling here enters. A location with only a map is a marker for looking at that map, and has none
    map?: string; // the map that this location's marker can open, for looking at. It never moves the player: travel is by the map the story opened
    requires?: Expr; // the location only appears on the map while this is true
    unlocked?: Expr; // it can only be traveled to while this is true, though it's still shown on the map
    lockedNote?: string; // says why it's locked
    encounters?: string | null; // the encounter table rolled when traveling here, instead of the map's; null for none
}

// Pages: text the player can look at any time, like a journal or a stat sheet. It's only ever read.

export interface PageSection {
    title: string;
    when?: Expr; // the section only appears while this is true
    text: Prose;
}

export interface PageDef {
    title: string; // what the player sees, and what the page is called: two pages can't have the same one
    tab?: string; // a shorter name for the button, when the title is long
    key?: string; // a letter that opens it
    when?: Expr; // the page only exists for the player while this is true
    text: Prose; // before the first section
    sections: PageSection[];
}

export interface MapDef {
    id: string;
    name: string; // what the player sees: the id, tidied up, until a name is given
    parent?: string; // the map that this one's screen has a button for, to look at it
    requires?: Expr; // the map can only be looked at through a button while this is true
    image: string;
    width: number; // the image's size in pixels, so positions can be placed on it at any display size
    height: number;
    locations: MapLocation[];
    encounters?: string | null; // the encounter table rolled when traveling to a location that doesn't name its own; null for none
}

// Encounters

export interface EncounterEntry {
    node: string; // an ordinary node, which ends with {do return} to carry on to the destination
    weight: number;
    when?: Expr; // the entry can only be rolled while this is true
}

export interface EncounterTable {
    id: string;
    nothing: number; // the weight of nothing happening, against the weights of the entries that can be rolled
    entries: EncounterEntry[];
}


export interface Content {
    nodes: Record<string, Node>;
    vars: Record<string, VarDecl>;
    functions: Record<string, Expr>;
    presets: Record<string, PresentationDecl>;
    maps: Record<string, MapDef>;
    encounters: Record<string, EncounterTable>;
    pages: Record<string, PageDef>;
    game?: GameInfo;
}

/** What the game says about itself, in a `game:` block in a YAML file. */
export interface GameInfo {
    version?: string; // three numbers, like "1.2.3". Saves from a game with a different major or minor version are loaded with a warning
}


// Game state

export interface HistoryEntry {
    node: string;
    option?: string; // the label of the option that led to this node, if any
    text: string; // the text that was displayed to the player at this node
}

export interface AvailableOption {
    index: number;
    label: string;
}

export interface StackFrame {
    node: string;
    onReturn?: Prose;
    trip?: boolean; // an encounter on the way to a destination: the player has left this node's place and not yet reached the next
}

export type Screen =
    | { kind: "node" }
    | { kind: "map"; map: string; cancelable: boolean };

export interface SaveData {
    vars: Record<string, Value>;
    node: string;
    stack: StackFrame[];
    screen: Screen;
    history: HistoryEntry[];
    pending?: Transition;
    pendingRoll?: PendingRoll; // a roll that has been made but not yet accepted, so it can still be re-rolled
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

/** A page the player can open right now. */
export interface PageSummary {
    title: string;
    label: string; // what its button says
    key?: string;
}

/** A page as the player sees it at the moment: its text worked out from the game's current state. */
export interface PageView {
    title: string;
    text: string;
    sections: { title: string; text: string }[];
}

export interface OptionView {
    index: number;
    label: string;
}

/** A roll the player has made, whose outcome hasn't been applied yet. Every roll waits like this, so that it can be shown. */
export interface PendingRoll {
    option: number; // the node's option that was chosen
    label: string; // its label, for the history
    chance: number; // percent, once held between 0 and 100
    success: boolean;
    attempt: number; // 1 for the first roll, 2 after a re-roll, and so on
}

/** What a player needs to see of a pending roll. */
export interface RollView {
    chance: number;
    success: boolean;
    attempt: number;
    rerollsLeft: number;
    canReroll: boolean;
}

export interface SceneView {
    latestEntry: HistoryEntry;
    options: OptionView[];
    presentation: PresentationState;
    roll?: RollView; // set while a roll is waiting to be accepted or re-rolled
}

export interface MapLocationView {
    id: string;
    name: string;
    description: string;
    x: number;
    y: number;
    current: boolean; // the player's current location, for "you are here"
    locked: boolean; // shown on the map, but not available yet
    lockedNote: string;
    travelable: boolean; // has a node, is not where the player already is, and not locked
    destination: boolean; // has a node at all, so it's a place that can be traveled to, and not only a marker that opens a map
    opens?: { map: string; name: string }; // the map that this location's marker can open, if it's available
}

export interface MapView {
    id: string;
    name: string;
    parent?: { map: string; name: string }; // the map that this one has a button for, if it's available
    image: string;
    width: number;
    height: number;
    locations: MapLocationView[]; // only the locations available right now
}
