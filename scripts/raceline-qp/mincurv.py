# Usage: PYTHONPATH=shim python mincurv.py <circuit>-lap.json <out.json> 2.55 8.0 14 0.5
# (lap, output, knot margin m, knot spacing m, max passes, step after pass 1). Needs numpy, scipy,
# osqp 1.1.3 and trajectory-planning-helpers 0.79; shim/quadprog.py stands in for quadprog via OSQP.
# Then map.ts maps the dense line to <circuit>-line.json offsets and check.py checks it in metres.
#
# TUM minimum-curvature QP (trajectory_planning_helpers opt_min_curv, LGPL-3.0) with an explicit
# acceptance test on re-linearisation (EM #21029/#21032): each pass solves the QP about the current
# path, then tries steps 1, 1/2, 1/4, 1/8 of the QP move (pass 1 starts at 1, later passes at `damp`)
# and accepts the first whose REALISED objective J = integral kappa^2 ds (closed spline through the
# moved knots, 16-point Gauss weighting by spline speed |r'(t)|) is lower than the current path's.
# Reports OSQP status/residuals, the step taken, J, and predicted (for the applied step) vs realised
# knot curvature.
import sys, json, time, numpy as np, trajectory_planning_helpers as tph, quadprog
import opt_min_curv as _om  # local modified copy (records the predicted curvature)
lap = json.load(open(sys.argv[1])); out = sys.argv[2]; margin = float(sys.argv[3]); step = float(sys.argv[4]); iters = int(sys.argv[5]); damp = float(sys.argv[6])
c = np.array(lap['centerline']['points'], float).reshape(-1, 3); N = len(c)
hw = np.array(lap['centerline']['halfWidth'], float).reshape(-1, 2)
xy = np.stack([c[:, 0], -c[:, 2]], 1); D = np.array(lap['centerline']['distance'])
keep = [0]
for i in range(1, N):
    if D[i] - D[keep[-1]] >= step - 1e-6: keep.append(i)
keep = np.array(keep)
gq, gw = np.polynomial.legendre.leggauss(16); gq = (gq + 1) / 2; gw = gw / 2
def spline(pts):
    cl = np.vstack([pts, pts[:1]]); el = np.linalg.norm(np.diff(cl, axis=0), axis=1)
    cx, cy, A, nv = tph.calc_splines.calc_splines(path=cl, el_lengths=el); return cx, cy, A, nv
def J(cx, cy):
    t = gq[None, :]
    dx = cx[:, 1:2] + 2 * cx[:, 2:3] * t + 3 * cx[:, 3:4] * t ** 2; dy = cy[:, 1:2] + 2 * cy[:, 2:3] * t + 3 * cy[:, 3:4] * t ** 2
    ddx = 2 * cx[:, 2:3] + 6 * cx[:, 3:4] * t; ddy = 2 * cy[:, 2:3] + 6 * cy[:, 3:4] * t
    sp = np.hypot(dx, dy); k = (dx * ddy - dy * ddx) / sp ** 3; return float(np.sum(k ** 2 * sp * gw[None, :]))
def knot_kappa(cx, cy, n):
    return tph.calc_head_curv_an.calc_head_curv_an(coeffs_x=cx, coeffs_y=cy, ind_spls=np.arange(n), t_spls=np.zeros(n))[1]
ref = np.column_stack([xy[keep], hw[keep, 1] - margin, hw[keep, 0] - margin])  # x, y, w_right, w_left
cx, cy, A, nv = spline(ref[:, :2]); Jc = J(cx, cy)
print(f'centreline (knots) J {Jc:.4f} 1/m', flush=True)
for it in range(iters):
    t1 = time.time()
    alpha, err = _om.opt_min_curv(reftrack=ref, normvectors=nv, A=A, kappa_bound=10.0, w_veh=0.0, print_debug=False, closed=True)
    st = quadprog.LOG[-1]; pred_full = _om.LAST['pred']; k0 = knot_kappa(cx, cy, len(ref))
    accepted = None
    for f in [(1.0 if it == 0 else damp) / 2 ** j for j in range(4)]:
        new = ref[:, :2] + nv * (f * alpha)[:, None]
        ncx, ncy, nA, nnv = spline(new); Jn = J(ncx, ncy)
        if Jn < Jc: accepted = f; break
    if accepted is None:
        print(f'pass {it + 1}: no step lowers J ({Jc:.6f}); stopping', flush=True); break
    real = knot_kappa(ncx, ncy, len(new)); pred = k0 + accepted * (pred_full - k0)   # linear model at the applied step
    d = np.abs(pred - real); k = int(np.argmax(d))
    print(f'pass {it + 1}: OSQP {st["status"]}, {st["iter"]} iter, max violation {st["max_violation"]:.1e}, primal {st["pri_res"]:.1e}, dual {st["dua_res"]:.1e}; step {accepted:g}; '
          f'move max {np.max(np.abs(accepted * alpha)):.3f} m at lap {D[keep[np.argmax(np.abs(alpha))]]:.0f} m; J {Jc:.4f} -> {Jn:.4f}; '
          f'predicted (applied step) vs realised knot curvature: max {d[k]:.4f} 1/m at lap {D[keep[k]]:.0f} m, mean {d.mean():.5f}; {time.time() - t1:.0f}s', flush=True)
    sgn = 1.0  # normvectors point right of travel (checked): alpha > 0 moves right
    ref = np.column_stack([new, ref[:, 2] - sgn * accepted * alpha, ref[:, 3] + sgn * accepted * alpha])
    cx, cy, A, nv = ncx, ncy, nA, nnv; Jc = Jn
    if np.max(np.abs(accepted * alpha)) < 0.01: print('converged: move < 0.01 m', flush=True); break
dense, _, _, _ = tph.interp_splines.interp_splines(coeffs_x=cx, coeffs_y=cy, stepsize_approx=0.5, incl_last_point=False)
json.dump({'dense_x': dense[:, 0].tolist(), 'dense_z': (-dense[:, 1]).tolist(), 'x': ref[:, 0].tolist(), 'z': (-ref[:, 1]).tolist(), 'keep': keep.tolist(), 'J': Jc}, open(out, 'w'))
