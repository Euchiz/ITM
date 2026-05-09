// Sign-in view (magic-link). Renders into the host element passed in.

import { auth } from "./supabase.js";

export function renderAuthView(host, { onSent } = {}) {
  host.innerHTML = `
    <div class="auth-card">
      <h1>Itinerary Studio</h1>
      <p>A collaborative space for planning trips. Sign in with your email to manage your itineraries.</p>
      <form id="authForm" autocomplete="off">
        <label>Email
          <input id="authEmail" type="email" required placeholder="you@example.com" autocomplete="email">
        </label>
        <button class="btn primary" type="submit">Send magic link</button>
        <p class="auth-status muted" id="authStatus" hidden></p>
      </form>
      <p class="auth-help muted">
        We'll email you a one-time link. Click it to come back here signed in —
        no password to remember.
      </p>
    </div>
  `;

  const form = host.querySelector("#authForm");
  const email = host.querySelector("#authEmail");
  const status = host.querySelector("#authStatus");
  const btn = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = email.value.trim();
    if (!value) return;
    btn.disabled = true;
    status.hidden = false;
    status.textContent = "Sending magic link…";
    status.classList.remove("error");
    try {
      await auth.signInWithMagicLink(value);
      status.textContent = `Check ${value} for your sign-in link.`;
      onSent?.(value);
    } catch (err) {
      status.classList.add("error");
      status.textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
    }
  });
}
