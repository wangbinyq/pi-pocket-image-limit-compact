/**
 * Compacts a conversation when a model refuses a request for carrying more images than it accepts, such as
 * "Too many images in request: 31 > 30" or halogen's "IMG count outside 0..64", and when a provider says in its own
 * words that the prompt is larger than the context, as halogen does: "the prompt does not fit". Pi's own
 * auto-compaction only reacts to the overflow errors that it knows, so such a rejection ends the run as an ordinary
 * error. This module marks that rejection as an overflow, and Pi Durable then compacts once and retries the request,
 * keeping the whole history on disk.
 *
 * It reads no files, uses no network, and starts no process. It only changes the error text of a failed response.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

/**
 * Wording that says a request was refused for the number of images in it. Every pattern needs the words "too many", or
 * a count with a limit, so an image that is too large, or of a bad format, is not mistaken for one.
 */
const TOO_MANY_IMAGES: readonly RegExp[] = [
    /\btoo many images?\b/i,
    /\b(?:image|img)[ _-]?count\b[^.]{0,40}\b(?:exceed\w*|over|outside|greater|limit|maximum|max|0\.\.)/i,
    /\bnumber of images\b[^.]{0,40}\b(?:exceed\w*|over|outside|greater|limit|maximum|max|0\.\.)/i,
    /\b(?:exceed\w*|over|outside|greater than|more than|limit of|maximum of|max(?:imum)?)\b[^.]{0,20}\b\d+\s*images\b/i,
    /\bat most\s+\d+\s+images\b/i,
];

/**
 * Wording that says a request was refused because the prompt is larger than the context. Pi knows the common ones
 * already; these are the local servers that word it their own way, as halogen does: "the prompt does not fit".
 */
const PROMPT_TOO_LARGE: readonly RegExp[] = [
    /\b(?:prompt|request|context|input)\b[^.]{0,30}\bdoes(?: not|n't) fit\b/i,
    /\bfit(?:s)? (?:in|into) the context\b/i,
];

/** Appended to the provider's words, so the model's own reason stays readable and Pi sees an overflow. */
const IMAGE_NOTE =
    " (context length exceeded: the request has more images than this model accepts, so Pi compacted the conversation to remove older ones)";
const PROMPT_NOTE =
    " (context length exceeded: the prompt is larger than the context, so Pi compacted the conversation to shorten it)";

/** Whether `message` was refused because its request carried too many images. */
export function isTooManyImages(message: string): boolean {
    return TOO_MANY_IMAGES.some((pattern) => pattern.test(message));
}

/** Whether `message` was refused because the prompt is larger than the context. */
export function isPromptTooLarge(message: string): boolean {
    return PROMPT_TOO_LARGE.some((pattern) => pattern.test(message));
}

/**
 * Marks a rejection that Pi does not know as a context overflow in place, and leaves every other response alone.
 * Pi Durable checks its overflow rules right after the `afterResponse` hooks, so this is the way to send it to
 * compaction without a change to Pi's code.
 */
export function markOverflow(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || message.errorMessage === undefined) {
        return false;
    }

    if (isContextOverflow(message)) {
        return false;
    }

    const text = message.errorMessage;
    const note = isTooManyImages(text) ? IMAGE_NOTE : isPromptTooLarge(text) ? PROMPT_NOTE : undefined;

    if (note === undefined) {
        return false;
    }

    message.errorMessage = `${text}${note}`;

    return true;
}

export default function createImageLimitCompact() {
    return defineExtension({
        name: "image-limit-compact",
        hooks: [
            hook(GenerationTask, {
                afterResponse: (message) => {
                    markOverflow(message);
                },
            }),
        ],
    });
}
