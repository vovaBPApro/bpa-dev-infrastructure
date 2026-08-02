commit: 70e559c2c1eec1b5e9b9b78dd4e8228a681426b2
code-sha: 2a4eb16a8983b376657bb58ba84919cad74b94f5
verify: clean — red-before: exit 1; dispatcher locks: 9 pass, 0 fail; foundation: 205 pass, 0 fail; bun build --target=bun: exit 0
result: NO-GO — landed schema lacks a fenced retry/release transition required after a controlled worker failure
secret-scan: clean — canonical scanner extracted from origin/v3 and run over origin/v3...HEAD
