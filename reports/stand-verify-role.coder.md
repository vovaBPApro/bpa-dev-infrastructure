commit: 9f65b22faf1daafc1c1844733e2aa6bbe20f4e53 [CODER] bootstrap read-only stand verifier
verify: STAND_VERIFY_CONFIG="$PWD/instance/live-stands/agentic-bpa-verifier.env" bash database/bootstrap-stand-verifier.sh && STAND_VERIFY_CONFIG="$PWD/instance/live-stands/agentic-bpa-verifier.env" bash database/stand-verifier.test.sh && bash bootstrap/bootstrap.test.sh
result: clean
secret-scan: clean
remaining: none

manifest: lane-lifecycle sha256:84d3db25d785 # Lane Lifecycle
manifest: verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
manifest: tool-permissions sha256:955630cc416e # Tool Permissions
manifest: repository-hygiene sha256:02acdffe2a56 # Repository Hygiene
manifest: isolated-test-environments sha256:6ffd35d7c9f1 # Isolated Test Environments
manifest: operator-feedback sha256:fc36fafe4623 # Operator Feedback
manifest: instruction-layers sha256:cd21f4ce0990 # Instruction Layers
manifest: branching-policy sha256:98cd92116325 # Branching Policy
manifest: reproducible-from-git sha256:822d9efe694b # Reproducible From Git
