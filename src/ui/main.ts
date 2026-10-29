import type { SourceFile } from "../engine/load";
import { startGame } from "./game";

const START_NODE = "start";

const files = import.meta.glob("/content/**/*.{yaml,story}", { query: "?raw", import: "default", eager: true });
const sources: SourceFile[] = Object.entries(files).map(([path, text]) => ({ path, text: text as string }));

function element(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (!found) throw new Error(`index.html has no element with id '${id}'`);
    return found;
}

startGame({ story: element("story"), options: element("options"), status: element("status") }, sources, START_NODE);