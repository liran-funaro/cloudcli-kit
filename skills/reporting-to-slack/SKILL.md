---
name: reporting-to-slack
description: Use when a task has run long enough that the user may have stepped away, when reporting build/test/deploy results, when finishing background or unattended work, or when asked to notify, ping, or report on Slack
---

# Reporting to Slack

## Overview

`cloudcli-slack-report` posts a report to Slack through a Workflow Builder webhook
trigger. Outbound only — Slack cannot reply into the session.

## When to Use

- A build, test run, migration, or background job finished and the user probably
  isn't watching the terminal
- Unattended or scheduled work produced a result worth surfacing
- The user asked to be notified, pinged, or reported to on Slack

**Not for:** quick answers, routine progress chatter, or anything the user is
plainly watching happen. A notification they didn't need costs more than it gives.

## Quick Reference

    cloudcli-slack-report -t "Tests failed" -m ":x: 2 of 47 failing" -s "$(tail -40 test.log)"
    npm test 2>&1 | cloudcli-slack-report -t "Test run" -m ":test_tube: see detail"
    cloudcli-slack-report -C /path/to/repo -t "Deploy" -m ":rocket: v1.2.3 live"
    cloudcli-slack-report -n ...        # dry-run: prints the payload, sends nothing

`-t` and `-m` are required; everything else has a default. Run `--help` for all flags.

| Argument | Carries |
|---|---|
| `-t` | headline — what happened |
| `-m` | one-line status; `:emoji:` renders |
| `-s` | detail block; reads stdin when piped |
| `-C` | git directory, when cwd is not the repo being reported on |

## Common Mistakes

**Trusting exit 0 or `{"ok":true}` as proof of delivery.** That means the trigger
accepted the payload, not that the message posted — a workflow step can still fail
afterwards. Report the send as *sent*, not as *seen*.

**Sending markup for emphasis.** Newlines, indentation and `:emoji:` survive; `*bold*`
arrives literal. Styling lives in the Slack workflow editor, not the payload.

**Running it outside a git repo without `-C`.** Repo, branch and button URLs then have
nothing to resolve against and fall back; the report still sends but its links are
useless. Pass `-C` from systemd units, cron, or any unattended context.

**Pasting logs in raw.** Trim to what someone would act on. `-s` truncates at 2800
characters, so an untrimmed log loses its own tail.

## Setup

Requires `SLACK_REPORT_URL` (a Workflow Builder webhook trigger URL) in the
environment; without it the command exits 3 and sends nothing. `--dry-run` works
regardless, which is how to check a payload without posting.
