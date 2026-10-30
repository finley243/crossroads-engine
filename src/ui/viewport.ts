export interface ViewportOptions {
    minScale: number;
    maxScale: number;
}

export interface Viewport {
    resize(width: number, height: number): void;
    zoomBy(factor: number): void;
    panBy(dx: number, dy: number): void;
    destroy(): void;
}

const ANIMATION_MS = 180;

interface Point {
    x: number;
    y: number;
}

export function createViewport(surface: HTMLElement, frame: HTMLElement, canvas: HTMLElement, options: ViewportOptions): Viewport {
    let width = frame.clientWidth;
    let height = frame.clientHeight;
    let scale = 1;
    // from top-left corner
    let x = 0;
    let y = 0;
    let animation = 0;

    const pointers = new Map<number, Point>();
    let drag: { start: Point; x: number; y: number } | undefined;
    let pinch: { distance: number; scale: number; x: number; y: number; center: Point } | undefined;

    const clampScale = (s: number) => Math.min(options.maxScale, Math.max(options.minScale, s));

    function clampPosition(): void {
        x = Math.min(0, Math.max(width - width * scale, x));
        y = Math.min(0, Math.max(height - height * scale, y));
    }

    function apply(): void {
        canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        canvas.style.setProperty("--zoom", String(scale));
    }

    function zoomAbout(newScale: number, px: number, py: number): void {
        const clamped = clampScale(newScale);
        const ratio = clamped / scale;
        x = px - (px - x) * ratio;
        y = py - (py - y) * ratio;
        scale = clamped;
        clampPosition();
    }

    function stopAnimation(): void {
        cancelAnimationFrame(animation);
    }

    function animateTo(target: { scale: number; x: number; y: number }): void {
        stopAnimation();
        const from = { scale, x, y };
        let startTime: number | undefined;
        const step = (now: number) => {
            startTime ??= now;
            const t = Math.min(1, (now - startTime) / ANIMATION_MS);
            const eased = 1 - (1 - t) ** 3;
            scale = from.scale + (target.scale - from.scale) * eased;
            x = from.x + (target.x - from.x) * eased;
            y = from.y + (target.y - from.y) * eased;
            apply();
            if (t < 1) animation = requestAnimationFrame(step);
        };
        animation = requestAnimationFrame(step);
    }

    function inFrame(clientX: number, clientY: number): Point {
        const box = frame.getBoundingClientRect();
        return { x: clientX - box.left - frame.clientLeft, y: clientY - box.top - frame.clientTop };
    }

    function firstTwo(): [Point, Point] {
        const [a, b] = [...pointers.values()];
        return [a!, b!];
    }

    function startGesture(): void {
        drag = undefined;
        pinch = undefined;
        if (pointers.size === 1) {
            const [start] = [...pointers.values()];
            drag = { start: start!, x, y };
        } else if (pointers.size >= 2) {
            const [a, b] = firstTwo();
            pinch = {
                distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
                scale,
                x,
                y,
                center: inFrame((a.x + b.x) / 2, (a.y + b.y) / 2),
            };
        }
    }

    function onPointerDown(event: PointerEvent): void {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        stopAnimation();
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        startGesture();
    }

    function onPointerMove(event: PointerEvent): void {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinch) {
            const [a, b] = firstTwo();
            const center = inFrame((a.x + b.x) / 2, (a.y + b.y) / 2);
            const newScale = clampScale((pinch.scale * Math.hypot(b.x - a.x, b.y - a.y)) / pinch.distance);
            const mapX = (pinch.center.x - pinch.x) / pinch.scale;
            const mapY = (pinch.center.y - pinch.y) / pinch.scale;
            scale = newScale;
            x = center.x - mapX * newScale;
            y = center.y - mapY * newScale;
        } else if (drag) {
            const current = pointers.get(event.pointerId)!;
            x = drag.x + (current.x - drag.start.x);
            y = drag.y + (current.y - drag.start.y);
        } else {
            return;
        }
        clampPosition();
        apply();
    }

    function onPointerUp(event: PointerEvent): void {
        if (!pointers.delete(event.pointerId)) return;
        startGesture();
    }

    function onWheel(event: WheelEvent): void {
        event.preventDefault();
        stopAnimation();
        const lines = event.deltaMode === 1 ? 16 : 1; // some mice scroll in lines rather than pixels
        const sensitivity = event.ctrlKey ? 0.01 : 0.002; // a trackpad pinch arrives as a wheel event with ctrl held
        const point = inFrame(event.clientX, event.clientY);
        zoomAbout(scale * Math.exp(-event.deltaY * lines * sensitivity), point.x, point.y);
        apply();
    }

    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    apply();

    return {
        resize(newWidth, newHeight) {
            x *= newWidth / width;
            y *= newHeight / height;
            width = newWidth;
            height = newHeight;
            clampPosition();
            apply();
        },
        zoomBy(factor) {
            const target = clampScale(scale * factor);
            const ratio = target / scale;
            const toX = width / 2 - (width / 2 - x) * ratio;
            const toY = height / 2 - (height / 2 - y) * ratio;
            animateTo({
                scale: target,
                x: Math.min(0, Math.max(width - width * target, toX)),
                y: Math.min(0, Math.max(height - height * target, toY)),
            });
        },
        panBy(dx, dy) {
            animateTo({
                scale,
                x: Math.min(0, Math.max(width - width * scale, x + dx)),
                y: Math.min(0, Math.max(height - height * scale, y + dy)),
            });
        },
        destroy() {
            stopAnimation();
            surface.removeEventListener("pointerdown", onPointerDown);
            surface.removeEventListener("wheel", onWheel);
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
            document.removeEventListener("pointercancel", onPointerUp);
        },
    };
}