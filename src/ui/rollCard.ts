import type { RollView } from "../engine/types";
import { inlineHtml } from "./formatText";
import { settings } from "./settings";

const GLYPHS = "#%&@$?*+=<>/\\|~0123456789";

// The flickering is only decoration, so it has its own random numbers and never touches the game's dice.
let seed = (Math.floor(performance.now() * 1000) | 0) || 1;
function decoration(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
}
const FRAME_MS = 45;
const LOCK_FROM = 0.6; // the word only starts to settle in the last part of the reveal, so the first letters don't give it away

export interface RollCard {
    element: HTMLElement;
    /** Reveals the result, calling onSettled once it's showing. Returns a function that finishes the reveal at once. */
    reveal(onSettled: () => void): () => void;
}

/** The result of a roll, which decodes out of random characters. */
export function createRollCard(roll: RollView): RollCard {
    const element = document.createElement("div");
    element.className = "roll-card rolling";
    element.setAttribute("role", "status");
    const label = document.createElement("div"); // what the player chose, since the options have gone while the roll is shown
    label.className = "roll-label";
    label.innerHTML = inlineHtml(roll.label);
    const word = document.createElement("div");
    word.className = "roll-word";
    word.setAttribute("aria-hidden", "true"); // the characters flickering past aren't worth reading out
    const announcement = document.createElement("span");
    announcement.className = "sr-only";
    element.append(label, word, announcement);

    const result = roll.success ? "SUCCESS" : "FAILURE";
    const glyph = () => GLYPHS[Math.floor(decoration() * GLYPHS.length)]!;
    const scrambled = (settled: number) => result.slice(0, settled) + Array.from({ length: result.length - settled }, glyph).join("");

    function reveal(onSettled: () => void): () => void {
        let done = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const finish = (): void => {
            if (done) return;
            done = true;
            if (timer !== undefined) clearInterval(timer);
            word.textContent = result;
            element.classList.remove("rolling");
            element.classList.add(roll.success ? "success" : "failure");
            announcement.textContent = `The roll ${roll.success ? "succeeded" : "failed"}${roll.oddsHidden ? "" : `, at ${roll.chance}% chance`}${roll.attempt > 1 ? ", re-rolled" : ""}.`;
            onSettled();
        };
        const duration = prefersReducedMotion() ? 0 : settings.rollRevealMs;
        if (duration <= 0) {
            finish();
            return finish;
        }
        const started = performance.now();
        word.textContent = scrambled(0);
        timer = setInterval(() => {
            const progress = (performance.now() - started) / duration;
            if (progress >= 1) return finish();
            word.textContent = scrambled(progress < LOCK_FROM ? 0 : Math.floor(((progress - LOCK_FROM) / (1 - LOCK_FROM)) * result.length));
        }, FRAME_MS);
        return finish;
    }

    return { element, reveal };
}

function prefersReducedMotion(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
