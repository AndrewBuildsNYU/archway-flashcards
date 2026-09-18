# Archway Flashcards

Paste a set of lecture notes, get a deck of flashcards, review them one card at a time, and export the
deck to Anki. It is an NYU Archway example: the Archway concept it demonstrates is **structured
generation** — asking a model for strict JSON through the gateway, and parsing the answer defensively
enough that a stray sentence or a markdown fence cannot break the app.

## Try it

https://andrewbuildsnyu.github.io/archway-flashcards/

Nothing is installed and nothing is uploaded. The page runs in your browser and is already
pointed at the Archway.

## Get a key

Make one in the Archway portal, at `/portal` on the gateway.

**Use a low-quota key.** This is a browser app, so the key lives in your own `sessionStorage` and travels
with every request your browser makes — anyone who can see your screen or your devtools can read it. Give
it a small token budget, keep it to the providers you need, and rotate it when you are done. The key is
never sent anywhere but the Archway.

## Run it locally

```
git clone https://github.com/AndrewBuildsNYU/archway-flashcards.git
cd archway-flashcards
```

Then open `index.html`. There is no build step, no package manager, and no dependencies — three files and
two shared assets.

If you point the app at a *different* Archway deployment, that gateway has to allow this page's origin:
add it to `NYU_CORS_ALLOWED_ORIGINS` in the gateway's environment, or the browser will block the request
before it ever reaches the API.

## How it works

The interesting part is the round trip from free text to a data structure and back to something a student
keeps.

1. **The prompt asks for one shape and nothing else**: `{"cards":[{"front":…,"back":…,"tag":…}]}`, with
   explicit rules — a front that is a real question rather than a fill-in-the-blank stub, a back that
   stands on its own, a short reusable tag. The question style (Recall / Understand / Apply) is a single
   swapped line in that prompt.
2. **The parse assumes the model misbehaves.** `extractJson()` strips a leading ` ```json ` fence, takes
   everything between the first `{` and the last `}`, and runs `JSON.parse` inside a `try`. Every card is
   then checked field by field before it is accepted. If nothing survives, the raw response is shown
   verbatim instead of the app throwing — a failed generation should still teach you what went wrong.
3. **The review queue is the point.** One card fills the screen; space flips it with a CSS 3D transform;
   `1` / `2` / `3` grade it. "Again" appends a second entry for that card at the back of the queue, so it
   comes round once more in the same session, and the meter tracks distinct cards settled rather than
   keystrokes made.
4. **The export is plain data.** The CSV quotes every field, doubles internal quotes, and uses CRLF line
   endings, which is what Anki expects; the file's `#separator` / `#tags column` header lines let Anki
   2.1.54 and newer map the columns without being told. The TSV variant flattens tabs and newlines,
   because a TSV field cannot contain either.

Model output is written with `textContent` and never `innerHTML` — a flashcard is untrusted text.

Output length is clamped to the selected model's `max_output_tokens`, taken from
`Archway.listModels()`; asking a vendor for more than it allows is a 400 you can avoid on the client.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page shape, controls, and the handful of layout rules the flip card needs |
| `assets/app.js` | Prompt, defensive JSON parse, review queue, CSV and TSV export |
| `assets/archway.js` | Shared Archway client: key panel, model list, chat and streaming, error rendering |
| `assets/archway.css` | Shared design system: tokens, components, dark mode |

MIT licensed.
