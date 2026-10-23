# Lane done protocol

Give this file to every lane you launch.

When your lane's `Done =` signals are live and every change is pushed, claim done from your own session. The signals might be a PR merged, an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). Run them yourself first: the watcher re-runs every one and never takes your word for it.

If your footer says to report with `dori report`, claim done the same way:

```sh
dori report <your-lane-key> done --text "<one line>" --evidence "<merge SHA, closed issue, version, links>"
```

The supervisor turns that row into the same claim within a few seconds. `dori claim-done` (below) still works and records the same claim at once.

```sh
dori claim-done <your-lane-key> --evidence "<merge SHA, closed issue, version, links>"
```

The key is in your brief's lane footer. With `claim-done`, if you leave it out, the lane registered for your pane is used.

## Reporting before done

Follow your footer. A footer that names `dori report` means: report only with `dori report <key> <milestone|progress|question|blocked> --text "..."`, and never type into the Dori's pane. `question` and `blocked` wake the Dori, `milestone` reaches it with its next update, and `progress` is posted to your work thread. Text typed into the Dori's pane by such a lane is counted against it (`LANE_PANE_VIOLATION`). An older footer that asks you to send `[REPORT] <key> | <kind> | <what>` lines to the Dori's pane still works; keep using it for the lane's whole life.

A lane on another machine (`dori launch --machine`) has no `dori` there: it prints `[REPORT] <key> | done | <evidence>` in its own pane instead. The watcher reads that line and records the same claim for it, so everything below applies unchanged (remote worktree checks are skipped and say so in the close receipt). A new `blocker` or `question` report wakes the Dori the same way. A claim is recorded once per distinct line, so a re-claim after an objection needs new evidence text.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. A lane whose PR is confirmed merged (the supervisor merged it, or GitHub reports a PR merged into `dev` from your worktree branch at its HEAD) closes on the next pass instead, and its merged branch is deleted locally and on the remote. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted changes, untracked files (gitignored ones don't count), or commits that are on no remote.
4. Closing removes your worktrees first, then marks your thread done (when a thread hook is configured, and only if no other open lane shares it), then closes your tab. A worktree that cannot be removed then (for example untracked files) is listed as kept in the close receipt; the watcher removes it later once it is clean, only under `worktreeRoot`, and reports `WORKTREE_CLEANED`. A lane that has not closed never loses a worktree to that sweep, even after its PR merged.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.

## Messages from the supervisor

A `[LEAD]` line that ends with `dori report ack <id>` (for example failing CI on your PR) needs that confirmation: run `dori report ack <id>` once you have read it, then act on it. Keep your own CI wait; the message does not replace it. Without the ack the lead is told after 20 minutes. When your PR is green and mergeable into `dev`, the supervisor may merge it for you; a conflict with `dev` may get its own merge lane.

## When the window starts

The window starts when the Dori actually receives your claim, not when you make it: a claim that waits behind a restarting lead still gets the full 5 minutes after it arrives, and your `[LEAD]` line says so instead of naming a time. A brief that declares `autoClose: machine` on a line of its own (its `Done =` signals settle it alone) closes 5 minutes after the claim without waking the Dori; the footer says so. An objection or a failing signal still reaches the Dori as usual.

## What you may touch

`dori launch` sets `DORI_LANE_KEY` in your lane. From inside it, `claim-done`, `object-done`, `close`, `pause` and `resume` work only on your own key, and `dori send` only to your own thread. You may not run `ack`, `handled`, `launch`, `adopt`, `hold`, `lead-restart` or `lead-emergency` at all. Anything else exits 1 with `LANE_PERMISSION_DENIED`. Ask the Dori instead. A manual `dori close` runs the same worktree checks as the watcher and refuses with `REFUSED <key>: ...`; only the Dori uses `--force`.
