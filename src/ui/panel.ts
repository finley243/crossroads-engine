import type { InputAction } from "./input";

export interface Panel {
    /** Where the content goes. */
    body: HTMLElement;
    isOpen(): boolean;
    /** Shows the panel, scrolled to the top. `closeKey` is a letter that closes it again, if it was opened by one. */
    open(title: string, closeKey?: string): void;
    close(): void;
    /** Scrolls the content, for input with no way to do it itself, like a gamepad's stick. */
    scrollBy(pixels: number): void;
    handleAction(action: InputAction): boolean;
}

const LINE_STEP = 80; // pixels for an arrow key or a d-pad press
const PAGE_STEP = 0.85; // the fraction of the panel's height for a page up or down

/** A dialog over the game with a title and a Close button, and content that scrolls by itself, whatever scrolls it. */
export function createPanel(root: HTMLElement, background: HTMLElement): Panel {
    root.innerHTML = `
        <div class="panel">
            <div class="panel-head"><h2 class="panel-title" id="${root.id}-title"></h2><button class="panel-close" type="button">Close</button></div>
            <div class="panel-body" tabindex="0"></div>
        </div>`;
    root.setAttribute("aria-labelledby", `${root.id}-title`);
    const heading = root.querySelector<HTMLElement>(".panel-title")!;
    const body = root.querySelector<HTMLElement>(".panel-body")!;
    let isOpen = false;
    let focusBefore: Element | null = null;
    let closeKey: string | undefined;

    function open(title: string, key?: string): void {
        if (isOpen) return;
        heading.textContent = title;
        closeKey = key;
        focusBefore = document.activeElement;
        root.hidden = false;
        background.inert = true; // so tabbing and clicking can't reach the game behind it
        document.documentElement.classList.add("screen-open");
        isOpen = true;
        body.scrollTop = 0;
        body.focus({ preventScroll: true }); // so that page up and down, and the other keys that scroll, work
    }

    function close(): void {
        if (!isOpen) return;
        isOpen = false;
        root.hidden = true;
        background.inert = false;
        document.documentElement.classList.remove("screen-open");
        if (focusBefore instanceof HTMLElement && focusBefore.isConnected) focusBefore.focus({ preventScroll: true });
        focusBefore = null;
    }

    function scrollBy(pixels: number): void {
        if (typeof body.scrollBy === "function") body.scrollBy({ top: pixels, behavior: "smooth" });
        else body.scrollTop += pixels;
    }

    function handleAction(action: InputAction): boolean {
        switch (action.kind) {
            case "cancel":
                close();
                return true;
            case "hotkey":
                if (action.key !== closeKey) return false;
                close();
                return true;
            case "move":
                if (action.direction === "up") scrollBy(-LINE_STEP);
                else if (action.direction === "down") scrollBy(LINE_STEP);
                return true; // so that the page behind doesn't scroll as well
            case "zoom":
                scrollBy(action.step * body.clientHeight * PAGE_STEP); // the gamepad's bumpers page through it
                return true;
            default:
                return false; // page up and down, home, end and space scroll the focused content by themselves
        }
    }

    root.querySelector<HTMLButtonElement>(".panel-close")!.addEventListener("click", close);
    root.addEventListener("click", event => {
        if (event.target === root) close(); // a click on the dimmed area outside the panel
    });

    return { body, isOpen: () => isOpen, open, close, scrollBy, handleAction };
}
