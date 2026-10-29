import { loadContent, type SourceFile } from "../engine/load";
import { newGame, sceneView, step } from "../engine/step";
import type { OptionView } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";
import { settings } from "./settings";
import { canType, typeText } from "./typewriter";

export interface GamePage {
    story: HTMLElement;
    options: HTMLElement;
    status: HTMLElement;
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
    function showScene(): void {
        const view = sceneView(content, state, rng);
        visibleOptions = [];
        document.documentElement.dataset.theme = view.presentation.theme ?? "";
        page.story.innerHTML = textToHtml(view.latestEntry.text);
        page.options.replaceChildren();
        if (canType() && settings.typingCharsPerSecond > 0) {
            skipTyping = typeText(page.story, settings.typingCharsPerSecond, () => {
                skipTyping = undefined;
                showOptions(view.options);
            });
        } else {
            showOptions(view.options);
        }
    }
    function showOptions(options: OptionView[]): void {
        visibleOptions = options;
        page.options.replaceChildren(...options.map(createOptionButton));
        if (options.length === 0) {
            page.options.innerHTML = '<p class="end">The end.</p>';
        }
    }
    function createOptionButton(option: OptionView, position: number): HTMLButtonElement {
        const button = document.createElement("button");
        button.innerHTML = `<span class="option-number">${position + 1}</span>${inlineHtml(option.label)}`;
        button.addEventListener("click", () => choose(option));
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
    page.story.addEventListener("click", () => skipTyping?.());
    document.addEventListener("keydown", event => {
        if (skipTyping && event.key === " ") {
            event.preventDefault();
            skipTyping();
            return;
        }
        const option = visibleOptions[Number(event.key) - 1];
        if (option) choose(option);
    });
    showScene();
}

function showProblems(page: GamePage, problems: string[]): void {
    page.story.innerHTML = '<p class="problems"></p>';
    page.story.firstElementChild!.textContent = problems.join("\n");
    page.options.replaceChildren();
}