// Auth view. Four modes:
//   sign-in   — email + password (default)
//   sign-up   — create new account
//   forgot    — request a password-reset email
//   reset     — set a new password (entered when a recovery token is in the URL)

import { auth } from "./supabase.js";
import { t } from "./i18n/locale.js";

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
        <h1>${esc(t("auth.reset.title"))}</h1>
        <p>${esc(t("auth.reset.help"))}</p>
      `;
    }
    if (m === "forgot") {
      return `
        <button class="auth-back" id="backToSignIn">${esc(t("auth.forgot.back"))}</button>
        <h1>${esc(t("auth.forgot.title"))}</h1>
        <p>${esc(t("auth.forgot.help"))}</p>
      `;
    }
    return `
      <h1>${esc(t("app.brand"))}</h1>
      <p>${esc(t("app.tagline"))}</p>
      <div class="auth-tabs" role="tablist">
        <button data-mode="sign-in" class="${m === "sign-in" ? "active" : ""}" role="tab">${esc(t("auth.signIn.tab"))}</button>
        <button data-mode="sign-up" class="${m === "sign-up" ? "active" : ""}" role="tab">${esc(t("auth.signUp.tab"))}</button>
      </div>
    `;
  }

  function body(m) {
    if (m === "reset") {
      return `
        <form id="authForm" autocomplete="off" novalidate>
          <label>${esc(t("auth.reset.newLabel"))}
            <input id="pw1" type="password" required minlength="6" autocomplete="new-password">
          </label>
          <label>${esc(t("auth.reset.confirmLabel"))}
            <input id="pw2" type="password" required minlength="6" autocomplete="new-password">
          </label>
          <button class="btn primary" type="submit">${esc(t("auth.reset.submit"))}</button>
          <p class="auth-status muted" id="authStatus" hidden></p>
        </form>
      `;
    }
    if (m === "forgot") {
      return `
        <form id="authForm" autocomplete="off" novalidate>
          <label>${esc(t("auth.field.email"))}
            <input id="email" type="email" required autocomplete="email">
          </label>
          <button class="btn primary" type="submit">${esc(t("auth.forgot.submit"))}</button>
          <p class="auth-status muted" id="authStatus" hidden></p>
        </form>
      `;
    }
    const isSignUp = m === "sign-up";
    return `
      <form id="authForm" autocomplete="off" novalidate>
        <label>${esc(t("auth.field.email"))}
          <input id="email" type="email" required autocomplete="email">
        </label>
        <label>${esc(t("auth.field.password"))}
          <input id="password" type="password" required minlength="6"
                 autocomplete="${isSignUp ? "new-password" : "current-password"}">
        </label>
        ${isSignUp ? `
          <label>${esc(t("auth.field.confirmPassword"))}
            <input id="password2" type="password" required minlength="6" autocomplete="new-password">
          </label>
          <p class="auth-help muted">${esc(t("auth.signup.help"))}</p>
        ` : ""}
        <button class="btn primary" type="submit">${esc(isSignUp ? t("auth.signUp.submit") : t("auth.signIn.submit"))}</button>
        ${!isSignUp ? `<button class="auth-link" type="button" id="forgotLink">${esc(t("auth.forgotLink"))}</button>` : ""}
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
          if (password !== confirm) throw new Error(t("auth.err.passwordMismatch"));
          if (password.length < 6) throw new Error(t("auth.err.passwordShort"));
          const { needsConfirmation } = await auth.signUp(email, password);
          if (needsConfirmation) {
            setStatus(t("auth.signUp.checkEmail", { email }));
          }
          // If confirmation isn't required, the auth state change will route us.
        } else if (mode === "forgot") {
          const email = host.querySelector("#email").value.trim();
          await auth.sendPasswordReset(email);
          setStatus(t("auth.forgot.sent", { email }));
        } else if (mode === "reset") {
          const pw1 = host.querySelector("#pw1").value;
          const pw2 = host.querySelector("#pw2").value;
          if (pw1 !== pw2) throw new Error(t("auth.err.passwordMismatch"));
          if (pw1.length < 6) throw new Error(t("auth.err.passwordShort"));
          await auth.updatePassword(pw1);
          setStatus(t("auth.reset.signingIn"));
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

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
