---
name: reporting-to-slack
description: Use when a task has run long enough that the user may have stepped away, when reporting build/test/deploy results, when finishing background or unattended work, or when asked to notify, ping, or report on Slack
---

# Reporting to Slack

## Overview

`cloudcli-slack-report` posts a report to Slack through a Workflow Builder webhook
trigger. Outbound only — Slack cannot reply into the session.

## When to Use

**Report whenever the response wasn't immediate.** The user works in a terminal they
step away from, so a result that lands silently after several minutes is a result they
don't see until much later. That wait — not the outcome — is the trigger.

- A build, test run, migration, or background job finished — **including when it failed**
- Unattended or scheduled work produced a result worth surfacing
- The user asked to be notified, pinged, or reported to on Slack

Send it as the final step of slow work, not a stream of checkpoints.

**Not for:** quick answers, small edits, or anything the user is plainly watching happen.
Terminal output is enough there, and a notification they didn't need costs more than it gives.

## What each field carries

Write for a manager glancing at a phone with a few seconds to spare. The whole report
is read standing up, between other things. Three parts, three jobs:

- **`-t` headline** — a few words naming what happened: `Tests failed`, `Deploy finished`.
- **`-m` message** — **one short line**: the verdict and the number, legible on a lock
  screen. `:emoji:` renders here.
- **`-s` summary** — **three to five short lines, one point per line**: the finding, the
  cause if known, the next step. Newlines survive, so keep the lines separate.

Nothing in the message links out, so these three lines are everything the reader gets —
which is why they have to be the lines that matter and not the log. Read the log yourself
and write what it shows. Omit `-s` when the one line already said everything.

    cloudcli-slack-report -t "Tests failed" -m ":x: 2 of 47 failing" -s \
    "Both failures are in auth/session, not the new code.
    Token refresh 401s since the clock-skew change.
    Fix looks local to refreshToken()."

    cloudcli-slack-report -t "Deploy finished" -m ":rocket: staging up, 4m12s"
    cloudcli-slack-report -n ...        # dry-run: prints the payload, sends nothing

`-t` and `-m` are required; `-C` names the git directory when cwd is not the repo being
reported on. `--help` lists the rest.

## Common Mistakes

**Forwarding the log instead of summarizing it.** Nobody reads the wall, and `-s`
truncates at 2800 characters so an untrimmed `tail -40` loses its own tail as well.

**Trusting exit 0 or `{"ok":true}` as proof of delivery.** That means the trigger
accepted the payload, not that the message posted — a workflow step can still fail
afterwards. Report the send as *sent*, not as *seen*.

**Sending markup for emphasis.** `*bold*` arrives literal. Styling lives in the Slack
workflow editor, not the payload.

**Running it outside a git repo without `-C`.** The report still sends, but `repo` and
`branch` fall back to placeholders. Systemd units and cron need `-C`.

## Setup

Requires `SLACK_REPORT_URL` (a Workflow Builder webhook trigger URL) in the
environment; without it the command exits 3 and sends nothing. `--dry-run` works
regardless, which is how to check a payload without posting.
