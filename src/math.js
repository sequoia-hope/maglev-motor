// Small linear-algebra kit. Vectors are plain [x,y,z] arrays; matrices are
// row-major Float64Array. Everything here is allocation-light because the
// wrench matrix gets rebuilt hundreds of times per second.

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

// --- quaternions (w, x, y, z) -----------------------------------------------

export const quat = {
  identity: () => [1, 0, 0, 0],
  mul: (a, b) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ],
  normalize: (q) => {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },
  // Integrate by body-frame... no: omega is in world frame here.
  integrate: (q, omega, dt) => {
    const h = dt * 0.5;
    const dq = [
      -h * (omega[0] * q[1] + omega[1] * q[2] + omega[2] * q[3]),
      h * (omega[0] * q[0] + omega[1] * q[3] - omega[2] * q[2]),
      h * (-omega[0] * q[3] + omega[1] * q[0] + omega[2] * q[1]),
      h * (omega[0] * q[2] - omega[1] * q[1] + omega[2] * q[0]),
    ];
    return quat.normalize([q[0] + dq[0], q[1] + dq[1], q[2] + dq[2], q[3] + dq[3]]);
  },
  // 3x3 rotation matrix, row-major.
  toMat3: (q) => {
    const [w, x, y, z] = q;
    return new Float64Array([
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ]);
  },
  fromEuler: (rx, ry, rz) => {
    const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
    const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
    const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
    return quat.normalize([
      cx * cy * cz + sx * sy * sz,
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
    ]);
  },
  // Small-angle error vector taking q -> qDes, expressed in world frame.
  errorVec: (q, qDes) => {
    const qc = [q[0], -q[1], -q[2], -q[3]];
    let e = quat.mul(qDes, qc);
    if (e[0] < 0) e = e.map((c) => -c);
    const s = Math.hypot(e[1], e[2], e[3]);
    if (s < 1e-9) return [0, 0, 0];
    const ang = 2 * Math.atan2(s, e[0]);
    return [(e[1] / s) * ang, (e[2] / s) * ang, (e[3] / s) * ang];
  },
};

export function mat3MulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mat3TMulVec(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

// --- dense solves on tiny symmetric systems ---------------------------------

/** Solve A x = b for symmetric positive-definite A (n<=8) via Cholesky.
 *  A is row-major n*n, modified in place. Returns null if not PD. */
export function solveSPD(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 1e-300) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** Eigenvalues of a small symmetric matrix by cyclic Jacobi. Returns them
 *  sorted descending. Used to get singular values of the wrench matrix W as
 *  sqrt(eig(W Wᵀ)) — W is 6xN with N large, so the 6x6 Gram matrix is the
 *  cheap route. */
export function symEigenvalues(Ain, n) {
  const A = Float64Array.from(Ain);
  for (let sweep = 0; sweep < 40; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
      }
    }
  }
  const ev = [];
  for (let i = 0; i < n; i++) ev.push(A[i * n + i]);
  return ev.sort((a, b) => b - a);
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-12), 0, 1);
  return t * t * (3 - 2 * t);
}
