import type { EncounterTable, Expr, MapDef, Node, PresentationDecl, VarDecl } from "./types";

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    vars: Located<VarDecl>[];
    functions: Located<{ name: string; body: Expr }>[];
    presets: Located<{ name: string; decl: PresentationDecl }>[];
    maps: Located<MapDef>[];
    encounters: Located<EncounterTable>[];
}