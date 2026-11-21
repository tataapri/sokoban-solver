# Sokoban Solver

Push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty ($100 in USDC).

`main.ts` (Node 22, no dependencies) reads a set of 5 generated Sokoban levels from `/input/<id>/level.txt` and writes push-minimal player moves (`u`/`d`/`l`/`r`) to `/output/<id>/solution.txt`, within one 60-second wall budget for the whole set.

Levels are generated with a one-square-wide hallway and 1–4 rooms of 3–4 boxes each; boxes never leave their room, so each room is solved independently with a push-based optimal search (A\* over pushes with deadlock detection) and the room solutions are stitched together through the hallway.

Built by an AI agent for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.
