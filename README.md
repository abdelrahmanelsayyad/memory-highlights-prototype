# Memory Highlights Prototype

Clickable prototype for a CMPUT 656 (University of Alberta) term project on whether people notice when an AI assistant's memory of them biases its answers, and whether highlighting where memory was used changes their trust.

It shows every screen a participant sees:

1. Session 1 profile questionnaire
2. Session 2 memory review
3. Part A: read an answer and rate trust
4. Part B: see the same answer again and judge whether it is one-sided
5. Debrief

The dashed strip at the top holds researcher controls (not part of the participant view). Use it to switch between the highlight and no-highlight versions, balanced and biased answers, and the two example questions.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Deploy on Railway

1. Create a new Railway project from this GitHub repository.
2. Railway installs the dependencies and runs `npm start`, which serves the `public` folder on the port Railway provides.
3. Under Settings, Networking, generate a public domain.

## Links to specific screens

Add a hash to the URL to open a specific state, for example:

- `#partA-a-biased-hl` sycophantic answer, highlight version
- `#partA-a-balanced-hl` balanced answer, highlight version
- `#partA-a-biased-plain` sycophantic answer, no highlights
- `#partA-b-biased-hl-tip` narrowed answer with the hover note open
- `#partB-a-biased-hl` Part B bias judgment
- `#memory`, `#profile`, `#debrief`
