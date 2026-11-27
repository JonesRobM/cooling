// Incompressible flow with heat on a staggered grid.
// Index p holds the low face of cell p along each axis, and the centre scalar of cell p.

struct Params {
  dims: vec3u,      // array size: cells + 1 along each axis
  dt: f32,
  h: f32,
  nu: f32,          // eddy viscosity
  kappa: f32,       // eddy diffusivity of heat
  ambient: f32,
  buoyancy: f32,    // g * beta
  omega: f32,       // SOR relaxation
  ventLoss: f32,    // K of the vented walls
}

const SOLID = 1u;
const FIXED_U = 2u;
const MESH_U = 16u;
const MAX_SPEED = 10.0;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> fixedValues: array<vec4f>;
@group(0) @binding(3) var<storage, read> drag: array<vec4f>;
@group(0) @binding(4) var<storage, read> velSrc: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> velDst: array<vec4f>;
@group(0) @binding(6) var<storage, read> tempSrc: array<f32>;
@group(0) @binding(7) var<storage, read_write> tempDst: array<f32>;
@group(0) @binding(8) var<storage, read_write> phi: array<f32>;
@group(0) @binding(9) var<storage, read_write> divergenceSum: array<f32>;
// Drag factors are fixed once per step, so the pressure solve and projection agree.
@group(0) @binding(10) var<storage, read_write> weights: array<vec4f>;

fn idx(p: vec3i) -> u32 {
  return u32(p.x) + params.dims.x * (u32(p.y) + params.dims.y * u32(p.z));
}

fn cells() -> vec3i {
  return vec3i(params.dims) - 1;
}

fn isCell(p: vec3i) -> bool {
  return all(p >= vec3i(0)) && all(p < cells());
}

fn unit(a: u32) -> vec3i {
  var e = vec3i(0);
  e[a] = 1;
  return e;
}

fn isFixed(c: u32, a: u32) -> bool {
  return (flags[c] & (FIXED_U << a)) != 0u;
}

// Implicit drag factor for the face at p along axis a: porous cells, plus the mesh
// on faces crossing a vented wall. A mesh drops K rho v^2 / 2, which over one cell is a rate K |v| / 2h.
fn dragFactor(p: vec3i, a: u32) -> f32 {
  let high = idx(clamp(p, vec3i(0), cells() - 1));
  let low = idx(clamp(p - unit(a), vec3i(0), cells() - 1));
  var rate = 0.5 * (drag[low][a] + drag[high][a]);
  if ((flags[idx(p)] & (MESH_U << a)) != 0u) {
    rate += params.ventLoss * abs(velSrc[idx(p)][a]) / (2.0 * params.h);
  }
  return 1.0 / (1.0 + params.dt * rate);
}

// Trilinear sample of velocity component a at x, in cell units.
fn sampleComponent(a: u32, x: vec3f) -> f32 {
  var offset = vec3f(0.5);
  offset[a] = 0.0;
  var top = cells() - 1;
  top[a] += 1;
  let q = clamp(x - offset, vec3f(0.0), vec3f(top));
  let b = min(vec3i(q), top - 1);
  let f = q - vec3f(b);
  var sum = 0.0;
  for (var n = 0u; n < 8u; n++) {
    let o = vec3i(vec3u(n & 1u, (n >> 1u) & 1u, (n >> 2u) & 1u));
    let w = select(1.0 - f, f, o == vec3i(1));
    sum += w.x * w.y * w.z * velSrc[idx(b + o)][a];
  }
  return sum;
}

fn sampleVelocity(x: vec3f) -> vec3f {
  return vec3f(sampleComponent(0u, x), sampleComponent(1u, x), sampleComponent(2u, x));
}

@compute @workgroup_size(8, 8, 4)
fn advect(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= params.dims)) { return; }
  let p = vec3i(id);
  let c = idx(p);
  let scale = params.dt / params.h;
  var out = vec4f(0.0);
  var factors = vec4f(1.0);
  for (var a = 0u; a < 3u; a++) {
    if (isFixed(c, a)) {
      out[a] = fixedValues[c][a];
      continue;
    }
    var x = vec3f(p) + 0.5;
    x[a] = f32(p[a]);
    let mid = x - 0.5 * scale * sampleVelocity(x);
    let back = x - scale * sampleVelocity(mid);
    var value = sampleComponent(a, back);

    var top = cells() - 1;
    top[a] += 1;
    var laplacian = -6.0 * velSrc[c][a];
    for (var d = 0u; d < 3u; d++) {
      laplacian += velSrc[idx(clamp(p + unit(d), vec3i(0), top))][a];
      laplacian += velSrc[idx(clamp(p - unit(d), vec3i(0), top))][a];
    }
    value += params.nu * params.dt / (params.h * params.h) * laplacian;

    if (a == 1u) {
      let above = tempSrc[idx(clamp(p, vec3i(0), cells() - 1))];
      let below = tempSrc[idx(clamp(p - unit(1u), vec3i(0), cells() - 1))];
      value += params.dt * params.buoyancy * (0.5 * (above + below) - params.ambient);
    }
    factors[a] = dragFactor(p, a);
    out[a] = clamp(value * factors[a], -MAX_SPEED, MAX_SPEED);
  }
  velDst[c] = out;
  weights[c] = factors;
}

@compute @workgroup_size(8, 8, 4)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
  let p = vec3i(id);
  if (!isCell(p)) { return; }
  var sum = 0.0;
  for (var a = 0u; a < 3u; a++) {
    sum += velSrc[idx(p + unit(a))][a] - velSrc[idx(p)][a];
  }
  divergenceSum[idx(p)] = sum;
}

override COLOUR: u32 = 0u;

// Red-black SOR for phi = p dt / (rho h). Openings are phi = 0.
@compute @workgroup_size(8, 8, 4)
fn pressure(@builtin(global_invocation_id) id: vec3u) {
  let p = vec3i(id);
  if (!isCell(p) || ((id.x + id.y + id.z) & 1u) != COLOUR) { return; }
  let c = idx(p);
  var sum = 0.0;
  var diag = 0.0;
  for (var a = 0u; a < 3u; a++) {
    for (var side = 0; side < 2; side++) {
      let face = p + unit(a) * side;
      if (isFixed(idx(face), a)) { continue; }
      let nb = p + unit(a) * (2 * side - 1);
      let w = weights[idx(face)][a];
      diag += w;
      if (isCell(nb)) { sum += w * phi[idx(nb)]; }
    }
  }
  if ((flags[c] & SOLID) != 0u || diag == 0.0) {
    phi[c] = 0.0;
    return;
  }
  phi[c] += params.omega * ((sum - divergenceSum[c]) / diag - phi[c]);
}

@compute @workgroup_size(8, 8, 4)
fn project(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= params.dims)) { return; }
  let p = vec3i(id);
  let c = idx(p);
  var v = velDst[c];
  for (var a = 0u; a < 3u; a++) {
    if (isFixed(c, a)) { continue; }
    let low = p - unit(a);
    var here = 0.0;
    var there = 0.0;
    if (isCell(p)) { here = phi[c]; }
    if (isCell(low)) { there = phi[idx(low)]; }
    v[a] -= weights[c][a] * (here - there);
  }
  velDst[c] = v;
}

// Upwind finite volume with an implicit diagonal: unconditionally stable,
// and conservative once the field is steady.
@compute @workgroup_size(8, 8, 4)
fn temperature(@builtin(global_invocation_id) id: vec3u) {
  let p = vec3i(id);
  if (!isCell(p)) { return; }
  let c = idx(p);
  let t = tempSrc[c];
  if ((flags[c] & SOLID) != 0u) {
    tempDst[c] = params.ambient;
    return;
  }
  let courant = params.dt / params.h;
  let diffusion = params.kappa * params.dt / (params.h * params.h);
  var numerator = t + params.dt * fixedValues[c].w;
  var denominator = 1.0;
  for (var a = 0u; a < 3u; a++) {
    for (var side = 0; side < 2; side++) {
      let inward = velSrc[idx(p + unit(a) * side)][a] * f32(1 - 2 * side);
      let nb = p + unit(a) * (2 * side - 1);
      let face = idx(p + unit(a) * side);
      // A closed face (case wall, desk) conducts nothing.
      let closed = isFixed(face, a) && fixedValues[face][a] == 0.0;
      var neighbour = params.ambient;
      if (isCell(nb)) {
        neighbour = tempSrc[idx(nb)];
        if (!closed && (flags[idx(nb)] & SOLID) == 0u) {
          numerator += diffusion * (neighbour - t);
        }
      }
      if (inward > 0.0) {
        numerator += courant * inward * neighbour;
        denominator += courant * inward;
      }
    }
  }
  tempDst[c] = clamp(numerator / denominator, params.ambient - 5.0, params.ambient + 150.0);
}
