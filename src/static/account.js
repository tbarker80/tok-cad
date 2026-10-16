(() => {
  'use strict';

  const API_ROOT = '/api/v1';
  const ACCESS_LABELS = Object.freeze({
    'read-only': 'Read only',
    edit: 'Edit after approval',
  });

  let csrfToken = '';
  let revealedSecret = '';
  let deleteResetTimer = null;
  let unlinkResetTimer = null;

  const byId = (id) => document.getElementById(id);

  function setStatus(message = '', state = '') {
    const status = byId('pm-account-status');
    if (!status) return;
    status.textContent = message;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  function errorMessage(error) {
    if (error instanceof Error && error.message.trim()) return error.message;
    return 'The request could not be completed. Try again.';
  }

  function exactOriginUrl(path) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) {
      throw new Error('PartMode blocked a request to a different origin.');
    }
    return url.href;
  }

  async function apiRequest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers({ Accept: 'application/json' });
    let body;

    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
      headers.set('X-PartMode-CSRF', csrfToken);
    }

    let response;
    try {
      response = await fetch(exactOriginUrl(`${API_ROOT}${path}`), {
        method,
        headers,
        body,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'same-origin',
      });
    } catch (error) {
      throw new Error(
        error instanceof TypeError
          ? 'PartMode could not reach the account service. Check your connection and try again.'
          : errorMessage(error),
      );
    }

    const contentType = response.headers.get('content-type') || '';
    let payload = {};
    if (contentType.includes('application/json')) {
      try {
        payload = await response.json();
      } catch {
        throw new Error('The account service returned an unreadable response.');
      }
    }

    if (!response.ok) {
      const message =
        (payload && typeof payload.message === 'string' && payload.message) ||
        (payload && typeof payload.error === 'string' && payload.error) ||
        `The account service returned HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.code = payload && typeof payload.error === 'string' ? payload.error : '';   // TOKCAD
      throw error;
    }
    return payload;
  }

  function setBusy(container, busy) {
    if (!(container instanceof Element)) return;
    container.setAttribute('aria-busy', String(busy));
    for (const control of container.querySelectorAll('button, input, select')) {
      control.disabled = busy;
    }
  }

  function textField(form, name) {
    const field = form?.elements?.namedItem(name);
    return field instanceof HTMLInputElement || field instanceof HTMLSelectElement
      ? field
      : null;
  }

  function normalizeKeys(keys) {
    return Array.isArray(keys)
      ? keys.filter((key) => key && typeof key === 'object' && typeof key.id === 'string')
      : [];
  }

  function formatDate(value) {
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) return '';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function keyPrefix(key) {
    for (const value of [key.prefix, key.displayPrefix, key.masked]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (typeof key.id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(key.id)) {
      return `pmak_v1_${key.id}_...`;
    }
    return '';
  }

  function renderKeyList(keys) {
    const list = byId('pm-key-list');
    if (!list) return;
    list.replaceChildren();

    const activeKeys = normalizeKeys(keys);
    if (activeKeys.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'pm-key-empty';
      empty.textContent = 'No agent keys yet. Create one for the agent you want to connect.';
      list.append(empty);
      return;
    }

    for (const key of activeKeys) {
      const item = document.createElement('li');
      item.className = 'pm-key-row';

      const details = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'pm-key-title';

      const name = document.createElement('h3');
      name.textContent = typeof key.label === 'string' && key.label.trim()
        ? key.label.trim()
        : 'Agent key';
      const access = document.createElement('span');
      access.className = 'pm-key-access';
      access.textContent = ACCESS_LABELS[key.access] || 'Scoped access';
      title.append(name, access);
      if (key.headless === true) {
        const headless = document.createElement('span');
        headless.className = 'pm-key-access';
        headless.textContent = 'Headless sessions allowed';
        title.append(headless);
      }

      const metadata = document.createElement('p');
      metadata.className = 'pm-key-meta';
      const segments = [];
      const prefix = keyPrefix(key);
      if (prefix) segments.push(prefix);
      const createdAt = formatDate(key.createdAt);
      if (createdAt) segments.push(`Created ${createdAt}`);
      const lastUsedAt = formatDate(key.lastUsedAt);
      if (lastUsedAt) segments.push(`Last used ${lastUsedAt}`);
      const expiresAt = formatDate(key.expiresAt);
      if (expiresAt) segments.push(`Expires ${expiresAt}`);
      const revokedAt = formatDate(key.revokedAt);
      if (revokedAt) segments.push(`Revoked ${revokedAt}`);
      metadata.textContent = segments.join(' | ') || 'Secret hidden';
      if (prefix) metadata.classList.add('pm-key-prefix');

      details.append(title, metadata);

      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'pm-key-revoke';
      revoke.dataset.keyId = key.id;
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', `Revoke agent key ${name.textContent}`);

      if (revokedAt) {
        revoke.disabled = true;
        revoke.textContent = 'Revoked';
        revoke.removeAttribute('data-key-id');
      }

      item.append(details, revoke);
      list.append(item);
    }
  }

  function clearSecret() {
    revealedSecret = '';
    const secret = byId('pm-key-secret');
    const value = byId('pm-key-secret-value');
    if (value) value.textContent = '';
    if (secret) secret.hidden = true;
  }

  function showSecret(value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('The key was created, but its one-time secret was missing. Revoke it and create another key.');
    }
    revealedSecret = value.trim();
    const secret = byId('pm-key-secret');
    const output = byId('pm-key-secret-value');
    if (!secret || !output) return;
    output.textContent = revealedSecret;
    secret.hidden = false;
    secret.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    byId('pm-key-copy')?.focus({ preventScroll: true });
  }

  function createdSecret(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.secret === 'string') return payload.secret;
    if (typeof payload.rawKey === 'string') return payload.rawKey;
    if (typeof payload.agentKey === 'string') return payload.agentKey;
    if (payload.key && typeof payload.key.secret === 'string') return payload.key.secret;
    if (payload.key && typeof payload.key.rawKey === 'string') return payload.key.rawKey;
    return '';
  }

  function resetDeleteConfirmation() {
    if (deleteResetTimer !== null) window.clearTimeout(deleteResetTimer);
    deleteResetTimer = null;
    const button = byId('pm-delete-account');
    if (!(button instanceof HTMLButtonElement)) return;
    delete button.dataset.confirming;
    button.textContent = 'Delete account';
  }

  function resetUnlinkConfirmation() {
    if (unlinkResetTimer !== null) window.clearTimeout(unlinkResetTimer);
    unlinkResetTimer = null;
    const button = byId('pm-google-unlink');
    if (!(button instanceof HTMLButtonElement)) return;
    delete button.dataset.confirming;
    button.textContent = 'Disconnect Google';
  }

  function renderGoogleAuth(payload, authenticated) {
    const google = payload?.authMethods?.google;
    const enabled = google?.enabled === true;
    const linked = google?.linked === true;
    const signedOutPanel = byId('pm-google-auth');
    if (signedOutPanel) signedOutPanel.hidden = authenticated;
    if (!authenticated) {
      const note = byId('pm-google-note');
      const signIn = byId('pm-google-signin');
      if (note) {
        note.textContent = enabled
          ? 'Google proves which account is yours. PartMode requests a stable account identifier and basic profile only, not your email, and still owns the browser session and agent keys.'
          : 'Google sign-in is not configured on this deployment yet. Use an account name and passphrase below.';
      }
      if (signIn) signIn.hidden = !enabled;
      return;
    }

    const connection = byId('pm-google-connection');
    const link = byId('pm-google-link');
    const unlink = byId('pm-google-unlink');
    if (connection) {
      connection.textContent = linked
        ? enabled
          ? 'Google is connected and can sign in to this PartMode account.'
          : 'Google is connected, but Google sign-in is temporarily unavailable.'
        : enabled
          ? 'Google is not connected to this PartMode account.'
          : 'Google sign-in is not configured.';
    }
    if (link) link.hidden = google?.canLink !== true;
    if (unlink) unlink.hidden = !linked || google?.canUnlink !== true;
    resetUnlinkConfirmation();
  }

  function renderAccount(payload) {
    const authenticated = payload?.authenticated === true;
    const authView = byId('pm-auth-view');
    const dashboard = byId('pm-dashboard');
    if (authView) authView.hidden = authenticated;
    if (dashboard) dashboard.hidden = !authenticated;
    renderGoogleAuth(payload, authenticated);

    if (!authenticated) {
      csrfToken = typeof payload?.csrfToken === 'string' ? payload.csrfToken : '';
      clearSecret();
      resetDeleteConfirmation();
      resetUnlinkConfirmation();
      renderKeyList([]);
      return;
    }

    if (typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
    const accountName = byId('pm-account-name');
    if (accountName) {
      accountName.textContent =
        typeof payload.account?.displayName === 'string' && payload.account.displayName.trim()
          ? payload.account.displayName.trim()
          : typeof payload.account?.name === 'string' && payload.account.name.trim()
            ? payload.account.name.trim()
            : 'PartMode account';
    }
    renderKeyList(payload.keys);
  }

  async function refreshAccount({ announce = false } = {}) {
    const payload = await apiRequest('/account');
    renderAccount(payload);
    if (announce) {
      setStatus(payload.authenticated ? 'Account ready.' : 'Sign in or create an account to manage agent keys.', 'success');
    }
    return payload;
  }

  async function submitAuthentication(form, endpoint, successMessage) {
    const name = textField(form, 'name');
    const password = textField(form, 'password');
    if (!name || !password) {
      setStatus('The account form is missing a name or password field.', 'error');
      return;
    }

    const credentials = { name: name.value.trim(), password: password.value };
    const email = textField(form, 'email');                  // TOKCAD: signup carries the email
    if (email) credentials.email = email.value.trim();
    if (!credentials.name) {
      setStatus('Enter your account name.', 'error');
      name.focus();
      return;
    }
    if (!credentials.password) {
      setStatus('Enter your password.', 'error');
      password.focus();
      return;
    }

    setBusy(form, true);
    setStatus('Securing your account session...', 'busy');
    try {
      const payload = await apiRequest(endpoint, { method: 'POST', body: credentials });
      if (payload.verificationSent) {                         // TOKCAD: no session until confirmed
        form.reset();
        setStatus(`Check your email: we sent a link to ${credentials.email} to confirm your account. ` +
          'Open it to finish signing up.', 'success');
        return;
      }
      if (typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
      form.reset();
      await refreshAccount();
      setStatus(successMessage, 'success');
    } catch (error) {
      setStatus(errorMessage(error), 'error');
      if (error.code === 'EMAIL_NOT_VERIFIED') {              // TOKCAD: offer a new link
        showOnly('tok-resend-form', credentials.name.includes('@') ? credentials.name : '');
      }
    } finally {
      password.value = '';
      setBusy(form, false);
    }
  }

  // ── TOKCAD: confirm email, resend, forgot and reset passphrase ─────────────────────────────
  let resetToken = '';

  function showOnly(formId, email = '') {
    for (const id of ['tok-resend-form', 'tok-forgot-form', 'tok-reset-form']) {
      const form = byId(id);
      if (form) form.hidden = id !== formId;
    }
    const field = textField(byId(formId), 'email');
    if (field && email) field.value = email;
    textField(byId(formId), field && !email ? 'email' : 'password')?.focus();
  }

  async function sendEmailForm(form, endpoint, message) {
    const email = textField(form, 'email');
    if (!email?.value.trim()) return;
    setBusy(form, true);
    try {
      await apiRequest(endpoint, { method: 'POST', body: { email: email.value.trim() } });
      setStatus(message.replace('{email}', email.value.trim()), 'success');
      form.hidden = true;
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      setBusy(form, false);
    }
  }

  async function submitReset(form) {
    const password = textField(form, 'password');
    const confirm = textField(form, 'confirm');
    if (!password || !confirm) return;
    if (password.value !== confirm.value) {
      setStatus('The two passphrases do not match.', 'error');
      confirm.focus();
      return;
    }
    setBusy(form, true);
    try {
      await apiRequest('/password/reset', { method: 'POST', body: { token: resetToken, password: password.value } });
      resetToken = '';
      form.hidden = true;
      setStatus('Passphrase changed. Sign in with the new one.', 'success');
      byId('pm-login-form')?.querySelector('input[name=name]')?.focus();
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      password.value = '';
      confirm.value = '';
      setBusy(form, false);
    }
  }

  /** ?verify=ok|invalid after the confirmation link, ?reset=TOKEN from the reset email. */
  function consumeEmailResult() {
    const url = new URL(window.location.href);
    const verify = url.searchParams.get('verify');
    const reset = url.searchParams.get('reset');
    if (!verify && !reset) return null;
    url.searchParams.delete('verify');
    url.searchParams.delete('reset');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (reset) {
      resetToken = reset;
      return ['reset', 'Choose a new passphrase for your account.', ''];
    }
    return verify === 'ok'
      ? ['verified', 'Email confirmed. Your TOK CAD account is ready.', 'success']
      : ['invalid', 'That confirmation link has expired or was already used. Sign in, or send a new link.', 'error'];
  }

  async function createKey(form) {
    const label = textField(form, 'label');
    const access = textField(form, 'access');
    if (!label || !access) {
      setStatus('The key form is missing its label or access control.', 'error');
      return;
    }
    const request = { label: label.value.trim(), access: access.value };
    const headlessInput = form.querySelector('input[name="headless"]');
    if (headlessInput?.checked) {
      if (request.access !== 'edit') {
        setStatus('Headless execution requires an edit-access key.', 'error');
        access.focus();
        return;
      }
      request.headless = true;
    }
    if (!request.label) {
      setStatus('Name the agent or integration that will use this key.', 'error');
      label.focus();
      return;
    }
    if (!Object.hasOwn(ACCESS_LABELS, request.access)) {
      setStatus('Choose read-only or edit access for this key.', 'error');
      access.focus();
      return;
    }

    clearSecret();
    setBusy(form, true);
    setStatus('Creating a one-time agent key...', 'busy');
    try {
      const payload = await apiRequest('/agent-keys', { method: 'POST', body: request });
      const secret = createdSecret(payload);
      showSecret(secret);
      form.reset();
      try {
        const refreshed = await apiRequest('/account');
        if (refreshed?.authenticated !== true) {
          throw new Error('The account session ended before the key list refreshed.');
        }
        renderAccount(refreshed);
        setStatus('Agent key created. Copy it now; PartMode will not show it again.', 'success');
      } catch (refreshError) {
        showSecret(secret);
        setStatus(
          `Warning: the agent key was created, but the key list could not refresh. Copy it now. ${errorMessage(refreshError)}`,
          'error',
        );
      }
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      setBusy(form, false);
    }
  }

  async function revokeKey(button) {
    const id = button.dataset.keyId;
    if (!id) return;
    button.disabled = true;
    setStatus('Revoking the agent key...', 'busy');
    try {
      await apiRequest(`/agent-keys/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
      clearSecret();
      await refreshAccount();
      setStatus('Agent key revoked. It can no longer start a connection.', 'success');
    } catch (error) {
      button.disabled = false;
      setStatus(errorMessage(error), 'error');
    }
  }

  async function copySecret() {
    if (!revealedSecret) {
      setStatus('This key secret is no longer available. Create a new key if you did not save it.', 'error');
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setStatus('Clipboard access is unavailable. Select the key and copy it manually.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(revealedSecret);
      setStatus('Key copied. Store it in your agent secret settings, then dismiss it here.', 'success');
    } catch {
      setStatus('The browser blocked clipboard access. Select the key and copy it manually.', 'error');
    }
  }

  async function linkGoogle(button) {
    button.disabled = true;
    setStatus('Starting secure Google sign-in...', 'busy');
    try {
      const payload = await apiRequest('/auth/google/link', { method: 'POST', body: {} });
      const authorizationUrl = new URL(payload.authorizationUrl);
      if (
        authorizationUrl.protocol !== 'https:' ||
        authorizationUrl.hostname !== 'accounts.google.com' ||
        authorizationUrl.pathname !== '/o/oauth2/v2/auth'
      ) {
        throw new Error('PartMode received an invalid Google authorization address.');
      }
      window.location.assign(authorizationUrl.href);
    } catch (error) {
      button.disabled = false;
      setStatus(errorMessage(error), 'error');
    }
  }

  async function unlinkGoogle(button) {
    if (button.dataset.confirming !== 'true') {
      button.dataset.confirming = 'true';
      button.textContent = 'Confirm disconnect';
      setStatus('Select Confirm disconnect to remove Google as a sign-in method.', 'error');
      unlinkResetTimer = window.setTimeout(resetUnlinkConfirmation, 10_000);
      return;
    }

    resetUnlinkConfirmation();
    button.disabled = true;
    setStatus('Disconnecting Google and rotating account sessions...', 'busy');
    try {
      const payload = await apiRequest('/identities/google', { method: 'DELETE', body: {} });
      renderAccount(payload);
      setStatus('Google disconnected. Your passphrase remains available for sign-in.', 'success');
    } catch (error) {
      button.disabled = false;
      setStatus(errorMessage(error), 'error');
    }
  }

  async function logout(button) {
    setBusy(button.closest('section, article, div') || button, true);
    setStatus('Signing out...', 'busy');
    try {
      await apiRequest('/session', { method: 'DELETE', body: {} });
      csrfToken = '';
      clearSecret();
      await refreshAccount();
      setStatus('Signed out and active agent sessions closed. Local browser projects, agent keys, and durable headless projects remain.', 'success');
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      setBusy(button.closest('section, article, div') || button, false);
    }
  }

  async function deleteAccount(button) {
    if (button.dataset.confirming !== 'true') {
      button.dataset.confirming = 'true';
      button.textContent = 'Confirm delete';
      setStatus('Select Confirm delete to remove the account, revoke every agent key, close agent sessions, and delete every server-headless project.', 'error');
      deleteResetTimer = window.setTimeout(resetDeleteConfirmation, 10_000);
      return;
    }

    resetDeleteConfirmation();
    button.disabled = true;
    setStatus('Deleting the account, keys, agent sessions, and server-headless projects...', 'busy');
    try {
      await apiRequest('/account', { method: 'DELETE', body: {} });
      csrfToken = '';
      clearSecret();
      await refreshAccount();
      setStatus('Account and server-headless projects deleted. Local CAD projects remain in this browser.', 'success');
    } catch (error) {
      button.disabled = false;
      setStatus(errorMessage(error), 'error');
    }
  }

  function consumeGoogleResult() {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('auth');
    if (!result) return null;
    url.searchParams.delete('auth');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    const messages = {
      'google-created': ['PartMode account created with Google. You can now create an agent key.', 'success', true],
      'google-signed-in': ['Signed in with Google. Your agent keys are ready.', 'success', true],
      'google-linked': ['Google connected to this PartMode account.', 'success', true],
      'google-cancelled': ['Google sign-in was cancelled. Nothing changed.', '', false],
      'google-expired': ['That Google sign-in expired. Start again from this page.', 'error', false],
      'google-already-used': ['That Google identity is already connected to another PartMode account.', 'error', false],
      'google-session-ended': ['The PartMode session used to connect Google ended. Sign in and try again.', 'error', false],
      'google-unavailable': ['Google sign-in is not available right now. Use your PartMode passphrase or try again later.', 'error', false],
      'google-failed': ['Google could not complete sign-in. Start again from this page.', 'error', false],
    };
    return messages[result] || ['Google could not complete sign-in.', 'error', false];
  }

  function bindEvents() {
    byId('pm-signup-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthentication(event.currentTarget, '/accounts', 'Account created. You can now create an agent key.');
    });
    byId('pm-login-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthentication(event.currentTarget, '/session', 'Signed in. Your agent keys are ready.');
    });
    byId('tok-forgot-open')?.addEventListener('click', () => showOnly('tok-forgot-form'));   // TOKCAD
    byId('tok-forgot-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      sendEmailForm(event.currentTarget, '/password/forgot',
        'If {email} belongs to an account, a reset link is on its way. Check your inbox (and spam folder).');
    });
    byId('tok-resend-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      sendEmailForm(event.currentTarget, '/email/resend',
        'If {email} is waiting for confirmation, a new link is on its way. Check your inbox (and spam folder).');
    });
    byId('tok-reset-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitReset(event.currentTarget);
    });
    byId('pm-key-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      createKey(event.currentTarget);
    });
    byId('pm-key-list')?.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('button[data-key-id]')
        : null;
      if (button instanceof HTMLButtonElement) revokeKey(button);
    });
    byId('pm-key-copy')?.addEventListener('click', copySecret);
    byId('pm-key-dismiss')?.addEventListener('click', () => {
      clearSecret();
      setStatus('Key hidden. PartMode will not display that secret again.');
    });
    byId('pm-logout')?.addEventListener('click', (event) => logout(event.currentTarget));
    byId('pm-google-link')?.addEventListener('click', (event) => linkGoogle(event.currentTarget));
    byId('pm-google-unlink')?.addEventListener('click', (event) => unlinkGoogle(event.currentTarget));
    byId('pm-delete-account')?.addEventListener('click', (event) => deleteAccount(event.currentTarget));

    window.addEventListener('pagehide', clearSecret);
    window.addEventListener('beforeunload', clearSecret);
    window.addEventListener('popstate', clearSecret);
  }

  async function initialize() {
    const app = byId('pm-account-app');
    if (!app) return;
    bindEvents();
    app.setAttribute('aria-busy', 'true');
    setStatus('Loading account access...', 'busy');
    try {
      const googleResult = consumeGoogleResult();
      const emailResult = consumeEmailResult();               // TOKCAD
      const payload = await refreshAccount();
      if (emailResult) {
        const [kind, message, state] = emailResult;
        setStatus(message, state);
        if (kind === 'reset') showOnly('tok-reset-form');
        if (kind === 'invalid') showOnly('tok-resend-form');
      } else if (googleResult) {
        const [message, state, requiresAccount] = googleResult;
        setStatus(
          requiresAccount && payload.authenticated !== true
            ? 'Google returned successfully, but PartMode did not create an account session. Start again.'
            : message,
          requiresAccount && payload.authenticated !== true ? 'error' : state,
        );
      } else {
        setStatus(
          payload.authenticated
            ? 'Account ready.'
            : 'Create an optional account or sign in to manage agent keys.',
        );
      }
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      app.setAttribute('aria-busy', 'false');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
