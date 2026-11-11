import { condition, evaluateProse, finishText, type EvalContext } from "./evaluate";
import type { Content, GameState, PageSummary, PageView, Prose, Rng } from "./types";

// The keys that already do something in the game, which a page can't use. Keep this to match src/ui/input.ts.
export const RESERVED_PAGE_KEYS: Record<string, string> = {
    m: "the map",
    h: "the history",
};

/** The pages the player can open right now, in the order they were written. */
export function availablePages(content: Content, state: GameState, rng: Rng): PageSummary[] {
    const ctx: EvalContext = { content, state, rng };
    return Object.values(content.pages)
        .filter(page => !page.when || condition(page.when, ctx))
        .map(page => {
            const summary: PageSummary = { title: page.title, label: page.tab ?? page.title };
            if (page.key) summary.key = page.key;
            return summary;
        });
}

/** A page's text, worked out from the state of the game now. It never changes the game. */
export function pageView(content: Content, state: GameState, title: string, rng: Rng): PageView | undefined {
    const page = content.pages[title];
    const ctx: EvalContext = { content, state, rng };
    if (!page || (page.when && !condition(page.when, ctx))) return undefined;
    const text = (prose: Prose): string => finishText(evaluateProse(prose, ctx).text).trim();
    const sections = page.sections
        .filter(section => !section.when || condition(section.when, ctx))
        .map(section => ({ title: section.title, text: text(section.text) }))
        .filter(section => section.text !== ""); // a section with nothing to say right now isn't shown
    return { title: page.title, text: text(page.text), sections };
}
