/* Thin fetch wrapper. Every call returns parsed JSON or throws an Error whose
   message is the server's human-readable reason. */
(function () {
  'use strict';

  let token = localStorage.getItem('samiha_token') || null;

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && !path.includes('/auth/')) {
      API.setToken(null);
      window.dispatchEvent(new CustomEvent('samiha:unauthorised'));
      throw new Error('Your session has expired. Please sign in again.');
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    /*
     * Nothing may be recorded until the person has said which branch they
     * are in. The server refuses the write; here the question is simply
     * asked, so the answer to "why did that not save" is a dialog rather
     * than a shrug.
     */
    if (res.status === 409 && data && data.needsBranch) {
      if (window.APP && APP.openBranchPicker) {
        APP.branches = data.branches || APP.branches;
        APP.openBranchPicker({ mustChoose: true });
      }
      const err = new Error(data.error || 'Choose a branch first.');
      err.status = 409;
      err.needsBranch = true;
      throw err;
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.details = data && data.details;
      err.payload = data;
      throw err;
    }
    return data;
  }

  const API = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b || {}),
    patch: (p, b) => request('PATCH', p, b || {}),
    put: (p, b) => request('PUT', p, b || {}),
    // A delete may carry a body: the destructive ones ask for a typed
    // confirmation and a reason, and those belong in the request rather
    // than in the query string where they end up in a server log.
    del: (p, b) => request('DELETE', p, b),
    getToken: () => token,
    setToken(value) {
      token = value;
      if (value) localStorage.setItem('samiha_token', value);
      else localStorage.removeItem('samiha_token');
    },
    qs(params) {
      const parts = Object.entries(params || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      return parts.length ? '?' + parts.join('&') : '';
    },
  };

  window.API = API;
})();
