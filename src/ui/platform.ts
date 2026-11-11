import { createIndexedDbStore, type SaveStore } from "./saveStore";

/** What the game needs from the system it's running on, to keep saves and to move them in and out. */
export interface SavePlatform {
    store: SaveStore;
    /** Gives the player a file, in whatever way this platform has of doing that. */
    exportFile(name: string, text: string): Promise<void>;
    /** Asks the player to choose a file, and gives what's in it, or nothing if they didn't choose one. */
    importFile(): Promise<string | undefined>;
}

/** A browser: saves in IndexedDB, a file downloaded to export, and a file chosen to import. */
export function createBrowserPlatform(storeName?: string): SavePlatform {
    return {
        store: createIndexedDbStore(storeName),
        async exportFile(name, text) {
            const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        },
        importFile() {
            return new Promise(resolve => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json,application/json";
                input.addEventListener("change", () => resolve(input.files?.[0]?.text()), { once: true });
                input.addEventListener("cancel", () => resolve(undefined), { once: true });
                input.click();
            });
        },
    };
}
