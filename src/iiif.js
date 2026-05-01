import { Vault, getThumbnail } from '@iiif/helpers';

const vault = new Vault();

export async function getCanvases(manifestURL) {
    const manifest = await vault.load(manifestURL);
    if (!manifest) {
        throw new Error('Manifest failed to load');
    }

    const canvases = [];
    for (const canvasRef of manifest.items || []) {
        const canvas = vault.get(canvasRef.id);

        // Extract first available label string
        const labelObj = canvas.label || {};
        const labelValues = Object.values(labelObj);
        const label = labelValues.length > 0 ? labelValues[0][0] : canvasRef.id;

        // Use getThumbnail to get the best matching image at ~150px
        const result = await getThumbnail(canvasRef, { vault, maxWidth: 150, maxHeight: 150 });
        const thumbnailUrl = result.best?.id ?? null;

        canvases.push({ id: canvas.id, label, thumbnailUrl });
    }
    return canvases;
}

export async function getImageURL(manifestURL, canvasId) {
    const manifest = await vault.load(manifestURL);

    if (!manifest) {
        throw new Error('Manifest failed to load');
    }
    // Manifest items are canvases in IIIF Presentation 3.
    const canvasRef = manifest.items.find((item) => item.id === canvasId);
    if (!canvasRef) {
        throw new Error(`Canvas not found: ${canvasId}`);
    }

    const canvas = vault.get(canvasRef.id);
    // Look at painting annotation pages.
    for (const pageRef of canvas.items || []) {
        const page = vault.get(pageRef);

        for (const annoRef of page.items || []) {
            const annotation = vault.get(annoRef);

            console.log("Looking at annotation: " + annotation.id);

            const body = Array.isArray(annotation.body)
                ? annotation.body[0]
                : annotation.body;

            if (!body) {
                continue;
            }

            // If body is a reference, resolve it.
            const resourceRef = body.id ? body : vault.get(body);
            const resource = vault.get(resourceRef);

            // Direct image body.
            if (resource?.type === "Image" && resource.service) {
                console.log("Found image with service: " + resource.service[0].id);
                return resource.service[0].id;
            }
        }
    }

    throw new Error(`No painting image found for canvas: ${canvasId}`);
}
