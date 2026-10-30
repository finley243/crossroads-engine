import { evaluate, type EvalContext } from "./evaluate";
import type { Content, GameState, NodePresentation, PresentationDecl, PresentationField, PresentationState, Rng } from "./types";

const PRESENTATION_FIELDS = ["image", "theme", "location", "music", "ambience"] as const;
type FieldName = (typeof PRESENTATION_FIELDS)[number];

/** Work out what the current scene should look and sound like, from the node being shown and any nodes under it on the stack. */
export function resolvePresentation(content: Content, state: GameState, rng: Rng): PresentationState {
    const chain = [...state.stack.map(frame => ({ nodeId: frame.node, trip: frame.trip === true })), { nodeId: state.node, trip: false }];
    const result: PresentationState = { image: null, theme: null, location: null, music: null, ambience: null };
    const ctx: EvalContext = { content, state, bindings: {}, rng };
    chain.forEach(({ nodeId, trip }, depth) => {
        const decl = withPreset(content, content.nodes[nodeId]?.presentation);
        for (const name of PRESENTATION_FIELDS) {
            const field = decl[name] as PresentationField<unknown> | undefined;
            if (field === undefined) {
                if (depth === 0) setField(result, name, null);
                continue;
            }
            const entry = field.find(e => e.when === undefined || evaluate(e.when, { ...ctx, bindings: {} }) === true);
            setField(result, name, entry ? entry.value : null);
        }
        // On a trip, the look and sound of the place being left carry on, but the player isn't at that place any more.
        // A node pushed on top of it can still say where it is.
        if (trip) result.location = null;
    });
    return result;
}

function withPreset(content: Content, presentation: NodePresentation | undefined): PresentationDecl {
    if (!presentation) return {};
    const { preset, ...own } = presentation;
    const base = preset === undefined ? {} : (content.presets[preset] ?? {});
    return { ...base, ...own };
}

function setField(result: PresentationState, name: FieldName, value: unknown): void {
    (result as Record<FieldName, unknown>)[name] = value;
}
