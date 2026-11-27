# Round 2: trust, usability and physics views

Agreed with the owner after the first build. Executed inline; no commits.

1. **Fan back-pressure.** Quadratic curve `Δp = P_max (1 − (Q/Q_max)²)`, `Q_max ∝ N`, `P_max ∝ N²`. The solver still fixes each fan's face velocities; a few times a second the pressure rise across each disc (plus mesh loss for wall fans) is read back and the velocity scaled towards the operating point. Switchable.
2. **Air outside the case.** Domain padded 80 mm front and rear, 100 mm above, 50 mm beyond the glass, with the desk 25 mm below. Case walls become thin face barriers inside the domain. New reading: temperature of air entering the case (shows re-ingestion). Particles move through the whole region.
3. **Grid check.** Grid spacing is a parameter; the batch comparison can run at 5 mm or 4 mm.
4. **Batch comparison.** Keep named layouts, run all under the current conditions, show a table.
5. **See-through tray and view presets.**
6. **Undo/redo; geometry built in a web worker** so dragging does not stutter.
7. **Speed groups.** Fans in a group share a duty cycle. Header mapping is unknown, so defaults are by position and editable.
8. **Which air feeds what.** Colour particles by the intake they came from; trace backwards from the CPU and GPU fins to show the mix of sources.
9. **Spinning fans** at 1/100 or 1/1000 of real speed, proportional to delivered flow (RPM × delivered ÷ free-air).

Fan static pressures: F120Q 0.77 mmH₂O (Cybenetics, case version), P12 Pro LN 3.5 (Arctic), TL-C12C 1.53 (Thermalright listing), GPU 2.0 (guess).

Verification: Vitest for the model; diagnostics page for mass and heat balance, back-pressure and exterior; the app in Chrome.
