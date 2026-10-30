import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import type { MapLocationView, MapView } from "../engine/types";
import { imageUrl } from "./images";
import type { InputAction } from "./input";

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
    let panzoom: PanzoomObject | undefined;
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
        startPanzoom();
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
        panzoom?.destroy();
        panzoom = undefined;
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

        // In the capture phase, because Panzoom stops this event before it can bubble up from the map.
        frame.addEventListener("pointerdown", event => {
            pressedAt = { x: event.clientX, y: event.clientY };
        }, { capture: true });
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
        const oldWidth = frame.offsetWidth;
        fitFrame();
        if (!panzoom || oldWidth === 0) return;
        const ratio = frame.offsetWidth / oldWidth;
        const pan = panzoom.getPan();
        panzoom.pan(pan.x * ratio, pan.y * ratio, { animate: false }); // the pan is in the map's own pixels, which just scaled
    }

    function startPanzoom(): void {
        const instance = Panzoom(canvas, { minScale: 1, maxScale: MAX_ZOOM, contain: "outside", cursor: "grab", step: 0.4 });
        // Zoom by how far the wheel turned, so a trackpad's many small events and a mouse's few big ones feel alike.
        frame.addEventListener("wheel", event => {
            event.preventDefault();
            const lines = event.deltaMode === 1 ? 16 : 1; // some mice scroll in lines rather than pixels
            const sensitivity = event.ctrlKey ? 0.01 : 0.002; // a trackpad pinch arrives as a wheel event with ctrl held
            const factor = Math.exp(-event.deltaY * lines * sensitivity);
            instance.zoomToPoint(instance.getScale() * factor, { clientX: event.clientX, clientY: event.clientY }, { animate: false });
        }, { passive: false });
        // Markers divide by the zoom, so they stay the same size on screen while the map grows.
        canvas.addEventListener("panzoomchange", event => {
            canvas.style.setProperty("--zoom", String((event as CustomEvent).detail.scale));
        });
        panzoom = instance;
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
        if (!marker || !panzoom) return;
        const frameBox = frame.getBoundingClientRect();
        const box = marker.getBoundingClientRect();
        const x = box.left;
        const y = box.top;
        const margin = 64;
        const visible = x > frameBox.left + margin && x < frameBox.right - margin && y > frameBox.top + margin && y < frameBox.bottom - margin;
        if (visible) return;

        const scale = panzoom.getScale();
        const pan = panzoom.getPan();
        const toCenterX = frameBox.left + frameBox.width / 2 - x;
        const toCenterY = frameBox.top + frameBox.height / 2 - y;
        panzoom.pan(pan.x + toCenterX / scale, pan.y + toCenterY / scale, { animate: true });
    }

    function moveSelection(step: 1 | -1): boolean {
        const count = view.locations.length;
        if (count === 0) return false;
        const current = view.locations.findIndex(l => l.id === selectedId);
        const next = current === -1 ? (step === 1 ? 0 : count - 1) : (current + step + count) % count;
        const id = view.locations[next]!.id;
        select(id);
        revealMarker(id);
        return true;
    }

    function handleAction(action: InputAction): boolean {
        switch (action.kind) {
            case "move":
                return moveSelection(action.step);
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
                if (action.step > 0) panzoom?.zoomIn();
                else panzoom?.zoomOut();
                return true;
            case "choose":
                return false;
        }
    }

    return { isOpen: () => open, show, hide, handleAction };
}
