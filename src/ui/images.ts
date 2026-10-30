/** Where an image named in the content is served from. Image files live in the project's public/images folder. */
export function imageUrl(name: string): string {
    return `${import.meta.env.BASE_URL}images/${name}`;
}
