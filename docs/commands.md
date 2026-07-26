# Pull request commands

Commands are issue comments on a pull request:

- `@guardianbot review`: incremental review from the last head SHA.
- `@guardianbot full-review`: discard incremental scope and review bounded clusters.
- `@guardianbot status`: show App, index, backend, and scanner state.
- `@guardianbot explain <id>`: explain evidence and impact.
- `@guardianbot suggest-fix <id>`: produce a human-applicable suggestion.
- `@guardianbot pause` and `resume`: control automatic advisory review.
- `@guardianbot help`: list commands.

The PoC executes automatic review, `status`, and `help`. It acknowledges the
remaining commands without claiming execution; full command state and suggestion
posting remain roadmap work. Deterministic checks cannot be bypassed by comments.
