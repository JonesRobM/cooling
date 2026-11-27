# PC airflow simulator: design

Date: 27 November 2026
Status: approved

Statements marked **(call)** were chosen by the designer, not requested.

## Intent

The owner has a built, air-cooled PC and wants to know:

1. Is the ventilation arranged well?
2. What does the air actually do? (Curiosity, as a physicist.)

The central feature is an editor: place, orient and adjust fans and see the flow and temperatures respond.

## Goals

- Model the owner's PC as the default layout, labelled "My PC".
- Add, remove, move, rotate and flip fans, including case, CPU cooler and GPU fans.
- Set each fan's speed, with the volume of air it pushes scaling with that speed.
- Simulate airflow and heat continuously while editing.
- Show velocity vectors, moving air paths and temperatures.
- Compare one layout against another.

## Non-goals

- Accurate absolute temperatures. There are no measurements to calibrate against.
- Live sensor readings, or any connection to the PC being modelled.
- Resolved fan blades, swirl, heatsink fins, or noise.
- Air further than a few centimetres from the case, or beyond the tray side.
- Radiators, water cooling or fan control curves.
- The chamber behind the motherboard tray (PSU and drives).
- Importing CAD models or arbitrary cases.

## Anti-goals

- A convincing animation whose flow does not follow from the layout.
- Temperatures presented as predictions of the real machine.
- An editor so fiddly that trying an alternative is a chore.

## Approaches

| Approach | For | Against |
|---|---|---|
| **A. Browser app, WebGPU solver (chosen)** | Good 3D editor; solver and renderer share GPU memory; no CUDA setup | WGSL is verbose and harder to debug |
| B. Python with NVIDIA Warp | Solver easier to read and test | Weak 3D editing, or two halves with fields streamed between them |
| C. OpenFOAM | Far better physics | Re-mesh and re-solve after every change; not dynamic |

The owner chose A because the editor matters most.

## Platform

- TypeScript (`strict`), Vite, three.js, compute shaders in WGSL. **(call)**
- Runs locally in a WebGPU-capable desktop browser. Development target: Windows laptop with an RTX 4050 (6 GB).
- No back end.

## The machine

Axes: x from rear to front, y from bottom to top, z from motherboard tray to glass panel.

| Item | Model data | Source |
|---|---|---|
| Case | NZXT H7 Flow (2024). Interior of the main chamber about 440 × 460 × 190 mm | Interior is an estimate from external size; keep it in one config file |
| Front intake × 3 | NZXT F120Q, 120 mm, 1350 RPM, 60.2 CFM | Retail specification |
| Bottom intake × 2 | Arctic P12 Pro LN, 450–2000 RPM, 49 CFM | Manufacturer |
| Top exhaust × 2 (rear end), rear exhaust × 1 | Arctic P12 Pro LN | Manufacturer |
| CPU cooler | Peerless Assassin 120 SE, twin tower, about 155 mm tall, 2 fans at 1550 RPM, 66 CFM, blowing front to rear | Retail specification; direction assumed; revision unconfirmed |
| GPU | Zotac RTX 5060 Ti Twin Edge OC, 220.5 × 120.25 × 41.6 mm, 2 × 90 mm fans facing down, drawing air up into the heatsink | Zotac |
| GPU fan flow | 35 CFM at 3000 RPM each | Guess; no published figure |
| Other solids | Motherboard (the tray wall), RAM sticks, GPU body | Positions estimated from ATX layout |

Front, top, bottom and rear openings are treated as mesh or vents.

## Fans

Each fan has: position, direction, diameter, RPM, rated RPM and rated flow.

Volume flow follows the first fan affinity law:

    Q = Q_rated × RPM / RPM_rated

The interface shows RPM and the resulting flow (CFM and m³/h) together, plus total intake, total exhaust and the pressure balance (positive or negative).

In the solver a fan is a thick disc that drives air along its axis at Q / swept area. **(call)** Rated flow is the free-air figure. (Second round: case and CPU fans lose flow against back-pressure along `Δp = P_max (1 − x²)`; GPU fans do not, for want of any data.)

Fans in a named group share a duty cycle, matching motherboard headers.

## Editing

- 3D view with orbit, pan and zoom.
- Click a fan to select it. Drag to move, rotate with a gizmo, flip with a button, delete, or add another from a list of models.
- Case fans snap to the case's mount positions, with free placement available. Angles snap to 90° unless snapping is off. **(call)**
- CPU cooler fans move along the cooler's axis (push, middle, pull); the whole cooler can be rotated in 90° steps.
- GPU fans can be repositioned, flipped, switched off or have their speed set.
- Layouts save to and load from JSON; the current one persists in browser storage. "Reset to My PC" restores the default. **(call)**

## Physics

- Incompressible Navier–Stokes on a uniform grid of 5 mm cells covering the case and a margin of room air (roughly 670,000 cells), stable-fluids scheme (Stam, 1999) with a pressure projection. **(call)**
- Temperature carried by the flow, with diffusion and Boussinesq buoyancy.
- A simple constant eddy viscosity stands in for turbulence. **(call)**
- Walls are solid. The edges of the simulated region are fixed-pressure boundaries, except the desk and the tray side, which are closed.
- Openings carry a mesh resistance, pressure drop `K · ½ρv²`, default K = 4, editable. (Added after the first build showed that bare openings understate the effect of case fans.)
- Heatsinks are porous blocks that resist flow and release heat into the air passing through.
- Component temperature is a lumped estimate: heatsink temperature = local air temperature + power / (h·A), with h rising with air speed through the fins. Constants come from typical published cooler behaviour. **(call)**
- Scenarios: idle, CPU flat out, GPU busy, both. Heat in watts is editable. Defaults: CPU 40 W idle and 200 W loaded; GPU 15 W idle and 180 W loaded. Ambient defaults to 21 °C. **(call)**

## Visualisation

Each can be toggled:

- Particles carried by the flow, coloured by air temperature.
- Vector arrows on a movable slice plane.
- Temperature or speed colour map on that plane.
- Streamlines seeded at each intake. **(call)**

Added in the second round: particles throughout the surrounding region, optionally coloured by the intake they came through; the sources of CPU and GPU air; rotors spinning at 1/100 or 1/1000 speed; view presets.

Always visible: estimated CPU and GPU temperatures, intake and exhaust air temperatures, flow totals, and a "settling / settled" indicator.

## Comparing layouts

"Pin as baseline" stores the settled readings. Later readings show the difference from the baseline in CPU, GPU, exhaust temperature and pressure balance. **(call)**

An optional second, identical graphics card can be fitted below the first. The simulated region around the case is not outlined; flow visuals fade out towards its edge.

Saved layouts can also be run as a batch under identical conditions and tabulated. Edits can be undone and redone.

## Success criteria

- Flow visibly responds within 1 s of an edit.
- Readings settle within about 30 s on the development laptop.
- At least 30 frames per second while simulating.
- Net volume flux through all openings is within 2% of total fan flow once settled.
- Heat leaving through the openings is within 10% of the heat put in once settled.
- Reversing a fan reverses the nearby flow; raising a fan's speed raises its measured flux in proportion.
- No blow-up for any layout the editor allows.

## Testing

- Unit tests (Vitest) for fan flow, geometry voxelisation, layout save and load, and the lumped temperature model.
- A built-in diagnostics page runs the solver in the browser on simple cases (empty duct, single fan, heated box) and reports mass and energy balance, because the WGSL cannot be tested under Node.

## Left to the builder

- Pressure solver (Jacobi, red-black Gauss–Seidel or multigrid), time step and advection details.
- UI layout and controls library.
- Colour maps and particle counts.
- Module structure.
