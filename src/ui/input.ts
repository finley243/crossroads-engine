export type Direction = "up" | "down" | "left" | "right";

export type InputAction =
    | { kind: "move"; direction: Direction }
    | { kind: "confirm" }
    | { kind: "choose"; position: number }
    | { kind: "cancel" } // back out of a screen
    | { kind: "zoom"; step: 1 | -1 }
    | { kind: "map" }; // look at the map

export function listenForInput(handle: (action: InputAction) => boolean): void {
    document.addEventListener("keydown", event => {
        const action = keyboardAction(event);
        if (!action) return;
        const ignored = event.repeat && action.kind !== "move" && action.kind !== "zoom";
        if (ignored || handle(action)) event.preventDefault();
    });
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
    }
    if (/^[1-9]$/.test(event.key)) return { kind: "choose", position: Number(event.key) - 1 };
    return undefined;
}