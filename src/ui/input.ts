export type Direction = "up" | "down" | "left" | "right";

export type InputAction =
    | { kind: "move"; direction: Direction }
    | { kind: "confirm" }
    | { kind: "choose"; position: number }
    | { kind: "cancel" } // back out of a screen
    | { kind: "zoom"; step: 1 | -1 }
    | { kind: "map" } // look at the map
    | { kind: "history" } // look at the earlier scenes
    | { kind: "hotkey"; key: string } // a letter that isn't used for anything else, in lower case, which a page can ask for
    | { kind: "menu" }; // the gamepad's start button

export function listenForInput(handle: (action: InputAction) => boolean): void {
    document.addEventListener("keydown", event => {
        const action = keyboardAction(event);
        if (!action) return;
        const ignored = event.repeat && action.kind !== "move" && action.kind !== "zoom";
        if (ignored || handle(action)) event.preventDefault();
    });
    const previousButtons = new Map<number, Set<number>>(); // track which buttons on gamepad were already pressed
    function pollGamepads(): void {
        const currentButtons = new Map<number, Set<number>>();
        for (const gamepad of navigator.getGamepads()) {
            if (!gamepad?.connected) continue;
            const pressed = new Set<number>();
            const previous = previousButtons.get(gamepad.index) ?? new Set<number>();
            gamepad.buttons.forEach((button, index) => {
                if (!button.pressed) return;
                pressed.add(index);
                if (!previous.has(index)) {
                    const action = gamepadAction(index);
                    if (action) handle(action);
                }
            });
            currentButtons.set(gamepad.index, pressed);
        }
        previousButtons.clear();
        for (const [index, buttons] of currentButtons) {
            previousButtons.set(index, buttons);
        }
        requestAnimationFrame(pollGamepads);
    }
    requestAnimationFrame(pollGamepads);
}

function keyboardAction(event: KeyboardEvent): InputAction | undefined {
    if (event.ctrlKey || event.altKey || event.metaKey) return undefined;
    switch (event.key) {
        case "ArrowDown":
            return { kind: "move", direction: "down" };
        case "ArrowUp":
            return { kind: "move", direction: "up" };
        case "ArrowLeft":
            return { kind: "move", direction: "left" };
        case "ArrowRight":
            return { kind: "move", direction: "right" };
        case "Enter":
        case " ":
            return { kind: "confirm" };
        case "Escape":
            return { kind: "cancel" };
        case "+":
        case "=":
            return { kind: "zoom", step: 1 };
        case "-":
        case "_":
            return { kind: "zoom", step: -1 };
        case "m":
        case "M":
            return { kind: "map" };
        case "h":
        case "H":
            return { kind: "history" };
    }
    if (/^[1-9]$/.test(event.key)) return { kind: "choose", position: Number(event.key) - 1 };
    if (/^[a-zA-Z]$/.test(event.key)) return { kind: "hotkey", key: event.key.toLowerCase() };
    return undefined;
}

function gamepadAction(button: number): InputAction | undefined {
    switch (button) {
        case 0: return { kind: "confirm" };
        case 1: return { kind: "cancel" };
        case 2: return { kind: "history" };
        case 3: return { kind: "map" };
        case 4: return { kind: "zoom", step: -1 };
        case 5: return { kind: "zoom", step: 1 };
        case 8: return { kind: "history" }; // the view or back button
        case 9: return { kind: "menu" }; // the start button
        case 12: return { kind: "move", direction: "up" };
        case 13: return { kind: "move", direction: "down" };
        case 14: return { kind: "move", direction: "left" };
        case 15: return { kind: "move", direction: "right" };
    }
    return undefined;
}