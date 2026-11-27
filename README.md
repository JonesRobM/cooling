# cooling

A browser app for exploring airflow and indicative temperatures in an air-cooled PC. The flow is solved on your GPU through WebGPU; there is no back end.

## Running

Needs Node 22 or later and a current Chrome or Edge.

    npm install
    npm run dev        # then open the printed address

`/diagnostics.html` checks the solver's mass and heat balance on your GPU.
`npm test` runs the unit tests; `npm run build` type-checks and builds.

## Using it

- Click a fan in the view or the list. Drag its gizmo to move it (**T**) or turn it (**R**).
- With snapping on, case fans dropped near a mount seat themselves, and turns go in 90° steps.
- Set speed, flip, re-aim or delete the selected fan. Add fans from the list below the fan names.
- Fans in the same **speed group** (a motherboard header) share a duty cycle. The default groups are by position because the real header wiring is unknown; set them to match yours.
- CPU fans move between the cooler's three positions; the cooler itself turns in 90° steps.
- **Undo** and **Redo**: buttons, or Ctrl+Z and Ctrl+Y.
- **Second GPU below the first** adds an identical card three expansion slots down (an assumption: measure your board). Both cards carry the GPU load. GPU fans have no back-pressure curve, so a card squeezed against another is modelled optimistically.
- View buttons give side, tray, front, rear and top views. The tray wall is see-through.
- Rotors turn at 1/100 or 1/1000 of real speed, scaled by the flow each fan is actually delivering.
- Particles fill the region around the case. Colour them by temperature, or by which intake they came in through. The panel also lists where the CPU's and GPU's air comes from.
- Wait for **Settled**, pin a baseline, change something, and wait again to see the differences.
- **Compare layouts** keeps named layouts and runs them all under the same conditions (about 15 s each at 5 mm, 45 s at 4 mm).
- Layouts persist in the browser and can be saved to or loaded from JSON. A layout stored before speed groups existed has none; **Reset to My PC** restores the defaults.

## What the numbers mean

Nothing is calibrated against the real machine. Treat results as qualitative.

- Free-air flow is `Q = Q_rated × RPM / RPM_rated`. With back-pressure on, case and CPU fans lose flow along an assumed curve `Δp = P_max (1 − (Q/Q_free)²)` according to the pressure across them. The F120Q's `P_max` comes from a test of a different retail version.
- GPU fans have no curve: there is no pressure data, and a guessed one decided the GPU temperature by itself (over 100 °C). Their 35 CFM is itself a guess.
- Vented walls resist air with pressure drop `K · ½ρv²`. The default K = 4 is a textbook-style estimate for a half-open perforated plate, not a measurement of this case. How much each fan delivers depends heavily on it, so check conclusions at more than one value.
- The air simulated outside the case extends 80 mm front and rear, 100 mm above, 25 mm below (to the desk) and 50 mm beyond the glass, so exhaust can be drawn back in. Nothing is modelled beyond the tray side.
- The grid is 5 mm with a constant eddy viscosity. Between 5 mm and 4 mm, CPU estimates moved by up to 1.4 K and kept their ranking; GPU estimates moved by up to 3.8 K and near-ties swapped. Treat CPU differences under about 2 K, and GPU differences under about 3 K, as no difference.
- CPU and GPU temperatures come from a lumped formula (`src/model/thermal.ts`) with assumed constants.

Case interior dimensions, component positions and the GPU fans' flow are estimates. Edit them in `src/model/machine.ts` and `src/model/fans.ts`.

## Layout of the code

    src/model/   layout, voxelisation, fan curves, tracing, metrics (unit tested)
    src/sim/     WebGPU solver and batch runner
    src/view/    3D scene, fan editing, flow visuals
    src/ui/      side panels and comparison table

Design and plans: `docs/superpowers/`.
