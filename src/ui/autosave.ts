import { writeSave } from "../engine/save";
import type { Content, GameState } from "../engine/types";
import type { SaveStore, StoredSave } from "./saveStore";

/** How many autosaves there are: the game is saved after every action, and this many of the latest ones are kept. */
export const AUTOSAVE_SLOTS = 10;

const PREFIX = "auto-";

export interface Autosaver {
    /** Saves the game as it is now, in the background. It goes in the oldest slot, so that the latest ones are kept. */
    save(state: GameState): void;
    /** Waits until the saves that are being written are done. */
    flush(): Promise<void>;
    /** The latest save there is, once any that are being written are done. */
    latest(): Promise<StoredSave | undefined>;
}

export function createAutosaver(store: SaveStore, content: Content, onError: (message: string) => void, slots = AUTOSAVE_SLOTS): Autosaver {
    let queue: Promise<void> = Promise.resolve(); // writes happen one after another, in the order they were asked for
    let savedAt: Map<string, string> | undefined; // when each autosave slot was last written

    function oldestSlot(known: Map<string, string>): string {
        let oldest: string | undefined;
        for (let i = 0; i < slots; i++) {
            const id = `${PREFIX}${i}`;
            const when = known.get(id);
            if (when === undefined) return id; // a slot nothing has been saved in
            if (oldest === undefined || when < known.get(oldest)!) oldest = id;
        }
        return oldest!;
    }

    return {
        save(state) {
            const now = new Date();
            const text = writeSave(content, state, now); // made now, since the game moves on before the write happens
            queue = queue
                .then(async () => {
                    savedAt ??= new Map((await store.list()).filter(s => s.id.startsWith(PREFIX)).map(s => [s.id, s.header.savedAt]));
                    const id = oldestSlot(savedAt);
                    await store.write(id, text);
                    savedAt.set(id, now.toISOString());
                })
                .catch(error => onError(`The game couldn't be saved: ${error instanceof Error ? error.message : String(error)}`));
        },
        flush() {
            return queue;
        },
        async latest() {
            await queue;
            const saves = await store.list();
            return saves.sort((a, b) => b.header.savedAt.localeCompare(a.header.savedAt))[0];
        },
    };
}
