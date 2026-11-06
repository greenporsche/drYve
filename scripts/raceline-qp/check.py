# Realised-geometry check of a QP line in metres. Usage: python check.py <circuit>-lap.json <qp.json> <margin m> <out.json>
# Realised-geometry check of the QP line in metres, against our 2 m centreline and per-side road widths.
import sys, json, numpy as np
lap = json.load(open(sys.argv[1])); q = json.load(open(sys.argv[2])); margin = float(sys.argv[3])
c = np.array(lap['centerline']['points'], float).reshape(-1, 3); N = len(c)
hw = np.array(lap['centerline']['halfWidth'], float).reshape(-1, 2)   # [left, right]
D = np.array(lap['centerline']['distance'], float); Ltot = lap['centerline'].get('length', D[-1] + np.linalg.norm(c[0] - c[-1]))
P = np.stack([c[:, 0], c[:, 2]], 1)                                   # x, z (our frame)
T = np.roll(P, -1, 0) - np.roll(P, 1, 0); T /= np.linalg.norm(T, axis=1)[:, None]
# left of travel in (x, z) with y up: left = (tz, -tx)
Lft = np.stack([T[:, 1], -T[:, 0]], 1)
Q = np.stack([q['dense_x'], q['dense_z']], 1); M = len(Q)
# nearest centreline sample per dense point (windowed, monotone)
from scipy.spatial import cKDTree
tree = cKDTree(P); _, idx = tree.query(Q, k=6)
best = np.empty(M, int); nOff = np.empty(M); along = np.empty(M)
for j in range(M):
    cand = idx[j]; d = []
    for i in cand:
        v = Q[j] - P[i]; d.append(abs(v @ T[i]))
    i = cand[int(np.argmin(d))]; v = Q[j] - P[i]
    best[j] = i; nOff[j] = v @ Lft[i]; along[j] = D[i] + v @ T[i]
limL = hw[best, 0]; limR = hw[best, 1]
clrL = limL - nOff; clrR = limR + nOff                                  # distance to the road edge on each side
print(f'dense points {M}, spacing ~{np.mean(np.linalg.norm(np.diff(Q, axis=0), axis=1)):.2f} m')
print(f'road-edge clearance: min left {clrL.min():.2f} m at lap {along[np.argmin(clrL)]:.0f} m, min right {clrR.min():.2f} m at lap {along[np.argmin(clrR)]:.0f} m (planned margin {margin} m)')
viol = np.minimum(clrL, clrR) < margin - 0.05
print(f'points inside the {margin} m margin by >5 cm: {viol.sum()}; worst {margin - np.minimum(clrL, clrR).min():.3f} m; on/over the road edge: {(np.minimum(clrL, clrR) < 0).sum()}')
# seam: closure gap and heading/curvature continuity across the wrap
gap = np.linalg.norm(Q[0] - Q[-1]); h = np.diff(Q, axis=0); hd = np.arctan2(h[:, 1], h[:, 0])
dh = np.angle(np.exp(1j * (hd[0] - np.arctan2(*(Q[0] - Q[-1])[::-1]))))
print(f'seam: closing gap {gap:.2f} m, heading jump {np.degrees(dh):.2f} deg')
# local true 3-point curvature on the dense curve (circumradius), resampled at 2 m to match the planner
s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.vstack([Q, Q[:1]]), axis=0), axis=1))])
Lp = s[-1]; ss = np.arange(0, Lp, 2.0); X = np.interp(ss, s, np.append(Q[:, 0], Q[0, 0])); Z = np.interp(ss, s, np.append(Q[:, 1], Q[0, 1]))
R = np.stack([X, Z], 1); a = np.roll(R, 1, 0); b = R; cc = np.roll(R, -1, 0)
cr = (b[:, 0] - a[:, 0]) * (cc[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (cc[:, 0] - a[:, 0])
k3 = 2 * cr / (np.linalg.norm(b - a, axis=1) * np.linalg.norm(cc - b, axis=1) * np.linalg.norm(cc - a, axis=1))
print(f'path length {Lp:.1f} m (centreline {Ltot:.1f} m); max |kappa| {np.abs(k3).max():.4f} 1/m (R {1/np.abs(k3).max():.1f} m) at path {ss[np.argmax(np.abs(k3))]:.0f} m')
# zigzag check: sign changes of curvature where |kappa| > 0.005 within 30 m windows
sg = np.sign(np.where(np.abs(k3) > 0.005, k3, 0)); flips = np.sum((sg[:-1] * sg[1:]) < 0)
print(f'curvature sign flips (|kappa|>0.005, 2 m spacing): {flips}; total |dkappa/ds| {np.sum(np.abs(np.diff(k3))) :.3f}')
json.dump({'along': along.tolist(), 'n': nOff.tolist(), 'clrL': clrL.tolist(), 'clrR': clrR.tolist()}, open(sys.argv[4], 'w'))
