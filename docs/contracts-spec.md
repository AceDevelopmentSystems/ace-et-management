# Contracts and work orders

Scheduled maintenance, as the legacy system did it (mowing every month, an annual aircon service), rebuilt around three
ideas: a schedule is data, generation is safe to repeat, and nothing is ever really deleted.

## Model
- **Contractor** — a firm that does the work. Belongs to the *organisation*, not a client, because a consultancy shares its
  contractors across clients. Name is unique per organisation.
- **Contract** — an agreement between a client and a contractor: `code` (unique per client), `status`
  (`draft` | `active` | `closed`), `start_date`, `end_date`.
- **Contract line** — one scheduled job: a **site or an asset** (exactly one), a description, how often (every N
  days/weeks/months/years), the first due date, and the cost of each visit.
- **Work order** — one occurrence of a line, due on a date. Status `new` → `in_progress` → `complete`, or `cancelled`.
  Carries an estimated cost (copied from the line when generated) and, once done, a completion date and actual cost.
  Shown as `<contract code>-0001`, numbered per contract.

## Schedules (`packages/schedule`)
Pure functions over date-only strings, so results never depend on the machine's time zone or daylight saving.
- Occurrences are always counted from the line's **first due date**, never from the previous occurrence, so a monthly job
  first due on 31 January falls on 28 Feb, 31 Mar, 30 Apr and does not drift to the 28th.
- A month-end day clamps to the last day of a shorter month; 29 Feb yearly falls on 28 Feb in non-leap years.
- The same occurrences come out however a window is split, which is what makes generating in pieces safe.
- Guards: interval 1–120, at most 5000 occurrences per call.

## Generating work orders
`POST /contracts/:id/generate` with `{ through, from?, dryRun? }` creates the work orders due in the window.
- **Repeatable.** An occurrence (line + due date) can exist only once (a unique key), so running again, or two runs at the
  same moment, never duplicates. The contract row is locked during generation, so numbering has no gaps from races.
- **Deleted work orders stay deleted.** They still count as existing, so the next run does not bring them back. Restore
  them from the Trash if you want them.
- `dryRun` reports what would be created (and a sample) without creating anything. `from` skips earlier dates, for example
  to avoid creating a backlog for a contract that started months ago.
- Only an **active** contract generates. The window may not go more than 5 years ahead. Work for an **asset** line is
  placed at the asset's site.
- Numbering is by due date, then site code, then description, so it is the same however the contract was built.
- Editing a line (or the contract's dates) affects work orders generated from then on; existing ones are left alone.

## Status flow
`new` → `in_progress`, `complete`, `cancelled`; `in_progress` → `new`, `complete`, `cancelled`; `complete` → `in_progress`
(reopen); `cancelled` → `new`. Completing records the date (default today, never in the future) and, optionally, the actual
cost and notes. Leaving `complete` clears the date but keeps the cost. Anything else is a 409.

## Deleting (soft)
Everything here follows the rules in `apps/api/README.md#soft-delete`.
- A **contractor** used by a live contract, and a **site** or **asset** on a live contract line, cannot be deleted until
  that is resolved (409).
- Deleting a **contract** deletes its lines and work orders with it; deleting a **site** also deletes its work orders;
  deleting an **asset** deletes its work orders; deleting a **client** takes its contracts, lines and work orders. Restoring
  the parent brings back exactly what went with it and nothing that was deleted earlier on its own.
- A restore that would leave something live pointing at something deleted (a contract whose contractor is deleted, a work
  order whose site is deleted, ...) is refused with a clear message and nothing changes.

## Not built yet
Ad hoc work orders (the table already allows a work order with no contract), accounting export, attachments, import and the inbound API for invoices (see `invoices-spec.md`; the system records invoices and never makes payments), a contractor
portal (the `contractor` role has no access yet), and notifications for overdue work.
