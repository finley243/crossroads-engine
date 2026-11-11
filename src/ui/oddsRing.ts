const NAMESPACE = "http://www.w3.org/2000/svg";
const STROKE = 2;

/** A thin ring that fills clockwise from the top, as far as the chance of a roll: a picture of the odds with no number in it. */
export function createOddsRing(chance: number, size = 20): SVGSVGElement {
    const radius = (size - STROKE) / 2 - 0.5;
    const circumference = 2 * Math.PI * radius;
    const middle = size / 2;
    const svg = document.createElementNS(NAMESPACE, "svg");
    svg.setAttribute("class", "odds-ring");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("aria-hidden", "true"); // the number is in text for a screen reader
    svg.setAttribute("focusable", "false");
    const circle = (className: string): SVGCircleElement => {
        const element = document.createElementNS(NAMESPACE, "circle");
        element.setAttribute("class", className);
        element.setAttribute("cx", String(middle));
        element.setAttribute("cy", String(middle));
        element.setAttribute("r", String(radius));
        element.setAttribute("fill", "none");
        element.setAttribute("stroke-width", String(STROKE));
        return element;
    };
    const arc = circle("odds-arc");
    const filled = (Math.min(100, Math.max(0, chance)) / 100) * circumference;
    arc.setAttribute("stroke-dasharray", `${Math.round(filled * 10) / 10} ${Math.round(circumference * 10) / 10}`);
    arc.setAttribute("transform", `rotate(-90 ${middle} ${middle})`);
    svg.append(circle("odds-track"), arc);
    return svg;
}
