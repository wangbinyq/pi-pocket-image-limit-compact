// An image-count rejection ends a run as an ordinary error today: "Too many images in request: 31 > 30" is not a
// context overflow, so Pi never compacts, and a long visual session stops for good. This module marks that rejection
// as an overflow, and Pi Durable then compacts once and retries the request. The history stays on disk.
/** The folder of a Pi Pocket clone: its test helpers give an app on a temporary data folder and a scripted model. */
const pocket = process.env.PI_POCKET_SOURCE ?? "../pi-pocket";
const helpers = (await import(`${pocket}/test/helpers.ts`)) as typeof import(
    "/data/wangb/git/pi-pocket/test/helpers.ts"
);
const { cleanUp, context, newSession, openApp, owner, root, say, scriptedModel, work } = helpers;
type App = Awaited<ReturnType<typeof openApp>>;
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { isPromptTooLarge, isTooManyImages, markOverflow } from "./image-limit-compact.ts";

/** A 1×1 PNG. */
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

after(cleanUp);

test("the wording of image-count rejections is recognized, and nothing else is", () => {
    const refused = [
        "Too many images in request: 31 > 30",
        "Upstream request failed [invalid_request_error] Too many images in request: 36 > 30",
        '{"message":"Too many images in request: 7 >\\n 4","type":"invalid_request_error"}',
        "image count exceeds the limit of 20",
        "The number of images provided exceeds the maximum of 4",
        "The number of images in the request exceeds the maximum of 4",
        "You may pass at most 8 images, but 9 were provided",
        "the engine refused this request: IMG count outside 0..64",
    ];

    for (const text of refused) {
        assert.equal(isTooManyImages(text), true, text);
    }

    const others = [
        "image is too large: 5.2 MB",
        "unsupported image format: image/heic",
        "image/png is not supported by this model",
        "image is 40000x40000; the limit before resizing is 16384",
        "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
        "Connection refused",
        "",
    ];

    for (const text of others) {
        assert.equal(isTooManyImages(text), false, text);
    }
});

test("halogen's context refusal is recognized too", () => {
    const refused = [
        "400: {\"message\":\"the prompt does not fit: it is 463618 tokens and the context is 262144\"}",
        "the prompt does not fit: it is 463618 tokens and the context is 262144, 201474 tokens over",
    ];

    for (const text of refused) {
        assert.equal(isPromptTooLarge(text), true, text);
        assert.equal(isTooManyImages(text), false, "it is not about images");
    }

    assert.equal(isPromptTooLarge("Connection refused"), false);
    assert.equal(isPromptTooLarge("Too many images in request: 3 > 2"), false);
});

test("a prompt that does not fit becomes an overflow as well", () => {
    const refusal = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
            '400: {"message":"the prompt does not fit: it is 463618 tokens and the context is 262144","type":"invalid_request_error"}',
    });

    assert.equal(markOverflow(refusal), true);
    assert.match(refusal.errorMessage!, /the prompt is larger than the context/);
});

test("only an image-count rejection becomes an overflow", () => {
    const rejection = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Too many images in request: 31 > 30",
    });

    assert.equal(markOverflow(rejection), true);
    assert.match(rejection.errorMessage!, /context length exceeded/);

    const overflow = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    });
    const before = overflow.errorMessage;

    assert.equal(markOverflow(overflow), false);
    assert.equal(overflow.errorMessage, before, "an ordinary overflow is left as it is");

    const unrelated = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Connection refused",
    });

    assert.equal(markOverflow(unrelated), false);
    assert.equal(markOverflow(fauxAssistantMessage([fauxText("done")])), false);
});

test("a run refused for too many images compacts once and answers", async () => {
    const requests: { images: number; summary: boolean }[] = [];
    let refused = false;

    const route: FauxResponseStep = (request) => {
        const messages = (request as { messages: Message[] }).messages;
        const system = messages
            .filter((message) => message.role === "system")
            .map((message) => JSON.stringify(message))
            .join("");
        const summary = system.includes("context summarization assistant");

        requests.push({ images: countImages(messages), summary });

        if (summary) {
            return fauxAssistantMessage([fauxText("## Goal\nThe user is looking at pictures.\n")]);
        }

        // The model accepts two images in a request. The third turn carries more, and is refused once, as the
        // provider would refuse it; after the compaction Pi sends again.
        if (!refused && requests.filter((each) => !each.summary).length === 3) {
            refused = true;

            // The wording that halogen, a local server, answers with.
            return fauxAssistantMessage([], {
                stopReason: "error",
                errorMessage: "400: {\"message\":\"the engine refused this request: IMG count outside 0..2\",\"type\":\"invalid_request_error\"}",
            });
        }

        return fauxAssistantMessage([fauxText("ok")]);
    };

    const dataDir = join(root, "image-limit-data");
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(join(import.meta.dirname, "image-limit-compact.ts"), join(dropIns, "image-limit-compact.ts"));

    const app: App = await openApp(scriptedModel(route), dataDir);

    try {
        await app.setExtensionEnabled(owner(app), "image-limit-compact.ts", true);
        // Keep one message as it is: a short conversation has something to summarize.
        app.settings.getCompactionSettings = () => ({
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: 1,
        });

        const id = await newSession(app);

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-vision" },
        });

        for (const [turn, name] of ["first", "second", "third"].entries()) {
            const files = [`${name}-a.png`, `${name}-b.png`].map((file) => {
                const path = join(work, file);

                writeFileSync(path, PNG);

                return { path, name: file, mime: "image/png", size: PNG.length };
            });

            await say(app, id, `${name} ${turn}`, files);
        }

        const asked = requests.filter((each) => !each.summary);

        assert.equal(asked.length, 4, "three turns and one retry: no other request");
        assert.equal(requests.filter((each) => each.summary).length, 1, "one compaction");
        assert.equal(asked[3]!.images < asked[2]!.images, true, "the retry carries fewer images");

        const entries = await app.transcripts.allEntries(id, true);

        assert.equal(
            entries.some((entry) => entry.kind === "compaction"),
            true,
            "the summary is in the history",
        );
        assert.equal(
            JSON.stringify(entries.filter((entry) => entry.kind === "compaction")).includes(
                "The user is looking at pictures",
            ),
            true,
            "the summary's words are in the history",
        );
        assert.equal(
            entries.some((entry) => entry.error?.includes("context length exceeded") === true),
            true,
            "the refusal stays in the history for reading",
        );

        const view = await (await app.harness.conversation(id, context))!.context(context);

        assert.equal(
            view.messages.some((message) => JSON.stringify(message).includes("context length exceeded")),
            false,
            "the refusal is not sent to the model",
        );
    } finally {
        await app.close();
    }
});

/** How many images a request carries. */
function countImages(messages: readonly Message[]): number {
    let images = 0;

    for (const message of messages) {
        if (message.role === "system" || typeof message.content === "string") {
            continue;
        }

        for (const block of message.content) {
            if (block.type === "image") {
                images += 1;
            }
        }
    }

    return images;
}
