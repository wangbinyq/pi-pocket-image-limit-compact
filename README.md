# image-limit-compact

A Pi Pocket drop-in module: when a model refuses a request for carrying too many images, Pi compacts the conversation
once and sends the request again, instead of ending the run.

```
Error: 400: {"message":"Too many images in request: 31 > 30","type":"invalid_request_error"}
```

Pi's auto-compaction only reacts to context-overflow errors (too many tokens). A rejection for the number of images is
not one of them, so the run stops: a long session that reads screenshots or pictures ends there, and the only way back
is `/compact` by hand, then asking Pi to continue.

## What it does

The module adds one hook to Pi's generation task, and no tool, route, or prompt section:

- It reads each failed response.
- If the error names too many images, it appends ` (context length exceeded: …)` to the error text.
- Pi Durable checks for overflow right after this hook, so the error now goes to its own overflow recovery: one
  compaction, then one retry. Nothing else about the run changes.

The refusal stays in the history, for reading and for export. The model does not see it again: the compaction summarizes
it with the messages before it.

What it does not do:

- It does not remove images one by one. Compaction summarizes older messages, so older images leave the context that
  way.
- It does not retry more than once. If the newest messages still carry too many images, the run ends with the
  provider's error, and the app says why. Compact by hand, then ask Pi to continue.
- It does not change your settings or your models.

## Error wordings it recognizes

Every pattern needs the words "too many", or a count with a limit, so an image that is too large or of the wrong format
is not mistaken for this case:

| Example                                                      |
| ------------------------------------------------------------ |
| `Too many images in request: 31 > 30`                        |
| `Upstream request failed: Too many images in request: 36 > 30` |
| `image count exceeds the limit of 20`                        |
| `The number of images provided exceeds the maximum of 4`     |
| `You may pass at most 8 images, but 9 were provided`         |

A provider with wording that none of these match is not helped. Open an issue with its error text.

## Install

1. Copy `image-limit-compact.ts` into the drop-in folder, `~/.pi-pocket/extensions/`.
2. Open Menu → Extensions, and turn on **image-limit-compact**.

It starts off, as every drop-in does. It runs inside the server with the owner's rights, so read the file first: it
imports `@earendil-works/pi-ai` and `@earendil-works/pi-durable`, reads no files, uses no network, and starts no
process.

## Test

The test runs a real Pi Pocket on a temporary data folder with a scripted model: the third turn is refused for its
image count, and the test checks that Pi compacted once and answered, that the retry carries fewer images, and that the
refusal stays in the history but not in the context.

```sh
npm test                                     # uses ../pi-pocket
PI_POCKET_SOURCE=/path/to/pi-pocket npm test # or name the clone
npm run typecheck
```

`PI_POCKET_SOURCE` is the folder of a Pi Pocket clone. The test imports its `test/helpers.ts`, and the module's own
imports come from that clone's `node_modules`: link it as this folder's `node_modules`, or run the test from the clone.

The test file is not a module: Pi Pocket does not load a file that ends in `.test.ts`. Do not copy it into the drop-in
folder.

## License

MIT.
