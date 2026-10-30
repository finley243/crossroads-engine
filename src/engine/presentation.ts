import { evaluate, type EvalContext } from "./evaluate";
import type { Content, GameState, NodePresentation, PresentationDecl, PresentationField, PresentationState, Rng } from "./types";

const PRESENTATION_FIELDS = ["image", "theme", "location", "music", "ambience"] as const;
type FieldName = (typeof PRESENTATION_FIELDS)[number];

/** Work out what the current scene should look and sound like, from the node being shown and any nodes under it on the stack. */
export function resolvePresentation(content: Content, state: GameState, rng: Rng): PresentationState {
    const chain = [...state.stack.map(frame => frame.node), state.node];
    const result: PresentationState = { image: null, theme: null, location: null, music: null, ambience: null };
    const ctx: EvalContext = { content, state, bindings: {}, rng };
    chain.forEach((nodeId, depth) => {
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
