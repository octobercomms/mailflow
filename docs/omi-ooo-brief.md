# OMI integration brief: out-of-office contact updates

Status: contract proposal for the OMI side. MailFlow's outbound push is not yet
wired. This document defines what MailFlow will send and what OMI needs to
expose so the OMI agent can build the receiving end now, ready to switch on.

## Purpose

MailFlow scans auto-reply / out-of-office messages across every account and
folder, extracts any lasting contact change, and produces a reviewable
suggestion. MailFlow does the detection and extraction. OMI owns the review
queue, the approve/apply decision, and the contact record itself. A person
approves each change before anything is written.

Division of responsibility:

| Concern | Owner |
|---|---|
| Detect out-of-office replies | MailFlow |
| Extract the change (new address, new employer, alternate contact) | MailFlow |
| De-duplicate by sender, avoid re-charging | MailFlow |
| Hold the review queue | OMI |
| Classify the contact (journalist, client, contractor, general) | OMI |
| Approve and apply the change to the contact record | OMI |
| Notify the person there is a queue to review | MailFlow (email) |

## What MailFlow sends

One suggestion per lasting change, de-duplicated by sender. MailFlow only sends
suggestions that carry an actual change. Vacation-only replies are dropped and
never sent.

Two categories:

- `left_or_moved`: the sender has left, changed employer, or given a new
  personal address. The `person` block carries the change.
- `mentions_alt_contact`: the message names someone else to contact, or an
  alternate address for the sender. The `alt_contacts` array carries them.

### Payload

MailFlow will POST a batch. Each item:

```json
{
  "id": "b3f1c2a4-...",
  "category": "left_or_moved",
  "person": {
    "name": "Jane Doe",
    "current_email": "jane.doe@oldfirm.com",
    "new_email": "jane@newstudio.com",
    "new_company": "New Studio",
    "role": "Head of Communications"
  },
  "alt_contacts": [
    { "name": "Tom Reed", "email": "tom@oldfirm.com", "role": "Press enquiries", "company": "Old Firm" }
  ],
  "source": {
    "from_email": "jane.doe@oldfirm.com",
    "subject": "Automatic reply: ...",
    "quote": "I have left Old Firm. Please contact me at jane@newstudio.com.",
    "message_date": "2026-03-14T09:26:00Z"
  },
  "confidence": 0.9,
  "detected_at": "2026-10-01T07:00:12Z"
}
```

Field notes:

- `id` is MailFlow's suggestion UUID. Stable and unique. Use it as the
  idempotency key so a re-send never creates a duplicate in the queue.
- Any email address in the payload was present verbatim in the email. MailFlow
  never invents or guesses an address. An address that failed a basic format
  check is dropped rather than sent.
- `current_email` / `from_email` is the address MailFlow already holds for the
  person, so OMI can match the suggestion to an existing contact.
- `confidence` is the model's 0 to 1 self-rating. Low confidence is still sent;
  it is a sort key for review, not a filter.
- Fields can be null. `left_or_moved` always carries at least a `new_email` or
  a `new_company`. `mentions_alt_contact` always carries at least one entry in
  `alt_contacts`.

## What OMI needs to expose

An authenticated endpoint that accepts a batch of suggestions:

```
POST /api/ooo/suggestions
Authorization: Bearer <shared token>
Content-Type: application/json

{ "user": "<identifier>", "suggestions": [ ...items... ] }
```

Requirements:

- **Idempotent on `id`.** Re-posting the same `id` updates in place, never
  duplicates. MailFlow may retry.
- **Return per-item status** so MailFlow can mark its own rows `pushed`:
  `{ "results": [ { "id": "...", "accepted": true } ] }`.
- **Auth** by a shared bearer token, configured at both ends. No user
  credentials cross the boundary.

Optional, for a later phase: a callback so MailFlow learns the outcome
(`applied` / `dismissed`) and can reflect it. Not required for launch.

## The classification gap OMI owns

MailFlow reads one auto-reply in isolation. It does not know whether the sender
is a journalist, a client, a contractor, or a general contact, and it should
not guess. That judgement needs the contact's history and the wider
relationship, which lives in OMI.

Brief the OMI agent to, on each suggestion:

1. Match `current_email` / `from_email` to an existing contact.
2. Apply OMI's own contact taxonomy (journalist, client, supplier, prospect,
   general) from that contact's record and history.
3. Weight the review by that class. A journalist's new masthead or a client's
   new firm matters more than a general contact's away note. Route or flag
   accordingly.
4. For `mentions_alt_contact`, decide whether the named person is worth adding
   as a new contact, and in which class, before creating anything.

MailFlow will not send this classification and does not need it back. It is
OMI's to own.

## Volumes

From the production mailbox: a full-history first sweep is roughly 244 unique
senders, de-duplicated. Expect a one-off batch of that order on the first run,
then a handful per day on the incremental daily pass. Size the endpoint for a
few hundred items in one batch, not thousands.

## Handling and privacy

- Suggestions are proposals. Nothing is applied until a person approves it in
  OMI.
- The `quote` is a short verbatim snippet for the reviewer's context, capped at
  200 characters.
- No message bodies, credentials, or account settings cross the boundary. Only
  the extracted fields above.
