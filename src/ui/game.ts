import { loadContent, type SourceFile } from "../engine/load";
import { closeMap, defaultMapId, mapView, travel } from "../engine/map";
import { newGame, sceneView, step } from "../engine/step";
import type { OptionView } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";
import { listenForInput, type InputAction } from "./input";
import { createMapScreen, type MapScreenHandlers } from "./mapScreen";
import { settings } from "./settings";
import { canType, typeText } from "./typewriter";

export interface GamePage {
    story: HTMLElement;
    options: HTMLElement;
    status: HTMLElement;
    map: HTMLElement;
    mapButton: HTMLElement;
    background: HTMLElement; // everything behind the map screen
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
    let skipTyping: (() => void) | undefined;
    let usingKeyboard = false;
    const mapScreen = createMapScreen(page.map, page.background);
    function showScene(animate = true): void {
        if (state.screen.kind === "map") {
            openTravelMap();
            return;
        }
        mapScreen.hide();
        const view = sceneView(content, state, rng);
        visibleOptions = [];
        document.documentElement.dataset.theme = view.presentation.theme ?? "";
        page.story.innerHTML = textToHtml(view.latestEntry.text);
        page.options.replaceChildren();
        if (animate && canType() && settings.typingCharsPerSecond > 0) {
            skipTyping = typeText(page.story, settings.typingCharsPerSecond, () => {
                skipTyping = undefined;
                showOptions(view.options);
            }, settings.typingFadeMs);
        } else {
            showOptions(view.options);
        }
    }
    function showOptions(options: OptionView[]): void {
        visibleOptions = options;
        page.options.replaceChildren(...options.map(createOptionButton));
        if (options.length === 0) {
            page.options.innerHTML = '<p class="end">The end.</p>';
        } else if (usingKeyboard) {
            optionButtons()[0]?.focus({ preventScroll: true });
        }
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
        if (mapScreen.isOpen() || state.screen.kind !== "node" || mapId === undefined) return false;
        skipTyping?.();
        mapScreen.show(mapView(content, state, mapId, rng), { onClose: () => mapScreen.hide() });
        return true;
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
        usingKeyboard = true;
        if (mapScreen.isOpen()) return mapScreen.handleAction(action);
        if (action.kind === "map") return openReadOnlyMap();
        if (skipTyping) {
            if (action.kind !== "confirm") return false;
            skipTyping();
            return true;
        }
        switch (action.kind) {
            case "move":
                return moveSelection(action.step);
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
    document.addEventListener("click", () => skipTyping?.(), { capture: true });
    document.addEventListener("mousemove", event => {
        if (mouseMoved(event)) usingKeyboard = false;
    });
    document.addEventListener("pointerdown", () => {
        usingKeyboard = false;
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