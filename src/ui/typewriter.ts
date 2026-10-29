const HIGHLIGHT_NAME = "unrevealed";
const SENTENCE_PAUSE_MULT = 8;
const SENTENCE_CHARS = ".!?…";
const CLAUSE_PAUSE_MULT = 4;
const CLAUSE_CHARS = ",;:—";

export function canType(): boolean {
    return typeof CSS !== "undefined" && "highlights" in CSS;
}

export function typeText(container: HTMLElement, charsPerSecond: number, onDone: () => void): () => void {
    const textNodes = collectTextNodes(container);
    const msPerChar = 1000 / charsPerSecond;
    let animationFrame = 0;
    let finished = false;
    function finish(): void {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(animationFrame);
        CSS.highlights.delete(HIGHLIGHT_NAME);
        onDone();
    }
    const firstNode = textNodes[0];
    const lastNode = textNodes[textNodes.length - 1];
    if (!firstNode || !lastNode) {
        animationFrame = requestAnimationFrame(finish);
        return finish;
    }
    const unrevealed = new Range();
    unrevealed.setStart(firstNode, 0);
    unrevealed.setEnd(lastNode, lastNode.length);
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(unrevealed));
    let nodeIndex = 0;
    let offset = 0; // characters already revealed in the current text node
    let previousChar = "";
    let budget = 0; // milliseconds available to spend on revealing characters
    let lastFrameTime: number | undefined;
    function revealNextFrame(now: number): void {
        if (lastFrameTime !== undefined) budget += now - lastFrameTime;
        lastFrameTime = now;
        while (nodeIndex < textNodes.length) {
            const node = textNodes[nodeIndex]!;
            const cost = msPerChar * (1 + pauseAfter(previousChar));
            if (budget < cost) break;
            budget -= cost;
            previousChar = node.data[offset]!;
            offset += characterLength(node.data, offset);
            if (offset >= node.length) {
                nodeIndex++;
                offset = 0;
            }
        }
        const currentNode = textNodes[nodeIndex];
        if (!currentNode) {
            finish();
            return;
        }
        unrevealed.setStart(currentNode, offset);
        animationFrame = requestAnimationFrame(revealNextFrame);
    }
    animationFrame = requestAnimationFrame(revealNextFrame);
    return finish;
}

function collectTextNodes(container: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    return nodes.filter(node => node.length > 0);
}

function pauseAfter(char: string): number {
    if (char === "") return 0;
    if (SENTENCE_CHARS.includes(char)) return SENTENCE_PAUSE_MULT;
    if (CLAUSE_CHARS.includes(char)) return CLAUSE_PAUSE_MULT;
    return 0;
}

function characterLength(text: string, offset: number): number {
    const code = text.charCodeAt(offset);
    return code >= 0xd800 && code <= 0xdbff ? 2 : 1;
}