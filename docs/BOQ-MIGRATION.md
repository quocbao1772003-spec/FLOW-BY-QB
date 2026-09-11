# Flow moved off aisandbox-pa → boq `batchexecute` (Sep 2026)

Google rebuilt Google Flow on its internal boq RPC framework. The REST API
Flowboard was written against is gone; nothing in it responds any more.

| | Before | After |
|---|---|---|
| Host | `aisandbox-pa.googleapis.com` | `flow.google.com` (own origin) |
| Endpoint | `/v1/projects/<id>/flowMedia:batchGenerateImages` | `/_/AiSandboxAngularFrontend/data/batchexecute` |
| Auth | `Authorization: Bearer <token>` | session cookie + `at` XSRF token |
| Caller | agent (Python) | **must** be a `flow.google.com` page |
| Media CDN | GCS `fifeUrl` | `https://flow-content.google/image/<mediaId>?Expires=…&Signature=…` |
| reCAPTCHA | same site key, in `recaptchaContext.token` | same site key, in payload at `[token, 1]` |

The Bearer token is never issued any more — that is why the extension popup
showed `Token captured 26 h ago` and every generate failed.

## Request

```
POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
  ?rpcids=ogiZ0b
  &source-path=/project/<projectId>
  &bl=<WIZ_global_data.cfb2h>        e.g. boq_labs-ai-sandbox-frontend_20260909.10_p0
  &f.sid=<WIZ_global_data.FdrFJe>
  &hl=<WIZ_global_data.EP>
  &_reqid=<random 6 digits>
  &rt=c

content-type: application/x-www-form-urlencoded;charset=UTF-8
body: f.req=<urlencoded envelope>&at=<WIZ_global_data.SNlM0e>
```

Envelope, then its inner JSON string:

```
[[["ogiZ0b", "<inner>", null, "generic"]]]

inner = [null,
          [[null, null, INPUTS, <seed>, 1, "NARWHAL", null,
            CTX,
            [[["<prompt>"]]],
            null,null,null, "<UUID-A>", "<UUID-B>"]],
          1,
          CTX,
          ["<UUID-C>"]]

CTX    = [null, 22, null,null,null, "<projectId>", null,null,null,null,
          ["<reCAPTCHA Enterprise token>", 1]]

INPUTS = null                                        (text → image)
       | [["<mediaId>", null, null, null, 1], …]     (image → image)
```

* `"NARWHAL"` — model tag (Nano Banana 2).
* `<seed>` — a per-call random integer, NOT a model id. Two captures of the
  same model returned 859710828 and 2087997909, each echoed back verbatim.
  Pinning it makes every variant of a prompt render identically.
* `INPUTS` sits at slot 2 and is the only structural difference between a
  text-only and an i2i call. The trailing `1` is the input's role; it was `1`
  on every capture, so `IMAGE_INPUT_TYPE_BASE_IMAGE` vs `..._REFERENCE` has no
  known counterpart yet and the distinction is currently dropped.
* `22` — surface id.
* UUIDs are client-generated, uppercase v4. `UUID-C` comes back in the
  response's shot record.
* The captcha token is single-use, action `IMAGE_GENERATION`, and the same
  string appears in both copies of `CTX`.

## Response

`)]}'` followed by length-prefixed JSON chunks. The useful frame is
`["wrb.fr","ogiZ0b","<json string>",…]`; inside it, nested ~8 levels deep:

```
"<mediaId>", null, "<generationId>", …
  [[null, 859710828, …, 1, "<prompt translated to English>", 29, …,
    "https://flow-content.google/image/<mediaId>?Expires=…&KeyName=labs-flow-prod-cdn-key&Signature=…",
    …]],
  null, [1024, 1024]
```

* **Synchronous** — the finished image URL is in this reply, ~25–30 s later.
  No `batchCheckAsync` polling any more.
* On an i2i call the metadata block's trailing array echoes the inputs:
  `[]` for text-only, `[[[null, 1, "<mediaId>"]]]` when conditioned.
* The backend translates the prompt to English before generating.
* The signed URL expires in ~6 h, so cache the bytes promptly.

`extension/background.js` deliberately does **not** index into those
positions — it walks the whole decoded tree and takes the first
`https://flow-content.google/` string, recovering the media id from the path.
Google reshuffles positional arrays without notice; a tree walk survives that,
hard-coded indices do not.

## How it is wired

`handleApiRequest` intercepts the legacy `:batchGenerateImages` URL and calls
`handleBatchGenerateImagesViaBoq`, which runs `boqGenerateInPage` inside a
Flow **project** tab via `chrome.scripting` (MAIN world — that is where
`WIZ_global_data` and `grecaptcha` live), then rebuilds the old
`{ media: [{ name, image: { generatedImage: { fifeUrl } } } ] }` reply.

The agent is untouched: `flow_sdk.extract_media_entries` parses the shim's
output exactly as it parsed the real API.

Note: the tab must be on `flow.google.com/project/…`. The site root and
`/about` are a *different* boq app and carry a different `bl`, so the RPC
would be rejected.

## The other two rpcids

### `maseQ` — upload

```
inner = [CTX, "<base64 bytes, NO data: prefix>", "<mimeType>", 1,
         null,null,null,null, "<fileName>", null, "<UUID>", "<UUID>"]
```

Returns the new media id at slot 0 of the first record (the project id sits at
slot 1, so match on "first uuid that is not the project id"). ~9 s for a
340 KB jpeg. Needs its own single-use captcha token — the action string is not
recoverable from a capture, so the shim tries `IMAGE_UPLOAD` then falls back to
`IMAGE_GENERATION`.

An uploaded media id and a generated one are the same kind of handle: it drops
straight into `ogiZ0b`'s `INPUTS` with no intermediate step.

### `SPrCad` — upscale

```
inner = [ "<mediaId>", <level>, CTX_NO_PROJECT ]

CTX_NO_PROJECT = [null, 22, null,null,null, null, null,null,null,null,
                  ["<captcha token>", 1]]
```

`level` 1 = 2K (captured). 4K is assumed to be 2 — **not verified**. Note the
project id slot is null: upscaling is addressed by media id alone.

The reply carries the upscaled image **inline as base64** (~1 MB for 2K), not a
signed URL, so there is nothing to fetch afterwards and no way to re-fetch it
later. The retired REST endpoint behaved the same way (`data.encodedImage`), so
the agent needed no change. The shim finds the blob as the longest
base64-looking string in the decoded tree rather than by position.

Media-kind enum seen in these replies: `"CAE"` = generated/uploaded,
`"CAI"` = upscaled.

## Variants

"4 images at once" is **N separate `ogiZ0b` calls**, not one call with a count.
They differ only by seed, by the two per-item UUIDs, and by captcha token
(each is single-use). They share the trailing `["<UUID>"]` — that slot is a
**batch id**, not a request id. The `1` after the items array stays `1` even
for four images, so it is not a count either.

## Not done yet

| Gap | What is needed |
|---|---|
| Multi-image prompts | With two or more tagged images the app switches the prompt from `[[["text"]]]` to an interleaved segment list: `["text"]` for prose, `[null,[[mediaId,"label"]]]` for an inline image chip. Chip ORDER decides which image the model calls "first"/"second" — `INPUTS` order does not. The shim still sends plain text plus `INPUTS`, which matches every single-reference capture but is untested with several. |
| 4K upscale | `level` 2 is a guess. |
| `edit_image` base-vs-reference | Both map to the same trailing `1` today. |
| Aspect ratio | Always 1024×1024 today. Suspect the `29` field or the `22` surface id — needs a diff of two captures at different ratios. |
| Variants x2–x4 | Shim fires N parallel calls, one per prompt. The app may have a native count field. |
| Video (Veo) | Different rpcid entirely; not captured. |
| Project persistence | The app fires `WuwhI` (~2.6 KB) after generating — probably "attach media to project". Skipped; Flowboard keeps its own copy. |

Other rpcids seen: `as29s` takes `["<mediaId>"]` and returns that media's
metadata (URL, size, original prompt) — the app uses it to render a thumbnail
after you pick a reference. Not needed to generate.

Capture more with DevTools → Network → the `batchexecute` row → Copy as fetch.
Never commit a capture: `at` and the captcha token are session credentials.
