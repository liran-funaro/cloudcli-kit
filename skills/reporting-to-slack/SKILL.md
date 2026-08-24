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
- Any task with a noticeable wait, whatever the outcome
- The user asked to be notified, pinged, or reported to on Slack

Send it as the final step of slow work, not a stream of checkpoints.

**Not for:** quick answers, small edits, or anything the user is plainly watching happen.
Terminal output is enough there, and a notification they didn't need costs more than it gives.

## What each field carries

A report has three parts with three different jobs:

- **`-t` headline** — a few words naming what happened: `Tests failed`, `Deploy finished`.
- **`-m` message** — **one short line**: the result at a glance, a count and a verdict,
  legible on a lock screen. `:emoji:` renders here.
- **`-s` summary** — **all the context**: failing assertions, the log excerpt, what to do
  next. Multi-line; newlines and indentation survive.

The message is what they read *without* opening Slack. The summary is what they read when
they do. So the number goes in the message and the evidence goes in the summary.

    cloudcli-slack-report -t "Tests failed" -m ":x: 2 of 47 failing" -s "$(tail -40 test.log)"
    npm test 2>&1 | cloudcli-slack-report -t "Test run" -m ":test_tube: 47 passed"
    cloudcli-slack-report -n ...        # dry-run: prints the payload, sends nothing

`-t` and `-m` are required; `-C` names the git directory when cwd is not the repo being
reported on. `--help` lists the rest.

## Common Mistakes

**Trusting exit 0 or `{"ok":true}` as proof of delivery.** That means the trigger
accepted the payload, not that the message posted — a workflow step can still fail
afterwards. Report the send as *sent*, not as *seen*.

**Sending markup for emphasis.** `*bold*` arrives literal. Styling lives in the Slack
workflow editor, not the payload.

**Running it outside a git repo without `-C`.** The report still sends, but repo, branch
and every button URL fall back — so the links are useless. Systemd units and cron need `-C`.

**Pasting logs in raw.** `-s` truncates at 2800 characters, so an untrimmed log loses its
own tail. Send the part someone would act on.

## Setup

Requires `SLACK_REPORT_URL` (a Workflow Builder webhook trigger URL) in the
environment; without it the command exits 3 and sends nothing. `--dry-run` works
regardless, which is how to check a payload without posting.
