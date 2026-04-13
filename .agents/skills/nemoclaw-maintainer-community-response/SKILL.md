---
name: nemoclaw-maintainer-community-response
description: Drafts community-facing responses to GitHub issues and PRs for NemoClaw maintainers. For each item, recommends an action (comment, close, close+comment, request changes, escalate) and drafts the response text. Handles won't-fix closures, out-of-scope closures, superseded PRs, poorly designed PR rejections, security acknowledgments, duplicate issues, feature request routing, needs-info labeling, and general triage. Logs approved responses locally to .nemoclaw-maintainer/community-responses.md. Tone: community first, firm and friendly. Trigger keywords - respond to issue, close issue, respond to PR, community response, won't fix, out of scope, reject PR, triage response, draft response, what should I say, needs info, duplicate issue, feature request.
user_invocable: true
---

# NemoClaw Maintainer — Community Response

Draft a response to a GitHub issue or PR, recommend an action, and log the approved response.

**Tone:** Community first, firm and friendly. Lead with acknowledgment. Hold the line when needed. Never dismissive.

## Step 1: Read the Guide

Before drafting, read the current quick reference:

```bash
cat docs/maintainer-guide-snippet.md
```

Do not draft from memory. The guide may have been updated.

## Step 2: Gather Context

Ask the user (or infer from context) for:

- Issue or PR number and title
- Body text (or summary if long)
- Any existing comments relevant to the response
- Whether this is an issue or a PR

If the user provides a URL or number only, ask for the body text — don't assume.

## Step 3: Identify the Situation

Map the item to one of the situations in the guide:

| Situation | When |
|---|---|
| Won't fix / out of scope / needs design | Valid item, but won't be addressed or is outside scope |
| Superseded PR | Another PR was merged that covers the same ground |
| Security acknowledgment | Contributor reported or fixed a vulnerability |
| Poorly designed PR | PR cannot merge as-is; needs specific changes |
| Duplicate | Same issue or PR already exists |
| Feature request | Valid suggestion, not a bug, not in current scope |
| Redirect to Discussions | Open-ended question or design topic, not actionable |
| Triage acknowledgment | Valid open issue, confirmed, no timeline yet |
| Needs info (first contact) | Can't investigate without more information from contributor |
| Needs info (close) | Already labeled `status: needs-info`, 7+ days, no response |

If the situation is ambiguous, ask: "Is this a closure, a needs-info, a routing decision, or something else?"

## Step 4: Recommend an Action and Project Status

State the recommended action and **project status** clearly before drafting. The project status field must be set on every item — do not leave it as "Done" by default.

**Actions:**

| Action | When |
|---|---|
| `comment` | Post a reply, leave open (triage ack, needs-info first contact, redirect to Discussions) |
| `close` | Close with comment |
| `request changes` | PR needs revision — post comment, leave open |
| `escalate` | Security report that should go through PSIRT — do not respond publicly |

**Project status mapping (NemoClaw Development Tracker):**

| Situation | Project Status |
|---|---|
| Won't fix | `Won't Fix` |
| Out of scope / needs design | `Won't Fix` |
| Duplicate / superseded PR | `Duplicate` |
| Feature request (backlog) | `Backlog` |
| Feature request (active) | `In Progress` |
| Needs review / poorly designed PR | `Needs Review` |
| Triage acknowledgment (confirmed, backlogged) | `Backlog` |
| Needs info (first contact or close) | `No Status` |
| Completed / merged | `Done` |
| NVQA-tracked item | `NVQA` |

Always present as: **Action:** `close` · **Project status:** `Won't Fix`

## Step 5: Draft the Response

Write the response following the template from the guide. Apply these rules:

- **Always explain why** when closing — never close silently.
- **Acknowledge contributors** when their work informed a solution, even if it didn't land.
- **Be specific** — name the exact reason, the exact information needed, the exact problem with the PR.
- **One sentence on why.** Not a paragraph. Not a list.
- Write in second person, direct address to the contributor.
- Warm but specific — generic phrases without substance read as dismissive.
- Never reference internal systems, roadmap items, or org decisions that shouldn't be public.

## Step 6: Present for Approval

Show the user:

1. **Recommended action and project status** (e.g., `close` · project status: `Won't Fix`)
2. **Draft response** (ready to paste into GitHub)
3. Any follow-up note (e.g., "add the label before closing")

Ask: "Want me to adjust the tone or any specific wording?"

## Step 7: Log the Approved Response

When the user approves, append to `.nemoclaw-maintainer/community-responses.md`:

```
## [ISSUE|PR] NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Action:** comment | close | close+comment | request changes | escalate
**Label:** <label if closing>

**Response:**
<approved response text>

---
```

Create the file and directory if they don't exist. This file is gitignored and local only — never stage or commit it.

## Response Time Check

If the user asks whether a response window is at risk, check against:

| Situation | Target |
|---|---|
| New issue | First response ≤ 5 business days |
| Open PR, no review | First comment ≤ 7 business days |
| Contributor asks for update | Reply ≤ 3 business days |
| `status: needs-info` labeled | Close if no response after 7 days |

A window is "at risk" when 80% of the target has elapsed. Surface as a flag, not an alarm.
