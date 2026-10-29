// Usage: npm start -- <content folder> <start node>

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadContent, type SourceFile } from "../engine/load";
import { newGame, sceneView, SCENE_BREAK, step } from "../engine/step";
import type { Content, GameState } from "../engine/types";
import { LITERAL_ASTERISK } from "../engine/scan";


const [contentDir = "content", startNode = "start"] = process.argv.slice(2);
const rng = Math.random;

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function readContent(dir: string): SourceFile[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((name: string) => name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".story"))
        .sort()
        .map((name: string) => ({ path: name, text: readFileSync(join(dir, name), "utf8") }));
}

function style(text: string): string {
    return text
        .replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`)
        .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
        .replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`)
        .replaceAll(SCENE_BREAK, `${DIM}────────${RESET}`)
        .replaceAll(LITERAL_ASTERISK, "*");
}

function show(content: Content, state: GameState): void {
    const view = sceneView(content, state, rng);
    console.log();
    if (view.latestEntry.option) console.log(`${DIM}› ${view.latestEntry.option}${RESET}\n`);
    if (view.latestEntry.text) console.log(style(view.latestEntry.text) + "\n");
    view.options.forEach((option, i) => console.log(`  ${i + 1}. ${style(option.label)}`));
}

async function main(): Promise<void> {
    const files = readContent(contentDir);
    const { content, errors } = loadContent(files);
    if (errors.length > 0) {
        for (const e of errors) console.error(`${e.file}:${e.line}: ${e.message}`);
        console.error(`\n${errors.length} error(s); fix them and try again.`);
        process.exit(1);
    }
    if (!content.nodes[startNode]) {
        console.error(`There's no node called '${startNode}' (loaded ${files.length} file(s) from '${contentDir}').`);
        process.exit(1);
    }
    const rl = createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (): Promise<string | null> => {
        process.stdout.write("\n> ");
        const next = await lines.next();
        return next.done ? null : next.value.trim();
    };
    let state = newGame(content, startNode, rng);
    show(content, state);
    for (;;) {
        const view = sceneView(content, state, rng);
        if (view.options.length === 0) {
            console.log(`${DIM}(No options left. The end.)${RESET}`);
            break;
        }
        const input = await ask();
        if (input === null || input === "q" || input === "quit") break;
        if (input === "i") {
            console.log(JSON.stringify(state.inventory, null, 2));
            continue;
        }
        if (input === "v") {
            console.log(JSON.stringify(state.vars, null, 2));
            continue;
        }
        const choice = view.options[Number(input) - 1];
        if (!choice) {
            console.log(`Enter a number from 1 to ${view.options.length} (or i for inventory, v for variables, q to quit).`);
            continue;
        }
        try {
            state = step(content, state, choice.index, rng);
            show(content, state);
        } catch (e) {
            console.error(`\n${BOLD}Error:${RESET} ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    rl.close();
}

void main();