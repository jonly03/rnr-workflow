# MVP v1 — Close the Loop (scoped 2026-11-14 ~00:05 EST, Pedro)

The v1 loop starts at a signed quote and ends at a finished invoice the client
can see and download. Nothing past that point is in v1.

## The loop

1. **Client signs the quote.**
2. **On signing, two things happen:**
   - The signed quote converts into an invoice. The invoice is created but
     NOT sent to the customer yet.
   - The parts order is triggered (order the parts for the job).
3. **Wait for the job to be done.** An admin / staff member marks the job
   complete. There is no tech assignment or dispatch in v1: the tech is
   Pedro himself, plus whoever goes with him. They do the fix, then someone
   clicks the button.
4. **Staff clicks "Job complete".** At that click they can add anything extra
   that was used on the job — glue, or any other extra expense. Those extras
   get added to the invoice.
5. **The invoice generates automatically** (final, with the extras included).
   The client can see that version of the invoice on their side, track it,
   and download it.
6. **End of v1.** The loop is closed here.

## Explicitly NOT in v1 — v2

- Trackers (job trackers, status trackers)
- Calendars and tech calendars
- Monitoring whether a job is done (status monitoring / dashboards)
- Text tracking / SMS tracking
- Calendar syncing
- (The text and calendar hookups come later, in v2.)

## Decision — confirmed by Pedro 2026-11-14 00:08 EST

**The client's signature IS the go-ahead for the parts order.** When the
client signs the quote, the parts order goes out right away — no extra tap
from Pedro first. This resolves the open point above and overrides the
standing "nothing orders without Pedro's go-ahead" rule for this one step:
the signature is the go-ahead.

## Where this lives

- Case Core is the case/intake system (the "original repository" is
  jonly03/rnr-workflow — the repo the team fought with on deploys).
- The gateway already has: quote, create_case, get_case_status, order_glass
  (staff-only). What v1 still needs built: quote-sign → invoice (draft,
  unsent) + order trigger; job-complete button with extras; auto invoice
  generation; client invoice view + download.
- Nothing merges to main without Pedro + Lou. Lou black-box tests each layer.
