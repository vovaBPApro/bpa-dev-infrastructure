---
id: telegram-archive-recovery
status: informational
date: 2026-08-01
workboard: W-30
---

# Telegram archive recovery

## Verdict

`NO-GO`: the full archive contains canonical secret-signature hits and therefore
must not enter Git. Its restricted local location is now documented, but no
off-host encrypted backup target is provisioned, so it still fails the meteorite
test. The bounded next action is to provision that target, copy and verify these
three SHA-256-addressed files without changing the originals, then build and
review a redacted derivative using the plan in `instance/README.md`.

## Read-only inventory

All originals are owned by `root:root`. The directory is mode `0700`; every file
is mode `0600`.

| File | Bytes | Lines | Format and coverage | SHA-256 |
| --- | ---: | ---: | --- | --- |
| `vova-telegram-FULL-two-sided.txt` | 3,167,523 | 23,232 | UTF-8 plain text; 3,217 chronological inbound/outbound events, 2026-06-30..2026-07-31 | `3478a1d2d6a7dbf994f19dad58ca4924653c0d754d2bd911c051b9e87c689d74` |
| `vova-telegram-by-message-id.txt` | 355,229 | 3,849 | UTF-8 plain text; 876 distinct inbound messages grouped by message id | `408ddba949b8bc715246cecdea8f1efb685b9313cffe22d29ca2208e1a26c346` |
| `vova-telegram-raw-all.txt` | 396,487 | 3,850 | UTF-8 plain text; 876 raw inbound occurrences with source transcript identifiers | `434e996fde5182313817414ad610aabda2935058f3f53c5fe0620d245f94d20f` |

## Encoding diagnosis

`iconv -f UTF-8 -t UTF-8` accepts every byte of all three files. The bytes are
already valid UTF-8; conversion would corrupt the originals, so no converter is
needed. The reported broken Cyrillic is consistent with a renderer decoding the
UTF-8 bytes as a single-byte Western encoding. Three non-sensitive samples show
the reversible display error:

| Wrong renderer (before) | UTF-8 rendering (after) |
| --- | --- |
| `РџСЂРѕСЃРєР°РЅСѓР№` | `Проскануй` |
| `РїРѕРІС–РґРѕРјР»РµРЅРЅСЏ` | `повідомлення` |
| `РўР°РєРѕР¶ РїС–РґРЅС–РјРё` | `Також підніми` |

Recovery is therefore lossless: use an explicitly UTF-8-capable viewer (or set
its charset to UTF-8). The proof does not require rewriting any archive byte.

## Canonical secret scan

The scan extracted the pattern at runtime from `secret_pattern` in
`gate/land-lib.sh`; no signature text or matched content is reproduced here.
There are 7 file occurrences (duplicates across the three representations are
expected):

| File | Hits | Rough line locations (500-line buckets) |
| --- | ---: | --- |
| `vova-telegram-FULL-two-sided.txt` | 3 | 1-500, 2501-3000, 3001-3500 |
| `vova-telegram-by-message-id.txt` | 2 | 1-500 |
| `vova-telegram-raw-all.txt` | 2 | 1-500 |

This count covers the canonical direct signature scan of the entire archive.
Because it is non-zero, the preservation decision is fail-closed: full files
remain outside Git at the restricted path documented in `instance/README.md`.

## Instruction-pack consumption check

- `lane-lifecycle` `sha256:84d3db25d785` — Lane Lifecycle
- `verification-and-locks` `sha256:b13ed13070c1` — Verification and Regression Locks
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `repository-hygiene` `sha256:02acdffe2a56` — Repository Hygiene
- `isolated-test-environments` `sha256:6ffd35d7c9f1` — Isolated Test Environments
- `operator-feedback` `sha256:6dc6f5d4768f` — Operator Feedback
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `branching-policy` `sha256:98cd92116325` — Branching Policy
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git
