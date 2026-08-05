# A corrupted system symlink took the suite red, and the landing gate caught it, 2026-08-05

Recorded because two separate defects met here: something on this host rewrote a **packaged
system symlink** into a self-referential loop, and a pre-existing test fixture turns any
dangling symlink in a system `bin` directory into a suite failure. Neither is in the change
that was landing; both were found by `gate/land.sh` refusing that landing.

## What happened

The V3-2.12 recut (`2856a1a`) was ACCEPTed by review, its own exit gate passed, and
`gate/land.sh` **aborted** at the completion guard:

```
FAIL verify-run exit=1 … 643 pass | 1 fail
GUARD verdict=violation
LAND verdict=aborted sha=none
```

`origin/main` was never written. The failing test was
`shell tier: bootstrap/bootstrap.test.sh`, with:

```
ln: failed to create symbolic link '/tmp/tmp.XXXXXX/core-utils/X11': File exists
```

## Defect 1 — a packaged system symlink was rewritten into a self-loop

```
/usr/bin/X11 -> /bin/X11        (mtime 2026-08-05 02:59)
/bin -> /usr/bin                 (so the link resolves to itself)
readlink -f /usr/bin/X11         -> (empty; it is a loop)
```

`/usr/bin/X11` is owned by `x11-common` (`/var/lib/dpkg/info/x11-common.list`), and the
installed package version ships it as a link to `.`. Established by extracting the exact
cached `.deb` rather than assumed:

```
dpkg-deb -x /var/cache/apt/archives/x11-common_1%3a7.7+23ubuntu3_all.deb /tmp/x11probe
ls -la /tmp/x11probe/usr/bin/X11   ->   X11 -> .
```

**Repaired** with `ln -sfn . /usr/bin/X11`; `dpkg --verify x11-common` is now silent, and it
was the only self-looping symlink in `/usr/bin`.

**Cause not established.** A lane was running at 02:59 (the V3-2.12 coder lane), and the
only other writes in `/usr/bin` that night were none. The orchestrator ran no `ln` at that
time. What is certain is that the file was rewritten from its packaged target during this
session; what is not certain is by what. Stated as unresolved rather than guessed, because
guessing a culprit is how V3-0.44 came to be "fixed" against the wrong cause.

**If a lane did this, it is a containment breach** — a lane writing outside its worktree
into `/usr/bin` — and that is a larger problem than the symlink. It deserves its own row and
a mechanism, not a note.

## Defect 2 — the fixture treats a dangling symlink as absent

`bootstrap/bootstrap.test.sh` (pre-existing, from `9aa10e9`, **not** added by V3-2.12)
builds a fake `PATH` by symlinking every entry of `/usr/local/bin /usr/bin /bin /usr/sbin
/sbin` into a scratch directory, skipping duplicates with:

```sh
[[ -e "$CORE_PATH/$base" ]] && continue
ln -s "$real_bin" "$CORE_PATH/$base"
```

`-e` **follows** symlinks. Linking a broken source produces a dangling link in
`$CORE_PATH`, which `-e` then reports as absent — so the guard does not fire, `ln` runs
again, and fails with `File exists`. `/bin` is a symlink to `/usr/bin` on this host, so
every entry is visited twice and the second visit is the one that dies.

So the suite silently depends on **no dangling symlink existing anywhere in five system
directories** — ambient host state, exactly the class as V3-2.8 (a landing-gate test whose
verdict depends on mutable host state). The guard should test `-e … || -L …`, or the loop
should skip sources that do not resolve.

## What worked

The landing gate did its job. Three green runs preceded it — the lane's own, the reviewer's,
and the lane exit gate's — and all three ran in worktrees where the ambient state happened to
be benign at the time. The guard re-executes the declared verify command in its **own fresh
checkout**, which is what made the divergence visible, and it refused rather than reporting a
green from partial evidence.

This is the third time in two days that a result depended on *where* it was measured:
`inbox.jsonl` absent from `land-main` (the ledger check passing trivially), gawk versus mawk
in the meteorite container (V3-2.11), and now ambient symlink state on the host.

## Disposition

- The symlink is repaired and verified against the package.
- Defect 2 wants a row: a test that cannot survive a dangling symlink in `/usr/bin` is
  measuring the host, not the change.
- The containment question — whether a lane wrote to `/usr/bin` — wants its own row and is
  the more serious of the two.
- The V3-2.12 recut is unaffected: `bootstrap/bootstrap.test.sh` passes at `2856a1a` with no
  code change once the host is repaired. The landing may be re-attempted, and this file is
  the reason it is a re-attempt rather than a retry-until-green.
