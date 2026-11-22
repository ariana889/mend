# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ariana889/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ariana889/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in every format they write them, to a
tree of text files — and changes every file or none.

Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
V4A patch format, and text-editor tool calls as JSON. `main.ts` reads all four to one written specification
(`SPEC.md`), finds the lines an edit names even when the model drifted their whitespace or indentation (three
matching tiers: exact, trailing-whitespace-insensitive, fully trim-insensitive with re-indentation), and applies
the patch atomically: if any edit fails, nothing is written and every failure is reported.

Exit code 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and an
`ok: <n> files` summary. Exit code 1 prints one `error: <code> <path>` line per failed edit and a
`failed: <k> of <n> edits` summary. Exit code 2 prints a single usage, no-patch, format or parse error line.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; with no argument (or `-`) the patch is read from standard input.
- `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the
  format from the patch text).
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner, kept as it is; `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL`
  is set.
- `SPEC.md`: the specification `main.ts` implements, sentence by sentence.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mr-omo&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
