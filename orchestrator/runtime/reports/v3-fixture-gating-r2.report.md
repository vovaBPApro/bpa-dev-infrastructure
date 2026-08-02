commit: 9ac443707933459d62a6f6ce36b3ba971611a99f [CODER] Narrow donor fixture parity guards
verify: bun test daemon && bun test
result: NO-GO
secret-scan: clean
remaining: root bun test is blocked by watchdog-transport-boundary timeout waiting for successful send; daemon suite is 152 pass / 0 skip / 0 fail, including 26 donor seam assertions
