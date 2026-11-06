import type { SourceFile } from "../engine/loadTypes";
import { startGame } from "./game";

const START_NODE = "start";

const files = import.meta.glob("/content/**/*.{yaml,story}", { query: "?raw", import: "default", eager: true });
const sources: SourceFile[] = Object.entries(files).map(([path, text]) => ({ path, text: text as string }));

function element(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (!found) throw new Error(`index.html has no element with id '${id}'`);
    return found;
}

startGame({
    story: element("story"),
    options: element("options"),
    status: element("status"),
    map: element("map-screen"),
    mapButton: element("map-button"),
    background: element("page"),
    history: {
        root: element("history"),
        entries: element("history-entries"),
        scene: element("game"),
        story: element("story"),
        options: element("options"),
        hint: element("history-hint"),
        now: element("history-now"),
    },
}, sources, START_NODE);