# Security policy

[Manuel Bissinger (DigitalIQ)](https://github.com/DigitalIQ) maintains
`tabwerk-session-codec` and is responsible for reviewing security reports and
coordinating fixes. Security fixes target the latest released package version.

Please [report vulnerabilities privately through GitHub](https://github.com/DigitalIQ/tabwerk/security/advisories/new).
Private vulnerability reporting is enabled for DigitalIQ/tabwerk. Do not post
exploit details in a public issue while a private report is being coordinated.
No response-time or bounty commitment is made.

Include the package version, runtime version, a minimal synthetic input, expected
and observed behavior, and any reproduction steps. Do not include real browsing
histories, credentials or personal session exports when synthetic data suffices.

The v1 API validates browser-window data, verifies block hashes and bounds
compression/decompression. A hash does not authenticate the sender. References
are not signed, and session contents are not encrypted. Consumers remain
responsible for navigation policy, archive-wide limits, storage transactions and
concurrency. Per-call limits are not a strict process-memory or CPU sandbox.

The `/legacy` API intentionally preserves Tabwerk v0 behavior, including its
unbounded decoder. It is for trusted local archives and must not be exposed as an
untrusted upload/import endpoint. Use a separate bounded conversion process if
untrusted legacy data must be accepted.
