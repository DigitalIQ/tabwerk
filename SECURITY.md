# Security policy

[Manuel Bissinger (DigitalIQ)](https://github.com/DigitalIQ) maintains Tabwerk and
`tabwerk-session-codec`, reviews security reports and coordinates security fixes.
Fixes target the latest released version of each project.

This responsibility also covers the experimental Delta store and browser backup
prototype in `examples/garrison-backup-benchmark`. It is research code, separate
from the released npm package. For reports about this prototype, include the Git
commit and use synthetic inputs. Its hashes detect corruption; they do not
authenticate data supplied by an attacker.

Use [GitHub private vulnerability reporting](https://github.com/DigitalIQ/tabwerk/security/advisories/new)
to report a vulnerability. This channel is enabled for this repository. Include
the affected component and version, runtime, expected and observed behavior, and
minimal reproduction steps using synthetic data. Do not attach credentials or
real browsing histories when synthetic input suffices.

Do not publish exploit details in an issue while a private report is being
coordinated. This project makes no response-time or bounty commitment.

The codec's input limits, integrity guarantees and legacy restrictions are
documented in its [package security policy](packages/session-codec/SECURITY.md).
