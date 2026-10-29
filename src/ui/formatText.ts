import { LITERAL_ASTERISK } from "../engine/parseProse";
import { SCENE_BREAK } from "../engine/step";

export function textToHtml(text: string): string {
    return text
        .split(SCENE_BREAK)
        .map(scene => scene.trim())
        .filter(scene => scene !== "")
        .map(sceneToHtml)
        .join('<hr class="scene-break">');
}

export function inlineHtml(text: string): string {
    return applyStyling(escapeHtml(text));
}

function sceneToHtml(scene: string): string {
    return scene
        .split(/\n{2,}/)
        .map(paragraph => `<p>${inlineHtml(paragraph.replaceAll("\n", " "))}</p>`)
        .join("");
}

function applyStyling(escaped: string): string {
    return escaped
        .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replaceAll(LITERAL_ASTERISK, "*");
}

function escapeHtml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}