# Memory highlights study tool

Study tool for the CMPUT 656 project *Telling You What You Want to Hear: Can People Notice When an AI's Memory of Them Slants Its Answers?* (University of Alberta, Fall 2026). It runs the two-session, within-subjects study described in the Methodology report: a Session 1 questionnaire that becomes the assistant's "memory" of the participant, and a Session 2 in which the participant uses a memory-equipped assistant for real tasks under two versions (with and without memory highlights), rates it, audits its answers, and is debriefed.

Live copy: https://memory-highlights-prototype-production.up.railway.app/ (participants) and `/researcher` (researcher page).

## How it works

* **Session 1** (`/`, participant enters their code): 8 opinion items on ProCon.org debate questions (6-point agree scale plus importance), 8 preference items (two-way choice, strength, "will you face this decision soon?"), 8 background items, and two questions about AI use. The server turns the answers into a numbered memory profile (M1, M2, ...) and picks the two opinion topics with the strongest, most important stance and the two preference topics the participant will actually face.
* **Session 2** (opened by the researcher from the researcher page): consent, memory review (the participant marks wrong items, which are dropped), a practice question, then two blocks. Each block is one opinion conversation and one preference conversation on the assigned topics; the participant asks at least four questions, writes a short message or plan, and rates trust after each conversation and balance and memory use after each block. Then an audit of the block's transcript (one-sided / balanced / not sure for every answer; in the no-highlights block, clicking the sentences they think used the memory; in the highlights block, two items about the highlights and a comprehension check). After both blocks: comparison questions, a guessed-purpose question, interview notes, and a debrief that lists every slanted answer with a "See balanced version" button and links to the ProCon pages.
* **Answer generation**: for every question the server picks a mode (biased or balanced; the first four answers of a conversation are two of each in random order, never more than two of the same in a row), builds the system prompt from the memory profile and the topic's ProCon arguments (or option list), and calls the generation model, which returns the answer split into sentences with the memory items each sentence used. A second, independent call to a smaller model re-tags the sentences. A sentence is highlighted only if both calls tagged it. Everything (mode, both raw outputs, both tag sets, timings) is logged.
* **Version order and topic sets** follow Table 2 of the report from the participant code: P1, P5 highlights first with topic set A then B; P2, P6 no highlights first, A then B; P3 highlights first, B then A; P4 no highlights first, B then A. P0 is the pilot.

## Running it

```
npm install
ANTHROPIC_API_KEY=... node server.js
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key. Without it the server runs in **demo mode** with canned answers and says so on every screen; demo data must not be used. |
| `GEN_MODEL` | Generation model (default `claude-sonnet-5-5`). |
| `VERIFY_MODEL` | Verification model (default `claude-haiku-5-5`). |
| `RESEARCHER_KEY` | If set, the researcher page and `/api/r/*` require this key. |
| `DATA_DIR` | Where participant files and event logs are written. Defaults to the Railway volume's mount path when a volume is attached (`RAILWAY_VOLUME_MOUNT_PATH`), else `./data`. Without a volume the data vanishes on every redeploy. `/health` shows the directory in use. |
| `PORT` | Port (Railway sets it). |

Data: `DATA_DIR/participants/<code>.json` is the participant's current state; `DATA_DIR/events/<code>.jsonl` is the append-only event log (every turn with both model outputs, every rating, every highlight hover, every audit click). The researcher page exports both as one JSON file per participant.

## Files

* `server.js`: Express server, counterbalancing, memory profile, topic selection, prompts, model calls, demo fallback, logging, researcher API.
* `topics.json`: the eight opinion topics with their ProCon arguments (condensed from britannica.com/procon, accessed Oct 27 2026), the eight preference topics with four options each, the practice question, and the background items.
* `public/`: the participant app (`index.html`, `app.js`, `style.css`) and the researcher page (`researcher.html`).
* `legacy/prototype-oct19.html`: the clickable prototype submitted on Oct 19 (served at `/legacy/prototype-oct19.html`).
