# OLD contract fixture provenance

These files are immutable behavioral references, not production imports.

Donor TypeScript tests whose implementation modules were intentionally not
imported remain visible to Bun discovery with an explicit file-level
`test.skip` guard. Each such fixture carries a grep-able `PARITY-GUARD` comment
naming its parity classification and the v3 integration test that arms the
retained contract; arming means replacing the guard with imports from the v3
seam, not restoring donor implementation modules.

- Donor repository: `/root/legacy-donors/bpa-master`
- Donor commit: `d0a99b8439f2731654e23b5e7759961f4602d0d3`
- Imported paths: the paths beneath this directory preserve their donor suffixes.
- Import method: `git archive` from the exact donor commit above.
- Rescue reference (not imported): `5c8206be024f49538696d6237021ce4e4a70b5ca`

No donor history, runtime state, credentials, host constants, product packages,
or implementation modules were imported.
