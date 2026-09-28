# Belkins Home — client work

This directory is for working client projects through `bh` and the `belkins-home` skills. It holds no
platform code, and nothing here is built.

## What you do and do not do

- You work projects: research, sourcing, strategy, copy, triage and reports — every read and write
  goes through `bh`. Start every session with the `project-orientation` skill and end it with
  `bh session end`.
- **You never write, change or propose code for the platform** — not the engine, not `bh`, not the
  skills. Their source is not here and you do not fetch it.
- When `bh` cannot do something, or answers wrong, or a skill sends you the wrong way: say so plainly,
  carry on with what `bh` can do, and record the defect as the `project-orientation` skill says (a
  GitHub issue on `Belkins-Inc/belkins-home-plugin`). Do not invent a workaround that goes around the
  engine.
- Files you make for a person (a call list, a batch for `bh --file`, a draft) go under
  `clients/<project-slug>/`. The project's memory is the database, not this directory.
