# Shim for the `quadprog` API (solve_qp) backed by OSQP, because the quadprog binary fails to load on
# this macOS/Python 3.9 build. quadprog: minimise 1/2 x^T G x - a^T x subject to C^T x >= b, with the
# first meq constraints as equalities. Returns a tuple whose first element is x (as quadprog does).
import numpy as np, osqp, scipy.sparse as sp
LOG = []  # per-solve OSQP status/residuals, read by the caller

def solve_qp(G, a, C=None, b=None, meq=0):
    n = G.shape[0]
    P = sp.csc_matrix((G + G.T) / 2)
    q = -np.asarray(a, dtype=float)
    if C is None:
        A = sp.csc_matrix((0, n)); l = np.zeros(0); u = np.zeros(0)
    else:
        A = sp.csc_matrix(np.asarray(C).T)
        b = np.asarray(b, dtype=float)
        l = b.copy(); u = np.full_like(b, np.inf)
        if meq: u[:meq] = b[:meq]
    m = osqp.OSQP()
    m.setup(P=P, q=q, A=A, l=l, u=u, verbose=False, eps_abs=1e-6, eps_rel=1e-6, max_iter=200000, polish=True)
    r = m.solve()
    if r.info.status_val not in (1, 2):
        raise ValueError('OSQP failed: ' + r.info.status)
    x = r.x
    Ax = A @ x  # independent check of the returned point against the original constraints
    viol = float(np.max(np.concatenate([[0.0], l - Ax, Ax - u]))) if A.shape[0] else 0.0
    LOG.append({'status': r.info.status, 'polish': r.info.status_polish, 'iter': r.info.iter,
                'pri_res': r.info.prim_res, 'dua_res': r.info.dual_res, 'max_violation': viol, 'n': n, 'm': A.shape[0]})
    return (x, 0.5 * x @ G @ x - np.asarray(a) @ x, None, None, None, None)
