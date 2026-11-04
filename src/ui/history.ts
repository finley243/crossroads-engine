import type { HistoryEntry } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";

export interface HistoryElements {
    root: HTMLElement; // the earlier scenes and the gap below them; hidden while there's nothing earlier
    entries: HTMLElement; // the earlier scenes
    scene: HTMLElement; // the current scene (the page's <main>)
    story: HTMLElement;
    options: HTMLElement;
    hint: HTMLElement; // says there's more above, while resting on the scene
    now: HTMLElement; // takes you back to the scene from far up in the history
}

export interface HistoryView {
    /** Show these as the earlier scenes, above the current one. Entries are normally added or removed at the end. */
    sync(entries: HistoryEntry[]): void;
    /** Put the current scene at the top of the screen, at once. Call this after the scene itself has been shown. */
    showCurrentScene(): void;
    /** Whether the view is up in the history, above the current scene. */
    isAway(): boolean;
}

export function createHistory(el: HistoryElements): HistoryView {
    const win = document.defaultView!;
    try {
        win.history.scrollRestoration = "manual"; // a reload shouldn't leave the page halfway up the history
    } catch {
        // not available everywhere, and not needed
    }

    let keys: number[] = []; // identifies each entry that's on the page, to tell whether the page matches the state
    let rest = 0; // scroll position with the current scene at the top of the screen
    let arrival = 0; // scroll position with the end of the history at the bottom of the screen
    let frame = 0;

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

    function sync(entries: HistoryEntry[]): void {
        // Entries come and go at the end, so it's enough to check the last one that's on both sides.
        const common = Math.min(entries.length, keys.length);
        if (common > 0 && keys[common - 1] !== keyOf(entries[common - 1]!)) {
            el.entries.innerHTML = entries.map(entryHtml).join("");
            keys = entries.map(keyOf);
        } else if (entries.length > keys.length) {
            const added = entries.slice(keys.length);
            el.entries.insertAdjacentHTML("beforeend", added.map(entryHtml).join(""));
            keys.push(...added.map(keyOf));
        } else if (entries.length < keys.length) {
            for (let i = keys.length; i > entries.length; i--) el.entries.lastElementChild?.remove();
            keys.length = entries.length;
        }
        const any = entries.length > 0;
        el.root.hidden = !any;
        document.documentElement.classList.toggle("has-history", any);
    }

    function measure(): void {
        rest = el.scene.getBoundingClientRect().top + win.scrollY;
        arrival = Math.max(0, el.entries.getBoundingClientRect().bottom + win.scrollY - win.innerHeight);
    }

    function update(): void {
        if (el.root.hidden) {
            for (const target of [el.root, el.story, el.options]) {
                target.style.removeProperty("opacity");
                target.style.removeProperty("transform");
            }
            el.hint.hidden = true;
            el.now.hidden = true;
            return;
        }
        const above = rest - win.scrollY;
        const depth = above < 2 ? 0 : Math.min(1, above / Math.max(1, rest - arrival));
        el.root.style.opacity = (0.2 + depth * 0.8).toFixed(3);
        el.hint.hidden = false;
        el.hint.style.opacity = Math.max(0, 0.5 - depth * 4).toFixed(3);
        el.now.hidden = win.scrollY > rest - win.innerHeight;
        if (depth === 0) {
            el.story.style.removeProperty("opacity");
            el.options.style.removeProperty("opacity");
            el.options.style.removeProperty("transform");
        } else {
            el.story.style.opacity = (1 - depth * 0.65).toFixed(3);
            el.options.style.opacity = Math.max(0, 1 - depth * 1.4).toFixed(3);
            el.options.style.transform = `translateY(${(depth * 56).toFixed(1)}px)`;
        }
    }

    function showCurrentScene(): void {
        measure();
        win.scrollTo({ top: rest, behavior: "instant" });
        update();
    }

    win.addEventListener("scroll", () => {
        if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; update(); });
    }, { passive: true });

    function resized(): void {
        const wasAtRest = Math.abs(win.scrollY - rest) < 2;
        const previousRest = rest;
        measure();
        if (wasAtRest && Math.abs(rest - previousRest) >= 1) win.scrollTo({ top: rest, behavior: "instant" });
        update();
    }
    win.addEventListener("resize", resized);
    if (typeof win.ResizeObserver !== "undefined") {
        const observer = new win.ResizeObserver(resized);
        observer.observe(el.entries);
        observer.observe(el.scene);
    }

    el.now.addEventListener("click", () => win.scrollTo({ top: rest, behavior: "smooth" }));

    function isAway(): boolean {
        return !el.root.hidden && win.scrollY < rest - 2;
    }

    return { sync, showCurrentScene, isAway };
}
