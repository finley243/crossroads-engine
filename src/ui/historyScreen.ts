import type { HistoryEntry } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";
import type { InputAction } from "./input";

export interface HistoryScreen {
    isOpen(): boolean;
    /** Opens the history with these entries, the newest at the bottom, where it starts. */
    show(entries: HistoryEntry[]): void;
    hide(): void;
    /** Scrolls the list, for input with no way to do it itself, like a gamepad's stick. */
    scrollBy(pixels: number): void;
    handleAction(action: InputAction): boolean;
}

const LINE_STEP = 80; // pixels for an arrow key or a d-pad press
const PAGE_STEP = 0.85; // the fraction of the list's height for a page up or down

/** The earlier scenes in an overlay, like the map. Its list scrolls by itself, whatever scrolls it. */
export function createHistoryScreen(root: HTMLElement, background: HTMLElement): HistoryScreen {
    root.innerHTML = `
        <div class="panel">
            <div class="panel-head"><h2 class="panel-title">History</h2><button class="panel-close" type="button">Close</button></div>
            <div class="history-log" role="log" aria-live="off" aria-label="Earlier scenes" tabindex="0">
                <p class="history-empty">Nothing here yet.</p>
                <div class="history-entries"></div>
            </div>
        </div>`;
    const log = root.querySelector<HTMLElement>(".history-log")!;
    const entries = root.querySelector<HTMLElement>(".history-entries")!;
    const empty = root.querySelector<HTMLElement>(".history-empty")!;
    const closeButton = root.querySelector<HTMLButtonElement>(".panel-close")!;
    let open = false;
    let keys: number[] = []; // identifies each entry in the list, to tell whether the list matches the game
    let focusBefore: Element | null = null;

    function entryHtml(entry: HistoryEntry): string {
        const choice = entry.option ? `<p class="history-choice">${inlineHtml(entry.option)}</p>` : "";
        return `<div class="history-entry">${choice}${textToHtml(entry.text)}</div>`;
    }

    function keyOf(entry: HistoryEntry): number {
        const text = `${entry.node}\0${entry.option ?? ""}\0${entry.text}`;
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    // Entries come and go at the end, so it's enough to check the last one that's on both sides. The list is only
    // brought up to date when it's opened, so the game doesn't do any of this work while it's closed.
    function sync(list: HistoryEntry[]): void {
        const common = Math.min(list.length, keys.length);
        if (common > 0 && keys[common - 1] !== keyOf(list[common - 1]!)) {
            entries.innerHTML = list.map(entryHtml).join("");
            keys = list.map(keyOf);
        } else if (list.length > keys.length) {
            const added = list.slice(keys.length);
            entries.insertAdjacentHTML("beforeend", added.map(entryHtml).join(""));
            keys.push(...added.map(keyOf));
        } else if (list.length < keys.length) {
            for (let i = keys.length; i > list.length; i--) entries.lastElementChild?.remove();
            keys.length = list.length;
        }
        empty.hidden = list.length > 0;
    }

    function show(list: HistoryEntry[]): void {
        if (open) return;
        sync(list);
        focusBefore = document.activeElement;
        root.hidden = false;
        background.inert = true; // so tabbing and clicking can't reach the game behind it
        document.documentElement.classList.add("screen-open");
        open = true;
        log.scrollTop = log.scrollHeight;
        log.focus({ preventScroll: true }); // so that page up and down, and the other keys that scroll, work
    }

    function hide(): void {
        if (!open) return;
        open = false;
        root.hidden = true;
        background.inert = false;
        document.documentElement.classList.remove("screen-open");
        if (focusBefore instanceof HTMLElement && focusBefore.isConnected) focusBefore.focus({ preventScroll: true });
        focusBefore = null;
    }

    function scrollBy(pixels: number): void {
        if (typeof log.scrollBy === "function") log.scrollBy({ top: pixels, behavior: "smooth" });
        else log.scrollTop += pixels;
    }

    function handleAction(action: InputAction): boolean {
        switch (action.kind) {
            case "cancel":
            case "history":
                hide();
                return true;
            case "move":
                if (action.direction === "up") scrollBy(-LINE_STEP);
                else if (action.direction === "down") scrollBy(LINE_STEP);
                return true; // so that the page behind doesn't scroll as well
            case "zoom":
                scrollBy(action.step * log.clientHeight * PAGE_STEP); // the gamepad's bumpers page through it
                return true;
            default:
                return false; // page up and down, home, end and space scroll the focused list by themselves
        }
    }

    closeButton.addEventListener("click", hide);
    root.addEventListener("click", event => {
        if (event.target === root) hide(); // a click on the dimmed area outside the panel
    });

    return { isOpen: () => open, show, hide, scrollBy, handleAction };
}
