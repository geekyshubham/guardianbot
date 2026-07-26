# ADR 0004: Local repository indexing

Status: Accepted.

Indexes are produced and stored within GuardianBot infrastructure so repository
text is not sent to an embedding provider. Index keys include repository and commit
identity. Related-repository retrieval requires bilateral allowlisting.
