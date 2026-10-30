const HIGHLIGHT_NAME = "unrevealed";
const SENTENCE_PAUSE_MULT = 14;
const SENTENCE_CHARS = ".!?…";
const CLAUSE_PAUSE_MULT = 8;
const CLAUSE_CHARS = ",;:—";

// Highlights can only change color, so a character fades in by passing through a few colors of rising opacity:
// ::highlight(fade-0) is for the newest characters, and ::highlight(fade-5) for the ones about to be fully shown.
const FADE_STAGES = 6;
const stageName = (stage: number) => `fade-${stage}`;

interface Character {
    node: Text;
    offset: number;
    width: number; // 2 for characters outside the basic range, which take two code units
    char: string;
}

export function canType(): boolean {
    return typeof CSS !== "undefined" && "highlights" in CSS;
}

export function typeText(container: HTMLElement, charsPerSecond: number, onDone: () => void, fadeMs = 0): () => void {
    const chars = collectCharacters(container);
    const msPerChar = 1000 / charsPerSecond;
    let animationFrame = 0;
    let finished = false;
    const highlightNames = [HIGHLIGHT_NAME, ...Array.from({ length: fadeMs > 0 ? FADE_STAGES : 0 }, (_, stage) => stageName(stage))];

    function finish(): void {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(animationFrame);
        highlightNames.forEach(name => CSS.highlights.delete(name));
        onDone();
    }

    if (chars.length === 0) {
        animationFrame = requestAnimationFrame(finish);
        return finish;
    }

    // Make a range cover characters from (inclusive) to to (exclusive), or nothing at all.
    function select(range: Range, from: number, to: number): void {
        const first = chars[from];
        const last = chars[to - 1];
        if (!first || !last || from >= to) {
            const end = chars[chars.length - 1]!;
            range.setStart(end.node, end.offset + end.width);
            range.setEnd(end.node, end.offset + end.width);
            return;
        }
        range.setStart(first.node, first.offset);
        range.setEnd(last.node, last.offset + last.width);
    }

    const unrevealed = new Range();
    select(unrevealed, 0, chars.length);
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(unrevealed));
    const stages = Array.from({ length: fadeMs > 0 ? FADE_STAGES : 0 }, () => new Range());
    stages.forEach((range, stage) => {
        select(range, 0, 0);
        CSS.highlights.set(stageName(stage), new Highlight(range));
    });

    const revealedAt: number[] = []; // when each revealed character appeared
    let revealed = 0;
    let previousChar = "";
    let budget = 0; // milliseconds available to spend on revealing characters
    let lastFrameTime: number | undefined;

    // Group the characters that are still fading by how far along they are. The newest are the last revealed,
    // so each stage is a run of neighboring characters.
    function updateFade(now: number): void {
        const stageMs = fadeMs / FADE_STAGES;
        const from = Array<number>(FADE_STAGES).fill(0);
        const to = Array<number>(FADE_STAGES).fill(0);
        for (let i = revealed - 1; i >= 0; i--) {
            const age = now - revealedAt[i]!;
            if (age >= fadeMs) break;
            const stage = Math.min(FADE_STAGES - 1, Math.floor(age / stageMs));
            if (to[stage] === 0) to[stage] = i + 1;
            from[stage] = i;
        }
        stages.forEach((range, stage) => select(range, from[stage]!, to[stage]!));
    }

    function revealNextFrame(now: number): void {
        if (lastFrameTime !== undefined) budget += now - lastFrameTime;
        lastFrameTime = now;
        while (revealed < chars.length) {
            const cost = msPerChar * (1 + pauseAfter(previousChar));
            if (budget < cost) break;
            budget -= cost;
            previousChar = chars[revealed]!.char;
            revealedAt[revealed] = now;
            revealed++;
        }
        select(unrevealed, revealed, chars.length);
        if (fadeMs > 0) updateFade(now);

        const lastFadeDone = fadeMs === 0 || now - revealedAt[chars.length - 1]! >= fadeMs;
        if (revealed >= chars.length && lastFadeDone) {
            finish();
            return;
        }
        animationFrame = requestAnimationFrame(revealNextFrame);
    }
    animationFrame = requestAnimationFrame(revealNextFrame);
    return finish;
}

function collectCharacters(container: HTMLElement): Character[] {
    const chars: Character[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        for (let offset = 0; offset < node.length; ) {
            const width = characterLength(node.data, offset);
            chars.push({ node, offset, width, char: node.data[offset]! });
            offset += width;
        }
    }
    return chars;
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
