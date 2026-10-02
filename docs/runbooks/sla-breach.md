# Finding SLA breach

The `findings-sla` monitoring alert means at least one open deterministic
scanner finding is past its SLA due date. `findings-ticketing` means a ticket or
notifier update failed and is being retried.

1. Identify the repository from the alert. Use the weekly report `findings`
   section for counts by severity, owner, and age bucket; it never contains
   finding text.
2. Confirm the finding is still present in the latest accepted default-branch
   or deployed-digest scan. A finding is fixed only after a later complete scan
   of the same stream no longer reports it, so a scanner error or truncated
   report keeps it open.
3. Route the fix to the resolved owner. An `unowned` finding needs a CODEOWNERS
   entry or a `findings.ownership` rule before it can be routed.
4. If the risk is accepted, add a dated suppression with an owner, ticket, and
   a reason beginning `risk accepted`. Never extend an expired suppression
   silently; follow [suppression expiry](suppression-expiry.md).
5. For `findings-ticketing`, check the sanitized error kind on the lifecycle
   record (provider, method, and HTTP status), then the referenced credential
   and provider availability. Do not paste tokens or webhook URLs into tickets
   or logs.

Failure policy:

- An unreadable SLA due date counts as breached.
- AI review findings never open, close, or waive a lifecycle record.
- Ticket failures never block scanner acceptance and are never dropped; they
  stay visible until a retry succeeds.
