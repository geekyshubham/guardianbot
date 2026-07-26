# DefectDojo

For the PoC, DefectDojo is self-hosted on DigitalOcean. Use one product per GitHub
repository, engagements by branch/scan profile, and tests by scanner plus immutable
run identity. Tag imports with repository ID, commit SHA, workflow run, visibility,
image digest, and environment.

Reimport the same logical test so DefectDojo closes absent findings and preserves
deduplication. GuardianBot stable fingerprints supplement, but do not replace,
scanner identifiers. A successful import acknowledgement is evidence; in enforce
mode a required import failure blocks the gate while artifacts remain available
for replay.
