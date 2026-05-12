// Auth view. Four modes:
//   sign-in   — email + password (default)
//   sign-up   — create new account
//   forgot    — request a password-reset email
//   reset     — set a new password (entered when a recovery token is in the URL)

import { auth } from "./supabase.js";

export function renderAuthView(host, opts = {}) {
  const initialMode = opts.initialMode || "sign-in";
  let mode = initialMode;

  function rerender() {
    host.innerHTML = `
      <div class="auth-card">
        ${header(mode)}
        ${body(mode)}
      </div>
    `;
    bind();
  }

  function header(m) {
    if (m === "reset") {
      return `
        <h1>Set a new password</h1>
        <p>Choose a password for your account, then sign in to continue.</p>
      `;
    }
    if (m === "forgot") {
      return `
        <button class="auth-back" id="backToSignIn">← Back to sign in</button>
        <h1>Reset your password</h1>
        <p>Enter the email you signed up with. We'll email you a link to set a new password.</p>
      `;
    }
    return `
      <h1>Hermes Daybook</h1>
      <p>A collaborative space for planning trips. Sign in to manage your itineraries.</p>
      <div class="auth-tabs" role="tablist">
        <button data-mode="sign-in" class="${m === "sign-in" ? "active" : ""}" role="tab">Sign in</button>
        <button data-mode="sign-up" class="${m === "sign-up" ? "active" : ""}" role="tab">Create account</button>
      </div>
    `;
  }

  function body(m) {
    if (m === "reset") {
      return `
        <form id="authForm" autocomplete="off" novalidate>
          <label>New password
            <input id="pw1" type="password" required minlength="6" autocomplete="new-password">
          </label>
          <label>Confirm new password
            <input id="pw2" type="password" required minlength="6" autocomplete="new-password">
          </label>
          <button class="btn primary" type="submit">Update password</button>
          <p class="auth-status muted" id="authStatus" hidden></p>
        </form>
      `;
    }
    if (m === "forgot") {
      return `
        <form id="authForm" autocomplete="off" novalidate>
          <label>Email
            <input id="email" type="email" required autocomplete="email">
          </label>
          <button class="btn primary" type="submit">Send reset link</button>
          <p class="auth-status muted" id="authStatus" hidden></p>
        </form>
      `;
    }
    const isSignUp = m === "sign-up";
    return `
      <form id="authForm" autocomplete="off" novalidate>
        <label>Email
          <input id="email" type="email" required autocomplete="email">
        </label>
        <label>Password
          <input id="password" type="password" required minlength="6"
                 autocomplete="${isSignUp ? "new-password" : "current-password"}">
        </label>
        ${isSignUp ? `
          <label>Confirm password
            <input id="password2" type="password" required minlength="6" autocomplete="new-password">
          </label>
          <p class="auth-help muted">At least 6 characters. We'll send a confirmation email; click the link to activate your account.</p>
        ` : ""}
        <button class="btn primary" type="submit">${isSignUp ? "Create account" : "Sign in"}</button>
        ${!isSignUp ? `<button class="auth-link" type="button" id="forgotLink">Forgot password?</button>` : ""}
        <p class="auth-status muted" id="authStatus" hidden></p>
      </form>
    `;
  }

  function bind() {
    host.querySelectorAll(".auth-tabs button").forEach((b) => {
      b.addEventListener("click", () => {
        mode = b.dataset.mode;
        rerender();
      });
    });

    const back = host.querySelector("#backToSignIn");
    if (back) back.addEventListener("click", () => { mode = "sign-in"; rerender(); });

    const forgot = host.querySelector("#forgotLink");
    if (forgot) forgot.addEventListener("click", () => { mode = "forgot"; rerender(); });

    const form = host.querySelector("#authForm");
    if (!form) return;
    const status = host.querySelector("#authStatus");
    const submitBtn = form.querySelector("button[type=submit]");

    function setStatus(msg, isError = false) {
      status.hidden = !msg;
      status.textContent = msg || "";
      status.classList.toggle("error", !!isError);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      setStatus("");
      try {
        if (mode === "sign-in") {
          const email = host.querySelector("#email").value.trim();
          const password = host.querySelector("#password").value;
          await auth.signIn(email, password);
          // onAuthStateChange in app.js will route us out of the auth view.
        } else if (mode === "sign-up") {
          const email = host.querySelector("#email").value.trim();
          const password = host.querySelector("#password").value;
          const confirm = host.querySelector("#password2").value;
          if (password !== confirm) throw new Error("Passwords don't match.");
          if (password.length < 6) throw new Error("Password must be at least 6 characters.");
          const { needsConfirmation } = await auth.signUp(email, password);
          if (needsConfirmation) {
            setStatus(`Check ${email} for a confirmation link to finish creating your account.`);
          }
          // If confirmation isn't required, the auth state change will route us.
        } else if (mode === "forgot") {
          const email = host.querySelector("#email").value.trim();
          await auth.sendPasswordReset(email);
          setStatus(`If ${email} has an account, you'll get a reset link shortly.`);
        } else if (mode === "reset") {
          const pw1 = host.querySelector("#pw1").value;
          const pw2 = host.querySelector("#pw2").value;
          if (pw1 !== pw2) throw new Error("Passwords don't match.");
          if (pw1.length < 6) throw new Error("Password must be at least 6 characters.");
          await auth.updatePassword(pw1);
          setStatus("Password updated. Signing you in…");
          opts.onPasswordReset?.();
        }
      } catch (err) {
        setStatus(err.message || String(err), true);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  rerender();
}
