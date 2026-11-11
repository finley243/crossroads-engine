import { readHeader, type SaveHeader } from "../engine/save";

export interface StoredSave {
    id: string;
    header: SaveHeader;
}

/** Where saves are kept: a place with named saves, which each platform provides in its own way. */
export interface SaveStore {
    /** The saves there are, with their headers, in no particular order. A save that can't be read isn't in the list. */
    list(): Promise<StoredSave[]>;
    read(id: string): Promise<string | undefined>;
    write(id: string, text: string): Promise<void>;
    remove(id: string): Promise<void>;
}

/** Saves kept in memory, which last until the page is closed. For tests, and for a game that can't keep anything. */
export function createMemoryStore(): SaveStore {
    const saves = new Map<string, string>();
    return {
        async list() {
            return [...saves].flatMap(([id, text]) => {
                const header = readHeader(text);
                return header ? [{ id, header }] : [];
            });
        },
        async read(id) {
            return saves.get(id);
        },
        async write(id, text) {
            saves.set(id, text);
        },
        async remove(id) {
            saves.delete(id);
        },
    };
}

const HEADERS = "headers";
const TEXTS = "texts";

/**
 * Saves kept in the browser's IndexedDB. The headers are kept apart from the text of each save, so that a list of saves
 * doesn't mean reading all of them.
 */
export function createIndexedDbStore(name = "crossroads-saves"): SaveStore {
    let opened: Promise<IDBDatabase> | undefined;
    function open(): Promise<IDBDatabase> {
        opened ??= new Promise((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore(HEADERS, { keyPath: "id" });
                request.result.createObjectStore(TEXTS, { keyPath: "id" });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                opened = undefined; // so that the next try starts again
                reject(request.error ?? new Error("The browser wouldn't open its storage for saves."));
            };
        });
        return opened;
    }
    // Runs some work in one transaction, and gives what the work's last request found, once everything has been stored.
    async function transact<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | undefined): Promise<T | undefined> {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode);
            const request = work(tx);
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error ?? new Error("The browser couldn't store the save."));
            tx.onabort = () => reject(tx.error ?? new Error("The browser couldn't store the save (it may be out of room)."));
        });
    }
    return {
        async list() {
            const rows = await transact([HEADERS], "readonly", tx => tx.objectStore(HEADERS).getAll());
            return (rows ?? []) as StoredSave[];
        },
        async read(id) {
            const row = (await transact([TEXTS], "readonly", tx => tx.objectStore(TEXTS).get(id))) as { text: string } | undefined;
            return row?.text;
        },
        async write(id, text) {
            const header = readHeader(text);
            if (!header) throw new Error("That isn't a save, so it can't be stored.");
            await transact([HEADERS, TEXTS], "readwrite", tx => {
                tx.objectStore(HEADERS).put({ id, header });
                return tx.objectStore(TEXTS).put({ id, text });
            });
        },
        async remove(id) {
            await transact([HEADERS, TEXTS], "readwrite", tx => {
                tx.objectStore(HEADERS).delete(id);
                return tx.objectStore(TEXTS).delete(id);
            });
        },
    };
}
