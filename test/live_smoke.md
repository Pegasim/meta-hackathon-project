# Live smoke

A checklist a human arms. The agent never runs it on its own initiative.
Not part of the automated suite. Run it before recording the demo video.

## Preconditions

- The extension loaded unpacked (the `src/` folder) in the user's real Chrome from the branch under test.
- A Meta Model API key pasted in the options page; the provider set to
  `meta`.
- The demo brain (`demo/brain/`) connected from the options page.
- `npm test` and `npm run test:e2e` green on the same commit.

## Budget

- No cost limit for the hackathon. One run is about 15 minutes of browsing.
- Stop early on any uncaught error in the service worker console, or if the
  avatar appears on a related page.

## Arm

The human types `arm smoke` in the conversation. Approval covers one run.

## Steps

1. Open Chrome fresh — expect the avatar to start the conversation and offer the
   unfinished goal from the demo brain.
2. Accept the goal, then work on related pages for 3 minutes — expect no nudge.
3. Go to an unrelated YouTube video and stay — expect L1 (avatar looks) and then
   L2 (bubble) after the tolerance.
4. Press *Take me back* — expect the last related tab in front.
5. Open a borderline page and press *This is for my task* — revisit it later and
   expect no nudge.
6. Hop quickly between unrelated tabs — expect no fragmentation nudge (off by default,
   #30); with `fragmentation: true` in the attention config, expect it.
7. Switch to Do Not Disturb and drift — expect no intervention, and a suppressed
   trigger in the event log.
8. Export the event log from the options page — expect every step above in it.
9. Reset settings and remove the demo brain — expect a clean state.

## Record

Results go to `docs/plans/` next to the plan being verified, with the date, the
commit SHA, the exported event log path, and every step marked `passed`,
`failed`, or `skipped` with a reason.
