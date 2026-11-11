import type { InputAction } from "./input";
import { createPanel } from "./panel";

/** A save, as the list of saves shows it. */
export interface SaveEntry {
    id: string;
    savedAt: string; // an ISO date and time
    node: string;
    text: string; // how the scene began
}

/** What happened when a save was loaded. */
export type LoadResult =
    | { kind: "loaded"; warnings: string[] } // the game is now the save's, and `warnings` says what had to be changed to fit it
    | { kind: "error"; message: string }
    | { kind: "mismatch"; saved: string; current: string; proceed(): LoadResult }; // from a different version of the game: loads only once it's asked to

/** What the menu needs the game to do. */
export interface MenuHost {
    /** Saving and loading, if there's anywhere to keep saves. */
    saves?: {
        list(): Promise<SaveEntry[]>; // the newest first
        loadSlot(id: string): Promise<LoadResult>;
        loadFile(): Promise<LoadResult | undefined>; // asks for a file, and loads it. Nothing if none was chosen
        exportSlot(id: string): Promise<void>;
        exportCurrent(): Promise<void>;
    };
    newGame(): void;
}

export interface MenuScreen {
    isOpen(): boolean;
    /** `launch` is when the game hasn't started yet, so that there's nothing behind the menu to go back to. `latest` is the save that Continue loads. */
    open(options?: { launch?: boolean; latest?: SaveEntry }): void;
    close(): void;
    handleAction(action: InputAction): boolean;
}

const MAX_WARNINGS_SHOWN = 8;

/** The menu, with the saves and a new game in it. Its views are a stack, and going back goes to the one before. */
export function createMenuScreen(root: HTMLElement, background: HTMLElement, host: MenuHost): MenuScreen {
    let launch = false;
    let latest: SaveEntry | undefined;
    let views: Array<() => void> = []; // how to draw each view, the one showing last
    let busy = false; // while something is being loaded or stored, so that a second click doesn't start another
    let renderId = 0; // so that a list of saves that arrives late doesn't draw over a view that has replaced it

    const panel = createPanel(root, background, { navigation: "focus", onDismiss: dismiss });

    function dismiss(): void {
        if (busy) return;
        if (views.length > 1) back();
        else if (!launch) close();
    }

    function back(): void {
        if (views.length <= 1) return;
        views.pop();
        views[views.length - 1]!();
    }

    function show(render: () => void): void {
        views.push(render);
        render();
    }

    function close(): void {
        views = [];
        launch = false;
        latest = undefined;
        busy = false;
        root.classList.remove("panel-locked");
        panel.close();
    }

    function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
        const created = document.createElement(tag);
        created.className = className;
        if (text !== undefined) created.textContent = text;
        return created;
    }

    function button(label: string, onClick: () => void, className = "menu-button"): HTMLButtonElement {
        const created = element("button", className, label);
        created.type = "button";
        created.addEventListener("click", () => {
            if (!busy) onClick();
        });
        return created;
    }

    function draw(title: string, ...content: HTMLElement[]): void {
        renderId++;
        panel.setTitle(title);
        panel.body.replaceChildren(...content);
        panel.body.scrollTop = 0;
        panel.focusFirst();
    }

    function when(savedAt: string): string {
        const date = new Date(savedAt);
        return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }

    function saveLabel(entry: SaveEntry): HTMLElement[] {
        return [element("span", "save-when", when(entry.savedAt)), element("span", "save-text", entry.text || entry.node)];
    }

    function renderRoot(): void {
        const items: HTMLElement[] = [];
        if (launch && latest) {
            const entry = latest;
            const continueButton = button("", () => void load(host.saves!.loadSlot(entry.id)));
            continueButton.append(element("span", "menu-main", "Continue"), ...saveLabel(entry));
            items.push(continueButton);
        }
        if (host.saves) items.push(button("Saves", () => show(renderSaves)));
        items.push(button("New game", () => (launch ? startNew() : show(renderNewGame))));
        draw("Menu", ...items);
    }

    function startNew(): void {
        close();
        host.newGame();
    }

    function renderNewGame(): void {
        draw(
            "New game",
            element("p", "menu-message", host.saves ? "Start again from the beginning? What you've done so far stays in your saves." : "Start again from the beginning? What you've done so far will be lost."),
            button("Start a new game", startNew),
            button("Cancel", back),
        );
    }

    function renderNotice(title: string, lines: string[], label: string, done: () => void): void {
        draw(title, ...lines.map(line => element("p", "menu-message", line)), button(label, done));
    }

    function renderSaves(): void {
        const id = renderId + 1; // the number this view will have, once it's drawn
        draw("Saves", element("p", "menu-message", "Loading…"));
        host.saves!.list().then(
            entries => {
                if (renderId !== id) return; // the player has moved on
                const items: HTMLElement[] = [];
                if (entries.length === 0) items.push(element("p", "menu-message", "There are no saves yet. The game saves itself after everything you do."));
                for (const entry of entries) {
                    const row = element("div", "save-row");
                    const loadButton = button("", () => void load(host.saves!.loadSlot(entry.id)), "menu-button save-load");
                    loadButton.append(...saveLabel(entry));
                    const exportButton = button("Export", () => void act(host.saves!.exportSlot(entry.id)), "menu-small save-export");
                    exportButton.setAttribute("aria-label", `Export the save from ${when(entry.savedAt)}`);
                    row.append(loadButton, exportButton);
                    items.push(row);
                }
                const actions = element("div", "save-actions");
                if (!launch) actions.append(button("Export this game", () => void act(host.saves!.exportCurrent()), "menu-small"));
                actions.append(button("Import a file…", () => void importFile(), "menu-small"), button("Back", back, "menu-small"));
                items.push(actions);
                draw("Saves", ...items);
            },
            error => {
                if (renderId !== id) return;
                renderNotice("Couldn't list the saves", [error instanceof Error ? error.message : String(error)], "OK", back);
            },
        );
    }

    // Something that takes a moment, and might go wrong.
    async function act(work: Promise<void>): Promise<void> {
        busy = true;
        try {
            await work;
        } catch (error) {
            busy = false;
            show(() => renderNotice("That didn't work", [error instanceof Error ? error.message : String(error)], "OK", back));
            return;
        }
        busy = false;
    }

    async function importFile(): Promise<void> {
        busy = true;
        let result: LoadResult | undefined;
        try {
            result = await host.saves!.loadFile();
        } catch (error) {
            busy = false;
            show(() => renderNotice("That didn't work", [error instanceof Error ? error.message : String(error)], "OK", back));
            return;
        }
        busy = false;
        if (result) handle(result);
    }

    async function load(loading: Promise<LoadResult>): Promise<void> {
        busy = true;
        let result: LoadResult;
        try {
            result = await loading;
        } catch (error) {
            busy = false;
            show(() => renderNotice("Couldn't load that save", [error instanceof Error ? error.message : String(error)], "OK", back));
            return;
        }
        busy = false;
        handle(result);
    }

    function handle(result: LoadResult): void {
        if (result.kind === "error") {
            show(() => renderNotice("Couldn't load that save", [result.message], "OK", back));
        } else if (result.kind === "mismatch") {
            const proceed = (): void => {
                views.pop(); // this question has been answered
                handle(result.proceed());
            };
            show(() => draw(
                "A different version",
                element("p", "menu-message", `This save was made with version ${result.saved} of the game, and this is version ${result.current}. It might not work properly.`),
                button("Load it anyway", proceed),
                button("Cancel", back),
            ));
        } else if (result.warnings.length > 0) {
            const shown = result.warnings.slice(0, MAX_WARNINGS_SHOWN);
            if (result.warnings.length > shown.length) shown.push(`…and ${result.warnings.length - shown.length} more.`);
            show(() => renderNotice("Loaded, with some changes", ["The game has changed since this was saved, so some things in it were adjusted:", ...shown], "Continue", close));
        } else {
            close();
        }
    }

    return {
        isOpen: panel.isOpen,
        open(options = {}) {
            if (panel.isOpen()) return;
            launch = options.launch === true;
            latest = options.latest;
            views = [];
            root.classList.toggle("panel-locked", launch); // no Close button, when there's nothing to close it to
            panel.open("Menu");
            show(renderRoot);
        },
        close,
        handleAction(action) {
            if (!panel.isOpen()) return false;
            if (action.kind === "menu") {
                dismiss();
                return true;
            }
            return panel.handleAction(action);
        },
    };
}
