import type { MapLocationView, MapView } from "../engine/types";
import { imageUrl } from "./images";
import type { Direction, InputAction } from "./input";
import { nearest, neighbor } from "./spatialNav";
import { createViewport, type Viewport } from "./viewport";

export interface MapScreenHandlers {
    onTravel?: (locationId: string) => void; // only given when the player can travel from this map
    onClose?: () => void; // not given when the map has to be used to travel
}

export interface MapScreen {
    isOpen(): boolean;
    show(view: MapView, handlers: MapScreenHandlers): void;
    hide(): void;
    handleAction(action: InputAction): boolean;
}

const MAX_ZOOM = 5;
const FRAME_MARGIN = 24; // pixels kept free around the map
const DRAG_TOLERANCE = 6; // a click that moved further than this was really a drag

/** The map as a full-screen overlay: the image with a marker per location, which can be panned and zoomed. */
export function createMapScreen(root: HTMLElement, background: HTMLElement): MapScreen {
    let open = false;
    let view: MapView;
    let handlers: MapScreenHandlers;
    let viewport: Viewport | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let selectedId: string | undefined;
    let pressedAt = { x: 0, y: 0 };
    let fittedTo = { width: 0, height: 0 }; // the size of the area the frame was last fitted to
    const markers = new Map<string, HTMLButtonElement>();

    let area: HTMLElement, frame: HTMLElement, canvas: HTMLElement;
    let infoName: HTMLElement, infoDescription: HTMLElement, infoNote: HTMLElement, travelButton: HTMLButtonElement, closeButton: HTMLButtonElement;

    function show(newView: MapView, newHandlers: MapScreenHandlers): void {
        hide();
        view = newView;
        handlers = newHandlers;
        selectedId = undefined;
        buildPage();
        root.hidden = false;
        background.inert = true; // so tabbing and clicking can't reach the game behind the map
        open = true;

        fitFrame();
        viewport = createViewport(area, frame, canvas, { minScale: 1, maxScale: MAX_ZOOM });
        resizeObserver = new ResizeObserver(() => {
            if (area.clientWidth !== fittedTo.width || area.clientHeight !== fittedTo.height) refitFrame();
        });
        resizeObserver.observe(area);
        showInfo();
        root.focus();
    }

    function hide(): void {
        if (!open) return;
        open = false;
        resizeObserver?.disconnect();
        viewport?.destroy();
        viewport = undefined;
        markers.clear();
        root.replaceChildren();
        root.hidden = true;
        background.inert = false;
    }

    function buildPage(): void {
        root.innerHTML = `
            <div class="map-area">
                <div class="map-frame"><div class="map-canvas"><img class="map-image" alt="" draggable="false"></div></div>
            </div>
            <div class="map-panel">
                <div class="map-info"><h2></h2><p></p><p class="map-info-note"></p></div>
                <div class="map-actions"><button class="map-travel" type="button">Travel</button><button class="map-close" type="button"></button></div>
            </div>`;
        area = root.querySelector(".map-area")!;
        frame = root.querySelector(".map-frame")!;
        canvas = root.querySelector(".map-canvas")!;
        infoName = root.querySelector(".map-info h2")!;
        infoDescription = root.querySelector(".map-info p")!;
        infoNote = root.querySelector(".map-info-note")!;
        travelButton = root.querySelector(".map-travel")!;
        closeButton = root.querySelector(".map-close")!;

        const image = root.querySelector<HTMLImageElement>(".map-image")!;
        image.addEventListener("error", () => canvas.classList.add("no-image")); // a grid stands in for a missing image
        image.src = imageUrl(view.image);

        for (const location of view.locations) {
            const marker = document.createElement("button");
            marker.type = "button";
            marker.className = "map-marker" + (location.current ? " current" : "") + (location.locked ? " locked" : "");
            marker.style.setProperty("--x", String(location.x / view.width));
            marker.style.setProperty("--y", String(location.y / view.height));
            marker.setAttribute("aria-label", location.current ? `${location.name} (you are here)` : location.locked ? `${location.name} (locked)` : location.name);
            marker.innerHTML = '<span class="map-marker-dot"></span><span class="map-marker-label"></span>';
            marker.querySelector(".map-marker-label")!.textContent = location.name;
            marker.addEventListener("click", event => {
                if (event.detail > 0 && draggedSincePress(event)) return; // keyboard clicks have no detail
                select(location.id);
            });
            marker.addEventListener("focus", () => select(location.id));
            markers.set(location.id, marker);
            canvas.append(marker);
        }

        frame.addEventListener("pointerdown", event => {
            pressedAt = { x: event.clientX, y: event.clientY };
        });
        travelButton.hidden = handlers.onTravel === undefined;
        travelButton.addEventListener("click", travelToSelected);
        closeButton.textContent = handlers.onTravel ? "Cancel" : "Close";
        closeButton.hidden = handlers.onClose === undefined;
        closeButton.addEventListener("click", () => handlers.onClose?.());
    }

    function draggedSincePress(event: MouseEvent): boolean {
        return Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > DRAG_TOLERANCE;
    }

    // The frame is the map's shape, as large as fits; zooming happens inside it.
    function fitFrame(): void {
        const scale = Math.min((area.clientWidth - FRAME_MARGIN) / view.width, (area.clientHeight - FRAME_MARGIN) / view.height);
        frame.style.width = `${Math.max(1, Math.floor(view.width * scale))}px`;
        frame.style.height = `${Math.max(1, Math.floor(view.height * scale))}px`;
        fittedTo = { width: area.clientWidth, height: area.clientHeight };
    }

    // The window changed size. The map gets resized to fit, and keeps the same zoom and the same part in view.
    function refitFrame(): void {
        fitFrame();
        viewport?.resize(frame.clientWidth, frame.clientHeight);
    }

    function select(id: string): void {
        if (selectedId === id) return;
        selectedId = id;
        markers.forEach((marker, markerId) => marker.classList.toggle("selected", markerId === id));
        showInfo();
    }

    function selectedLocation(): MapLocationView | undefined {
        return view.locations.find(l => l.id === selectedId);
    }

    function showInfo(): void {
        const location = selectedLocation();
        infoName.textContent = location ? location.name : "";
        infoDescription.textContent = location
            ? location.description
            : handlers.onTravel ? "Choose where to go." : "Select a place to read about it.";
        infoNote.textContent = !location ? "" : location.current ? "You are here." : location.locked ? location.lockedNote || "You can't go there yet." : "";
        travelButton.disabled = !location?.travelable;
    }

    function travelToSelected(): void {
        const location = selectedLocation();
        if (location?.travelable) handlers.onTravel?.(location.id);
    }

    // Keep a marker chosen with the keyboard in view, panning to it if it's near or past the edge.
    function revealMarker(id: string): void {
        const marker = markers.get(id);
        if (!marker || !viewport) return;
        const frameBox = frame.getBoundingClientRect();
        const box = marker.getBoundingClientRect();
        const margin = 64;
        const visible = box.left > frameBox.left + margin && box.left < frameBox.right - margin && box.top > frameBox.top + margin && box.top < frameBox.bottom - margin;
        if (visible) return;
        viewport.panBy(frameBox.left + frameBox.width / 2 - box.left, frameBox.top + frameBox.height / 2 - box.top);
    }

    // Move to the marker that's that way on the map. With nothing selected yet, this starts from the player's own
    // location (or the middle of the map), and always selects something.
    function moveSelection(direction: Direction): boolean {
        const places = view.locations;
        if (places.length === 0) return false;
        const selected = places.find(l => l.id === selectedId);
        const start = selected ?? places.find(l => l.current);
        const from = start ?? { x: view.width / 2, y: view.height / 2 };
        const next = neighbor(from, places, direction, start?.id) ?? (selected ? undefined : nearest(from, places, start?.id));
        if (next) {
            select(next.id);
            revealMarker(next.id);
        }
        return true;
    }

    function handleAction(action: InputAction): boolean {
        switch (action.kind) {
            case "move":
                return moveSelection(action.direction);
            case "confirm": {
                const location = selectedLocation();
                if (!handlers.onTravel || !location?.travelable) return false;
                travelToSelected();
                return true;
            }
            case "cancel":
                if (!handlers.onClose) return false;
                handlers.onClose();
                return true;
            case "map":
                if (handlers.onTravel || !handlers.onClose) return false; // the map the story opened is closed with cancel
                handlers.onClose();
                return true;
            case "zoom":
                viewport?.zoomBy(Math.exp(0.4 * action.step));
                return true;
            case "choose":
                return false;
        }
    }

    return { isOpen: () => open, show, hide, handleAction };
}
