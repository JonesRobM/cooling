# PC Airflow Simulator Implementation Plan

> **For agentic workers:** executed inline in the authoring session (superpowers:executing-plans, without commits: the owner commits). Steps use checkbox syntax.

**Goal:** A browser app in which the owner edits fan layouts for their PC and sees the airflow and indicative temperatures respond.

**Architecture:** A pure TypeScript model (layout, voxelisation, thermal estimate, metrics) tested under Vitest; a WebGPU compute solver on a staggered grid; a three.js (WebGL) front end that draws from periodic read-backs of the solver fields.

**Tech Stack:** TypeScript (strict), Vite, Vitest, three.js, WGSL.

**Spec:** `docs/superpowers/specs/2026-11-27-airflow-sim-design.md`

## Global Constraints

- Grid 88 × 92 × 38 cells of 5 mm (440 × 460 × 190 mm).
- `Q = Q_rated × RPM / RPM_rated`; show CFM and m³/h.
- British English in identifiers and text (external APIs excepted).
- The default layout is labelled "My PC". No connection to, or hostname of, the real machine.
- No back end. No commits.

## Decisions that refine the spec

- Visualisation reads the fields back to the CPU a few times a second rather than sharing GPU buffers with the renderer: far simpler, and fast enough.
- Velocity: semi-Lagrangian on a staggered grid; pressure by red-black SOR, warm-started.
- Temperature: implicit-diagonal upwind finite volume, so it cannot blow up and conserves heat at steady state.
- Fans are fixed-velocity faces, so each fan's flux is exactly Q.
- Heatsinks use anisotropic drag, so air cannot cross the fins.

## Review Focus

- All fans off or deleted: readings stay finite, no division by zero.
- A fan dragged into a solid or partly outside the case: no blow-up, solid wins.
- A hand-edited or corrupt layout JSON: rejected with a message, current layout kept.
- Browser without WebGPU: a readable message instead of a blank page.
- Stale or corrupt layout in browser storage: falls back to "My PC".

## Files

| File | Responsibility |
|---|---|
| `src/model/types.ts` | Shared types and vector helpers |
| `src/model/fans.ts` | Fan models, flow, totals |
| `src/model/machine.ts` | Case dimensions, mounts, solids, heatsinks, default layout |
| `src/model/layout.ts` | Resolve fan pose; serialise, parse |
| `src/model/geometry.ts` | Voxelise a layout into solver buffers |
| `src/model/thermal.ts` | Lumped component temperature |
| `src/model/metrics.ts` | Fluxes, heat out, region averages from fields |
| `src/sim/solver.wgsl`, `src/sim/solver.ts` | GPU solver |
| `src/view/scene.ts`, `flow.ts`, `sample.ts` | 3D scene and fan editing, flow visuals, field sampling |
| `src/ui/panel.ts` | Controls and readings |
| `src/main.ts`, `src/diagnostics.ts` | App and diagnostics entry points |

## Tasks

### Task 1: Scaffold, fans and layout

**Produces:** `fanFlow(model: FanModel, rpm: number): number` (m³/s); `flowTotals(layout): {intake, exhaust, balance}`; `resolveFan(fan, cooler): {pos, dir}`; `defaultLayout(): Layout`; `serialiseLayout(l): string`; `parseLayout(text): Layout` (throws on invalid).

- [x] Tests: half the rated RPM gives half the flow; default layout has 5 intakes, 3 exhausts, 2 CPU and 2 GPU fans; rotating the cooler 90° turns CPU fan direction from −x to +y; parse(serialise(l)) equals l; corrupt input throws.
- [x] Implement; `npm test` passes.

### Task 2: Voxelisation, thermal estimate, metrics

**Produces:** `voxelise(layout): Geometry` (`flags`, `fixed`, `drag` buffers, region cell lists); `componentTemperature(spec, power, airC, speed): number`; `computeMetrics(geometry, vel, temp, ambient): Metrics`.

- [x] Tests: an axis-aligned fan's fixed faces carry flux Q within 1%; tray and glass walls stay closed; a fan overlapping a solid leaves solid faces at zero; no fans gives no non-zero fixed faces; heatsink heat sums to the configured watts; temperature rises with power, falls with air speed, finite at zero speed; a uniform field through an empty box gives zero net flux.
- [x] Implement; `npm test` passes.

### Task 3: GPU solver and diagnostics page

**Produces:** `createSolver(device): Solver` with `setGeometry(g)`, `step(n)`, `read(): Promise<{vel, temp}>`, `reset()`, `destroy()`.

- [x] Diagnostics cases: no fans (stays still), full default layout (net flux ≤ 2% of fan flow, heat out within 10% of heat in), single reversed fan (flow reverses).
- [x] Implement; run `diagnostics.html` in Chrome and record the numbers.

### Task 4: Scene, editor, flow visuals, panel

- [x] Case, solids and fans drawn; select, translate, rotate, snap, flip, delete, add; cooler rotation and CPU fan slots.
- [x] Particles, slice colour map, arrows, streamlines, each toggleable.
- [x] Readings, scenario and power, baseline comparison, save, load, reset, local storage, settling indicator, no-WebGPU message.
- [x] `npm run build` clean; exercise in Chrome with no console errors.

### Task 5: README

- [x] Run instructions, controls, what the numbers do and do not mean.
