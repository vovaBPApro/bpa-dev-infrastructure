# Parked-content promotion (L2 only)

This file is written into a new **L2 framework** repo only. When this repo is
registered (its creation is the trigger), the L2/L3 content parked in L1 flips
here.

Per `migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md` §2.1/§4.3 item 7, the L1
`instance/parked.md` manifest lists content that belongs in a lower layer but
lives in L1 because no target repo existed yet. Creating this L2 repo auto-flags
that whole list for promotion.

## Promotion procedure

1. Read the L1 `instance/parked.md` manifest. Each row names a parked file, its
   target layer, and the promotion trigger.
2. For each row whose target layer is L2 (framework), move the file here:
   change its frontmatter `layer:` from `L2-parked` to `L2`, drop the parked
   status, and delete the L1 copy in the same move-and-delete commit.
3. Leave a 5-line tombstone (`moved-to: <id>`) in L1 for one landing cycle so
   references resolve while lanes pick up the new home.
4. Remove the promoted row from L1 `instance/parked.md`. A parked file without a
   manifest row is a red check; so is a manifest row whose file has moved.
5. Run `tools/instructions/check.ts --strict` against both L1 and this repo to
   prove the promotion left both checker-clean.

The concrete parked rows are listed by `scaffold.ts --layer L2` at creation time
(a promotion TODO) and are the authoritative list — this note is the procedure.
