import type { PageView } from "../engine/types";
import { inlineHtml, textToHtml } from "./formatText";
import type { InputAction } from "./input";
import { createPanel } from "./panel";

export interface PageScreen {
    isOpen(): boolean;
    /** Opens a page. `key` is the letter that opened it, so that the same letter closes it. */
    show(view: PageView, key?: string): void;
    hide(): void;
    scrollBy(pixels: number): void;
    handleAction(action: InputAction): boolean;
}

/** A page, like a journal or a stat sheet, in an overlay. */
export function createPageScreen(root: HTMLElement, background: HTMLElement): PageScreen {
    const panel = createPanel(root, background);

    function pageHtml(view: PageView): string {
        const sections = view.sections.map(section => `<section class="page-section"><h3>${inlineHtml(section.title)}</h3>${textToHtml(section.text)}</section>`);
        const html = (view.text ? textToHtml(view.text) : "") + sections.join("");
        return html === "" ? '<p class="panel-empty">Nothing here yet.</p>' : html;
    }

    return {
        isOpen: panel.isOpen,
        show(view, key) {
            panel.body.innerHTML = pageHtml(view);
            panel.open(view.title, key);
        },
        hide: panel.close,
        scrollBy: panel.scrollBy,
        handleAction: panel.handleAction,
    };
}
