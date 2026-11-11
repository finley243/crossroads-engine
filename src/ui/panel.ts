import type { InputAction } from "./input";

export interface PanelOptions {
    /** What the arrow keys do: scroll the content (the default), or move between its buttons, for a menu. */
    navigation?: "scroll" | "focus";
    /** What the Close button, Escape, and a click outside the panel do. By default they close it. */
    onDismiss?: () => void;
}

export interface Panel {
    /** Where the content goes. */
    body: HTMLElement;
    isOpen(): boolean;
    /** Shows the panel, scrolled to the top. `closeKey` is a letter that closes it again, if it was opened by one. */
    open(title: string, closeKey?: string): void;
    setTitle(title: string): void;
    /** Puts the focus on the first button in the content, for a menu. */
    focusFirst(): void;
    close(): void;
    /** Scrolls the content, for input with no way to do it itself, like a gamepad's stick. */
    scrollBy(pixels: number): void;
    handleAction(action: InputAction): boolean;
}

const LINE_STEP = 80; // pixels for an arrow key or a d-pad press
const PAGE_STEP = 0.85; // the fraction of the panel's height for a page up or down

/** A dialog over the game with a title and a Close button, and content that scrolls by itself, whatever scrolls it. */
export function createPanel(root: HTMLElement, background: HTMLElement, options: PanelOptions = {}): Panel {
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

    function setTitle(title: string): void {
        heading.textContent = title;
    }

    function buttons(): HTMLElement[] {
        return [...body.querySelectorAll<HTMLElement>("button:not([disabled])")];
    }

    function focusFirst(): void {
        (buttons()[0] ?? body).focus({ preventScroll: true });
    }

    function moveFocus(step: 1 | -1): void {
        const items = buttons();
        if (items.length === 0) return;
        const current = items.findIndex(item => item === document.activeElement);
        const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
        items[next]!.focus({ preventScroll: false });
    }

    function dismiss(): void {
        if (options.onDismiss) options.onDismiss();
        else close();
    }

    function scrollBy(pixels: number): void {
        if (typeof body.scrollBy === "function") body.scrollBy({ top: pixels, behavior: "smooth" });
        else body.scrollTop += pixels;
    }

    function handleAction(action: InputAction): boolean {
        switch (action.kind) {
            case "cancel":
                dismiss();
                return true;
            case "confirm": {
                const focused = document.activeElement;
                if (options.navigation !== "focus" || !(focused instanceof HTMLButtonElement) || !body.contains(focused)) return false;
                focused.click(); // a gamepad's confirm button, which has no key to press the focused button with
                return true;
            }
            case "hotkey":
                if (action.key !== closeKey) return false;
                close();
                return true;
            case "move":
                if (options.navigation === "focus") {
                    if (action.direction === "up" || action.direction === "down") moveFocus(action.direction === "down" ? 1 : -1);
                } else if (action.direction === "up") scrollBy(-LINE_STEP);
                else if (action.direction === "down") scrollBy(LINE_STEP);
                return true; // so that the page behind doesn't scroll as well
            case "zoom":
                scrollBy(action.step * body.clientHeight * PAGE_STEP); // the gamepad's bumpers page through it
                return true;
            default:
                return false; // page up and down, home, end and space scroll the focused content by themselves
        }
    }

    root.querySelector<HTMLButtonElement>(".panel-close")!.addEventListener("click", dismiss);
    root.addEventListener("click", event => {
        if (event.target === root) dismiss(); // a click on the dimmed area outside the panel
    });

    return { body, isOpen: () => isOpen, open, setTitle, focusFirst, close, scrollBy, handleAction };
}
