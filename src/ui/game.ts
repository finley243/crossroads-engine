import { loadContent } from "../engine/load";
import type { SourceFile } from "../engine/loadTypes";
import { closeMap, defaultMapId, mapView, travel } from "../engine/map";
import { newGame, ROLL_ACCEPT, sceneView, step } from "../engine/step";
import type { OptionView, RollView } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";
import { availablePages, pageView } from "../engine/pages";
import { createHistoryScreen } from "./historyScreen";
import { createPageScreen } from "./pageScreen";
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
}

const rng = Math.random;

export function startGame(page: GamePage, sources: SourceFile[], startNode: string): void {
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
    function showScene(animate = true): void {
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
            showRoll(view.roll, view.options); // the scene itself has been read already, so it isn't typed again
            return;
        }
        document.defaultView?.scrollTo({ top: 0, behavior: "instant" }); // a long scene starts at its beginning
        if (animate && canType() && settings.typingCharsPerSecond > 0) {
            skipTyping = typeText(page.story, settings.typingCharsPerSecond, () => {
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
    function showRoll(roll: RollView, options: OptionView[]): void {
        const card = createRollCard(roll);
        page.options.replaceChildren(card.element);
        const accept = options.find(o => o.index === ROLL_ACCEPT)!;
        let revealed = false;
        const finish = card.reveal(() => {
            revealed = true;
            if (roll.canReroll) {
                skipTyping = undefined;
                showOptions(options, true);
                return;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const proceed = (): void => {
                clearTimeout(timer);
                skipTyping = undefined;
                choose(accept);
            };
            const wait = (): void => {
                // Not while the player is looking at the map or the history.
                timer = setTimeout(() => (mapScreen.isOpen() || historyScreen.isOpen() || pageScreen.isOpen() ? wait() : proceed()), settings.rollHoldMs);
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
        showScene();
    }
    // The map the story opened, which the player can travel from.
    function openTravelMap(): void {
        if (state.screen.kind !== "map") return;
        const handlers: MapScreenHandlers = {
            onTravel: locationId => attempt(() => {
                state = travel(content, state, locationId, rng);
                showScene();
            }),
        };
        // A map the story doesn't allow canceling has no way out except traveling.
        if (state.screen.cancelable) {
            handlers.onClose = () => attempt(() => {
                state = closeMap(state);
                showScene(false); // the player has already read this scene
            });
        }
        mapScreen.show(mapView(content, state, state.screen.map, rng), handlers);
    }
    // A look at the map the player is near, at any time. It never changes the game.
    function openReadOnlyMap(): boolean {
        const mapId = defaultMapId(content, state, rng);
        if (mapScreen.isOpen() || historyScreen.isOpen() || pageScreen.isOpen() || state.screen.kind !== "node" || mapId === undefined) return false;
        if (!rollInProgress) skipTyping?.(); // a roll that's being revealed carries on behind the map
        mapScreen.show(mapView(content, state, mapId, rng), { onClose: () => mapScreen.hide() });
        return true;
    }
    // The earlier scenes, which the player can look back through at any time. It never changes the game.
    function openHistory(): boolean {
        if (mapScreen.isOpen() || historyScreen.isOpen() || pageScreen.isOpen() || state.history.length <= 1) return false;
        if (!rollInProgress) skipTyping?.(); // a roll that's being revealed carries on behind the history
        historyScreen.show(state.history.slice(0, -1)); // everything before the scene that's showing
        return true;
    }
    // A page: text such as a journal, worked out from the game as it is now. It never changes the game.
    function openPage(title: string): boolean {
        if (mapScreen.isOpen() || historyScreen.isOpen() || pageScreen.isOpen() || state.screen.kind !== "node") return false;
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
        if (mapScreen.isOpen()) return mapScreen.handleAction(action);
        if (historyScreen.isOpen()) return historyScreen.handleAction(action);
        if (pageScreen.isOpen()) return pageScreen.handleAction(action);
        if (action.kind === "map") return openReadOnlyMap();
        if (action.kind === "history") return openHistory();
        if (action.kind === "hotkey") return openPageByKey(action.key);
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
            case "cancel":
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
    document.addEventListener("click", event => {
        // Opening the map or the history doesn't hurry a roll along: it waits for the player to come back.
        const target = event.target as Node | null;
        if (rollInProgress && target && corner.contains(target)) return;
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
    showScene();
}

function mouseMoved(event: MouseEvent): boolean {
    return event.movementX !== 0 || event.movementY !== 0;
}

function showProblems(page: GamePage, problems: string[]): void {
    page.story.innerHTML = '<p class="problems"></p>';
    page.story.firstElementChild!.textContent = problems.join("\n");
    page.options.replaceChildren();
}