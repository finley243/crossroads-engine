// Usage: npm start -- <content folder> <start node>

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadContent } from "../engine/load";
import { closeMap, defaultMapId, mapView, travel } from "../engine/map";
import { availablePages, pageView } from "../engine/pages";
import { newGame, ROLL_ACCEPT, sceneView, SCENE_BREAK, step } from "../engine/step";
import type { Content, GameState, MapLocationView, MapView, PageView, RollView } from "../engine/types";
import { LITERAL_ASTERISK } from "../engine/scan";
import type { SourceFile } from "../engine/loadTypes";


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

function showPage(view: PageView): void {
    console.log(`\n${BOLD}${view.title}${RESET}`);
    if (view.text) console.log(`\n${style(view.text)}`);
    for (const section of view.sections) console.log(`\n${BOLD}${section.title.toUpperCase()}${RESET}\n${style(section.text)}`);
    if (!view.text && view.sections.length === 0) console.log(`\n${DIM}Nothing here yet.${RESET}`);
}

function rollLine({ chance, success, attempt }: RollView): string {
    return `${DIM}Roll${attempt > 1 ? " (re-rolled)" : ""}, ${chance}%:${RESET} ${success ? "success" : "failure"}`;
}

// A roll that has nothing to decide is accepted for the player, once they've seen how it went.
function settleRolls(content: Content, state: GameState): GameState {
    for (;;) {
        const roll = sceneView(content, state, rng).roll;
        if (!roll || roll.canReroll) return state;
        console.log(`\n${rollLine(roll)}`);
        state = step(content, state, ROLL_ACCEPT, rng);
    }
}

function show(content: Content, state: GameState): void {
    const view = sceneView(content, state, rng);
    console.log();
    if (view.roll) {
        // The scene has already been shown; what's new is the roll, which is waiting to be accepted or re-rolled.
        console.log(`${rollLine(view.roll)}\n`);
    } else {
        if (view.latestEntry.option) console.log(`${DIM}› ${view.latestEntry.option}${RESET}\n`);
        if (view.latestEntry.text) console.log(style(view.latestEntry.text) + "\n");
    }
    view.options.forEach((option, i) => console.log(`  ${i + 1}. ${style(option.label)}`));
}

function showMap(view: MapView, canTravel: boolean, cancelable = true): MapLocationView[] {
    console.log(`\n${BOLD}Map: ${view.name}${RESET}${view.name === view.id ? "" : ` ${DIM}(${view.id})${RESET}`}`);
    if (view.parent) console.log(`${DIM}  Up to ${view.parent.name}: m ${view.parent.map}${RESET}`);
    const destinations = canTravel ? view.locations.filter(location => location.travelable) : [];
    for (const location of view.locations) {
        const notes = [location.current ? "you are here" : location.locked ? "locked" : "", location.opens ? `opens ${location.opens.name}: m ${location.opens.map}` : ""].filter(Boolean);
        const here = notes.length > 0 ? ` ${DIM}(${notes.join(", ")})${RESET}` : "";
        const detail = location.locked && location.lockedNote ? location.lockedNote : location.description;
        const description = detail ? ` ${DIM}- ${detail}${RESET}` : "";
        const number = destinations.indexOf(location) + 1;
        console.log(`  ${number > 0 ? `${number}.` : "- "} ${location.name}${here}${description}`);
    }
    if (canTravel && cancelable) console.log(`  ${destinations.length + 1}. Cancel`);
    return destinations;
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
        if (state.screen.kind === "map") {
            const map = mapView(content, state, state.screen.map, rng);
            const cancelable = state.screen.cancelable;
            const destinations = showMap(map, true, cancelable);
            const input = await ask();
            if (input === null || input === "q" || input === "quit") break;
            const number = Number(input);
            try {
                if (cancelable && number === destinations.length + 1) {
                    state = closeMap(state);
                    show(content, state);
                } else if (destinations[number - 1]) {
                    state = travel(content, state, destinations[number - 1]!.id, rng);
                    show(content, state);
                } else {
                    console.log(`Enter a number from 1 to ${destinations.length + (cancelable ? 1 : 0)} (or q to quit).`);
                }
            } catch (e) {
                console.error(`\n${BOLD}Error:${RESET} ${e instanceof Error ? e.message : String(e)}`);
            }
            continue;
        }
        const view = sceneView(content, state, rng);
        if (view.options.length === 0) {
            console.log(`${DIM}(No options left. The end.)${RESET}`);
            break;
        }
        const input = await ask();
        if (input === null || input === "q" || input === "quit") break;
        if (input === "v") {
            console.log(JSON.stringify(state.vars, null, 2));
            continue;
        }
        if (input === "p" || input.startsWith("p ")) {
            const pages = availablePages(content, state, rng);
            const wanted = input.slice(1).trim();
            const found = pages[Number(wanted) - 1] ?? pages.find(summary => summary.title.toLowerCase() === wanted.toLowerCase() || summary.key === wanted);
            if (pages.length === 0) console.log("There are no pages yet.");
            else if (wanted === "") pages.forEach((summary, i) => console.log(`  p ${i + 1}. ${summary.title}${summary.key ? ` (${summary.key})` : ""}`));
            else if (found) showPage(pageView(content, state, found.title, rng)!);
            else console.log(`There's no page '${wanted}' right now (p lists them).`);
            continue;
        }
        if (input === "m" || input.startsWith("m ")) {
            // "m" is the map the player is at; "m name" is any map, which is for looking at what the player can reach
            const wanted = input.slice(1).trim().toLowerCase();
            const mapId = wanted === "" ? defaultMapId(content, state, rng) : Object.values(content.maps).find(map => map.id.toLowerCase() === wanted || map.name.toLowerCase() === wanted)?.id;
            if (mapId) showMap(mapView(content, state, mapId, rng), false);
            else console.log(wanted === "" ? "There are no maps." : `There's no map '${wanted}' (the maps are ${Object.keys(content.maps).join(", ")}).`);
            continue;
        }
        const choice = view.options[Number(input) - 1];
        if (!choice) {
            console.log(`Enter a number from 1 to ${view.options.length} (or v for variables, m for the map, p for pages, q to quit).`);
            continue;
        }
        try {
            state = settleRolls(content, step(content, state, choice.index, rng));
            if (state.screen.kind === "node") show(content, state); // a map is shown by the next pass of the loop
        } catch (e) {
            console.error(`\n${BOLD}Error:${RESET} ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    rl.close();
}

void main();