export type InputAction =
    | { kind: "move"; step: 1 | -1 }
    | { kind: "confirm" }
    | { kind: "choose"; position: number };

export function listenForInput(handle: (action: InputAction) => boolean): void {
    document.addEventListener("keydown", event => {
        const action = keyboardAction(event);
        if (!action) return;
        const ignored = event.repeat && action.kind !== "move";
        if (ignored || handle(action)) event.preventDefault();
    });
}

function keyboardAction(event: KeyboardEvent): InputAction | undefined {
    if (event.ctrlKey || event.altKey || event.metaKey) return undefined;
    switch (event.key) {
        case "ArrowDown":
            return { kind: "move", step: 1 };
        case "ArrowUp":
            return { kind: "move", step: -1 };
        case "Enter":
        case " ":
            return { kind: "confirm" };
    }
    if (/^[1-9]$/.test(event.key)) return { kind: "choose", position: Number(event.key) - 1 };
    return undefined;
}