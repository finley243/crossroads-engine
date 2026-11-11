import { loadContent } from "../engine/load";
import type { SourceFile } from "../engine/loadTypes";
import { closeMap, defaultMapId, mapView, travel } from "../engine/map";
import { readSave, restoreSave, versionMismatch, writeSave } from "../engine/save";
import { newGame, ROLL_ACCEPT, sceneView, step } from "../engine/step";
import type { GameState, OptionView, RollView } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";
import { availablePages, pageView } from "../engine/pages";
import { createAutosaver } from "./autosave";
import { createHistoryScreen } from "./historyScreen";
import { createMenuScreen, type LoadResult, type MenuHost, type SaveEntry } from "./menuScreen";
import { createPageScreen } from "./pageScreen";
import type { SavePlatform } from "./platform";
import type { StoredSave } from "./saveStore";
import { listenForInput, type InputAction } from "./input";
import { createMapScreen, type MapScreenHandlers } from "./mapScreen";
import { createRollCard } from "./rollCard";
import { settings } from "./settings";
import { canType, typeText } from "./typewriter";

export interface GamePage {
    story: HTMLElement;
    options: HTMLElement;
    status: HTMLElement;
    map: HTMLElement;
    mapButton: HTMLElement;
    background: HTMLElement; // everything behind the map and history screens
    historyScreen: HTMLElement;
    historyButton: HTMLElement;
    pageScreen: HTMLElement;
    menuScreen: HTMLElement;
    menuButton: HTMLElement;
}

const rng = Math.random;

/** `platform` is what keeps saves. Without one, the game is never saved, and there's no saves screen. */
export function startGame(page: GamePage, sources: SourceFile[], startNode: string, platform?: SavePlatform): void {
    const { content, errors } = loadContent(sources);
    if (errors.length > 0) {
        showProblems(page, errors.map(e => `${e.file}:${e.line}: ${e.message}`));
        return;
    }
    if (!content.nodes[startNode]) {
        showProblems(page, [`There's no node called '${startNode}'.`]);
        return;
    }
    let state = newGame(content, startNode, rng);
    let sceneToken = 0; // changes with every scene, so that what was waiting on the one before (its typing, a roll's reveal and pause) does nothing
    let visibleOptions: OptionView[] = [];
    let skipTyping: (() => void) | undefined; // what a click or Enter does while something is still going on: typing, or a roll being revealed
    let rollInProgress = false;
    let usingKeyboard = false;
    function setUsingKeyboard(value: boolean): void {
        usingKeyboard = value;
        document.documentElement.classList.toggle("keyboard-nav", value); // hides the mouse cursor, until the mouse is used
    }
    const mapScreen = createMapScreen(page.map, page.background);
    const historyScreen = createHistoryScreen(page.historyScreen, page.background);
    const pageScreen = createPageScreen(page.pageScreen, page.background);
    const corner = page.historyButton.parentElement!; // where the buttons for the map, the history, and the pages are
    const pageButtons = new Map<string, HTMLButtonElement>();
    const autosaver = platform && createAutosaver(platform.store, content, message => (page.status.textContent = message));
    const menuScreen = createMenuScreen(page.menuScreen, page.background, createMenuHost());
    function overlayOpen(): boolean {
        return mapScreen.isOpen() || historyScreen.isOpen() || pageScreen.isOpen() || menuScreen.isOpen();
    }
    // Every action that changes the game goes through here: the game is saved after it, and then it's shown.
    function commit(animate = true): void {
        autosaver?.save(state);
        showScene(animate);
    }
    function showScene(animate = true): void {
        const token = ++sceneToken;
        if (state.screen.kind === "map") {
            openTravelMap();
            return;
        }
        mapScreen.hide();
        const view = sceneView(content, state, rng);
        syncPageButtons();
        visibleOptions = [];
        document.documentElement.dataset.theme = view.presentation.theme ?? "";
        page.historyButton.hidden = state.history.length <= 1; // there's nothing to look at until a scene has been left behind
        page.story.innerHTML = textToHtml(view.latestEntry.text);
        page.options.replaceChildren();
        rollInProgress = view.roll !== undefined;
        if (view.roll) {
            showRoll(view.roll, view.options, token); // the scene itself has been read already, so it isn't typed again
            return;
        }
        document.defaultView?.scrollTo({ top: 0, behavior: "instant" }); // a long scene starts at its beginning
        if (animate && canType() && settings.typingCharsPerSecond > 0) {
            skipTyping = typeText(page.story, settings.typingCharsPerSecond, () => {
                if (token !== sceneToken) return;
                skipTyping = undefined;
                showOptions(view.options);
            }, settings.typingFadeMs);
        } else {
            showOptions(view.options);
        }
    }
    function showOptions(options: OptionView[], belowRoll = false): void {
        visibleOptions = options;
        const buttons = options.map(createOptionButton);
        if (belowRoll) page.options.append(...buttons);
        else page.options.replaceChildren(...buttons);
        if (options.length === 0) {
            page.options.innerHTML = '<p class="end">The end.</p>';
        } else if (usingKeyboard && !belowRoll) {
            // Not under a roll, though: a second press of the key that chose the roll mustn't spend a re-roll.
            optionButtons()[0]?.focus({ preventScroll: true });
        }
    }
    // A roll that hasn't been accepted yet: its result is revealed, and the player can re-roll a failure or accept it.
    // When there's nothing to decide, it carries on by itself after a moment.
    function showRoll(roll: RollView, options: OptionView[], token: number): void {
        const card = createRollCard(roll);
        page.options.replaceChildren(card.element);
        const accept = options.find(o => o.index === ROLL_ACCEPT)!;
        let revealed = false;
        const finish = card.reveal(() => {
            revealed = true;
            if (token !== sceneToken) return;
            if (roll.canReroll) {
                skipTyping = undefined;
                showOptions(options, true);
                return;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const proceed = (): void => {
                clearTimeout(timer);
                if (token !== sceneToken) return;
                skipTyping = undefined;
                choose(accept);
            };
            const wait = (): void => {
                // Not while the player is looking at the map, the history, a page, or the menu.
                timer = setTimeout(() => (token !== sceneToken ? undefined : overlayOpen() ? wait() : proceed()), settings.rollHoldMs);
            };
            wait();
            skipTyping = proceed;
        });
        if (!revealed) skipTyping = finish;
    }
    function optionButtons(): HTMLButtonElement[] {
        return [...page.options.querySelectorAll("button")];
    }
    function createOptionButton(option: OptionView, position: number): HTMLButtonElement {
        const button = document.createElement("button");
        button.innerHTML = `<span class="option-number">${position + 1}</span>${inlineHtml(option.label)}`;
        button.style.setProperty("--position", String(position));
        button.addEventListener("click", () => choose(option));
        button.addEventListener("mousemove", event => {
            if (!mouseMoved(event)) return;
            if (document.activeElement !== button) button.focus({ preventScroll: true });
        });
        return button;
    }
    function choose(option: OptionView): void {
        page.status.textContent = "";
        try {
            state = step(content, state, option.index, rng);
        } catch (e) {
            page.status.textContent = e instanceof Error ? e.message : String(e);
            return;
        }
        commit();
    }
    // The map the story opened, which the player can travel from.
    function openTravelMap(): void {
        if (state.screen.kind !== "map") return;
        const handlers: MapScreenHandlers = {
            onTravel: locationId => attempt(() => {
                state = travel(content, state, locationId, rng);
                commit();
            }),
        };
        // A map the story doesn't allow canceling has no way out except traveling.
        if (state.screen.cancelable) {
            handlers.onClose = () => attempt(() => {
                state = closeMap(state);
                commit(false); // the player has already read this scene
            });
        }
        mapScreen.show(mapView(content, state, state.screen.map, rng), handlers);
    }
    // A look at the map the player is near, at any time. It never changes the game.
    function openReadOnlyMap(): boolean {
        const mapId = defaultMapId(content, state, rng);
        if (overlayOpen() || state.screen.kind !== "node" || mapId === undefined) return false;
        if (!rollInProgress) skipTyping?.(); // a roll that's being revealed carries on behind the map
        mapScreen.show(mapView(content, state, mapId, rng), { onClose: () => mapScreen.hide() });
        return true;
    }
    // The earlier scenes, which the player can look back through at any time. It never changes the game.
    function openHistory(): boolean {
        if (overlayOpen() || state.history.length <= 1) return false;
        if (!rollInProgress) skipTyping?.(); // a roll that's being revealed carries on behind the history
        historyScreen.show(state.history.slice(0, -1)); // everything before the scene that's showing
        return true;
    }
    // A page: text such as a journal, worked out from the game as it is now. It never changes the game.
    function openPage(title: string): boolean {
        if (overlayOpen() || state.screen.kind !== "node") return false;
        const view = pageView(content, state, title, rng);
        if (!view) return false;
        if (!rollInProgress) skipTyping?.(); // a roll that's being revealed carries on behind the page
        pageScreen.show(view, content.pages[title]!.key);
        return true;
    }
    function openPageByKey(key: string): boolean {
        const found = availablePages(content, state, rng).find(summary => summary.key === key);
        return found ? openPage(found.title) : false;
    }
    // One button for each page that's available now, in the order they were written, before the history and the map.
    function syncPageButtons(): void {
        const pages = availablePages(content, state, rng);
        const wanted = new Set(pages.map(summary => summary.title));
        for (const [title, button] of pageButtons) {
            if (wanted.has(title)) continue;
            button.remove();
            pageButtons.delete(title);
        }
        for (const summary of pages) {
            let button = pageButtons.get(summary.title);
            if (!button) {
                const title = summary.title;
                button = document.createElement("button");
                button.type = "button";
                button.addEventListener("click", () => openPage(title));
                pageButtons.set(title, button);
            }
            button.textContent = summary.label;
            if (summary.key) button.setAttribute("aria-keyshortcuts", summary.key);
            corner.insertBefore(button, page.historyButton);
        }
    }
    // The menu, and what it can ask the game to do. It never changes the game except by replacing it with another.
    function openMenu(): boolean {
        if (overlayOpen()) return false;
        if (!rollInProgress) skipTyping?.(); // a roll that's being revealed carries on behind the menu
        menuScreen.open();
        return true;
    }
    // Carries on from a different game: a new one, or a save. What was waiting on the old scene does nothing any more.
    function replaceGame(next: GameState, animate: boolean): void {
        sceneToken++;
        skipTyping?.();
        skipTyping = undefined;
        state = next;
        mapScreen.hide();
        page.status.textContent = "";
        showScene(animate);
    }
    function entryOf(saved: StoredSave): SaveEntry {
        return { id: saved.id, savedAt: saved.header.savedAt, node: saved.header.summary.node, text: saved.header.summary.text };
    }
    function loadText(text: string): LoadResult {
        const failed = (e: unknown): LoadResult => ({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        let file;
        try {
            file = readSave(text);
        } catch (e) {
            return failed(e);
        }
        const apply = (): LoadResult => {
            try {
                const restored = restoreSave(content, file, rng); // the game isn't touched until this has worked
                replaceGame(restored.state, false);
                return { kind: "loaded", warnings: restored.warnings };
            } catch (e) {
                return failed(e);
            }
        };
        const mismatch = versionMismatch(content, file);
        return mismatch ? { kind: "mismatch", ...mismatch, proceed: apply } : apply();
    }
    function fileName(when: Date): string {
        const pad = (n: number): string => String(n).padStart(2, "0");
        return `save-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}.json`;
    }
    function createMenuHost(): MenuHost {
        const host: MenuHost = { newGame: () => replaceGame(newGame(content, startNode, rng), true) };
        if (!platform || !autosaver) return host;
        const missing = async (): Promise<never> => {
            throw new Error("That save isn't there any more.");
        };
        host.saves = {
            async list() {
                await autosaver.flush();
                const saves = await platform.store.list();
                return saves.sort((a, b) => b.header.savedAt.localeCompare(a.header.savedAt)).map(entryOf);
            },
            async loadSlot(id) {
                await autosaver.flush();
                const text = await platform.store.read(id);
                return text === undefined ? { kind: "error", message: "That save isn't there any more." } : loadText(text);
            },
            async loadFile() {
                const text = await platform.importFile();
                return text === undefined ? undefined : loadText(text);
            },
            async exportSlot(id) {
                const text = await platform.store.read(id);
                if (text === undefined) return missing();
                await platform.exportFile(fileName(new Date()), text);
            },
            async exportCurrent() {
                await platform.exportFile(fileName(new Date()), writeSave(content, state));
            },
        };
        return host;
    }
    // Where the game starts: a new game, unless there are saves, in which case the player is asked what they want.
    function begin(): void {
        if (!autosaver) {
            showScene();
            return;
        }
        autosaver.latest().then(
            saved => {
                if (saved) menuScreen.open({ launch: true, latest: entryOf(saved) });
                else showScene();
            },
            error => {
                page.status.textContent = `The saves couldn't be read: ${error instanceof Error ? error.message : String(error)}`;
                showScene();
            },
        );
    }
    function attempt(action: () => void): void {
        page.status.textContent = "";
        try {
            action();
        } catch (e) {
            page.status.textContent = e instanceof Error ? e.message : String(e);
        }
    }
    function handleAction(action: InputAction): boolean {
        setUsingKeyboard(true);
        if (menuScreen.isOpen()) return menuScreen.handleAction(action);
        if (mapScreen.isOpen()) return mapScreen.handleAction(action);
        if (historyScreen.isOpen()) return historyScreen.handleAction(action);
        if (pageScreen.isOpen()) return pageScreen.handleAction(action);
        if (action.kind === "map") return openReadOnlyMap();
        if (action.kind === "history") return openHistory();
        if (action.kind === "hotkey") return openPageByKey(action.key);
        if (action.kind === "cancel" || action.kind === "menu") return openMenu();
        if (skipTyping) {
            if (action.kind !== "confirm") return false;
            skipTyping();
            return true;
        }
        switch (action.kind) {
            case "move":
                return moveSelection(action.direction === "down" || action.direction === "right" ? 1 : -1);
            case "confirm": {
                const selected = optionButtons().find(button => button === document.activeElement);
                selected?.click();
                return selected !== undefined;
            }
            case "choose": {
                const option = visibleOptions[action.position];
                if (option) choose(option);
                return option !== undefined;
            }
            case "zoom":
                return false;
        }
    }
    function moveSelection(step: 1 | -1): boolean {
        const buttons = optionButtons();
        if (buttons.length === 0) return false;
        const current = buttons.findIndex(button => button === document.activeElement);
        const next = current === -1 ? (step === 1 ? 0 : buttons.length - 1) : (current + step + buttons.length) % buttons.length;
        buttons[next]!.focus();
        return true;
    }
    page.mapButton.addEventListener("click", () => openReadOnlyMap());
    page.historyButton.addEventListener("click", () => openHistory());
    page.menuButton.addEventListener("click", () => openMenu());
    document.addEventListener("click", event => {
        // A click that isn't for the scene doesn't hurry it along: one inside the map, the history, a page, or the menu,
        // or on the button that opens one while a roll is being shown, which waits for the player to come back.
        const target = event.target as Node | null;
        if (overlayOpen() || (rollInProgress && target && corner.contains(target))) return;
        skipTyping?.();
    }, { capture: true });
    document.addEventListener("mousemove", event => {
        if (mouseMoved(event)) setUsingKeyboard(false);
    });
    document.addEventListener("pointerdown", event => {
        setUsingKeyboard(false);
        // Focus a button as soon as it's pressed, since that's what highlights it. Touch screens (and Safari) only
        // focus it later, after the press has ended, by which time the click has already changed the screen.
        const button = event.target instanceof Element ? event.target.closest("button:not(.map-marker)") : null;
        if (button instanceof HTMLButtonElement && !button.disabled) button.focus({ preventScroll: true });
    });
    listenForInput(handleAction);
    begin();
}

function mouseMoved(event: MouseEvent): boolean {
    return event.movementX !== 0 || event.movementY !== 0;
}

function showProblems(page: GamePage, problems: string[]): void {
    page.story.innerHTML = '<p class="problems"></p>';
    page.story.firstElementChild!.textContent = problems.join("\n");
    page.options.replaceChildren();
}