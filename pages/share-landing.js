// Share-link landing screen.
//
// Shown when a visitor hits the app with `#share=<token>` in the URL
// AND no session exists yet. Renders trip context (title, destination,
// dates, owner, role) on top of three CTAs:
//
//   Sign in             — flips to the auth view; the share fragment
//                         stays in the URL, so after a successful
//                         sign-in the router will pick it up and
//                         redeem under the real account.
//
//   Sign up             — same shape, sign-up tab pre-selected.
//
//   Continue as guest   — mints an anonymous session, redeems the
//                         token (optionally setting a display name),
//                         opens the trip. Backed by Supabase's
//                         signInAnonymously().
//
// peek_share_link is unauthenticated; we call it before the user has
// any session at all.

import { auth, share } from "../supabase.js";
import { el } from "./_utils.js";

export async function renderShareLanding(host, opts) {
  const { token, onAuthRequest, onRedeemed, onError } = opts;

  host.innerHTML = "";
  host.appendChild(el("div", { class: "share-landing-loading", text: "Opening shared trip…" }));

  let preview = null;
  try {
    preview = await share.peek(token);
  } catch (e) {
    onError?.(e);
    host.innerHTML = "";
    host.appendChild(renderError("We couldn't open that link. It may be malformed or expired."));
    return;
  }

  if (!preview) {
    host.innerHTML = "";
    host.appendChild(renderError("This share link doesn't exist."));
    return;
  }

  if (preview.revoked) {
    host.innerHTML = "";
    host.appendChild(renderError(`This link has been revoked by ${preview.owner_display_name || "the owner"}. Ask them for a new one.`));
    return;
  }

  if (preview.expired) {
    host.innerHTML = "";
    host.appendChild(renderError(`This link has expired. Ask ${preview.owner_display_name || "the owner"} for a new one.`));
    return;
  }

  host.innerHTML = "";
  host.appendChild(renderCard(preview, token, { onAuthRequest, onRedeemed, onError }));
}

function renderError(message) {
  return el("div", { class: "share-landing-card share-landing-error" },
    el("h1", { text: "Can't open this link" }),
    el("p", { class: "muted", text: message }),
  );
}

function renderCard(preview, token, { onAuthRequest, onRedeemed, onError }) {
  const card = el("section", { class: "share-landing-card" });

  // ===== Trip context =====
  const roleLabel = preview.role === "viewer" ? "View-only access" : "Editor access";
  const dateLabel = formatDateRange(preview.start_date, preview.end_date);
  const ownerLabel = preview.owner_display_name
    ? `Shared by ${preview.owner_display_name}`
    : "Shared with you";

  card.appendChild(el("div", { class: "share-landing-context" },
    el("h1", { class: "share-landing-title", text: preview.trip_title || "Untitled trip" }),
    preview.destination
      ? el("p", { class: "share-landing-destination", text: preview.destination })
      : null,
    dateLabel
      ? el("p", { class: "share-landing-dates", text: dateLabel })
      : null,
    el("p", { class: "share-landing-meta" },
      el("span", { class: "share-landing-owner", text: ownerLabel }),
      el("span", { class: "share-landing-sep", text: " · " }),
      el("span", { class: "share-landing-role", text: roleLabel }),
    ),
  ));

  // ===== CTAs =====
  const ctas = el("div", { class: "share-landing-ctas" });
  card.appendChild(ctas);

  const signInBtn = el("button", { class: "btn", text: "Sign in", type: "button" });
  signInBtn.addEventListener("click", () => onAuthRequest?.("sign-in"));

  const signUpBtn = el("button", { class: "btn", text: "Sign up", type: "button" });
  signUpBtn.addEventListener("click", () => onAuthRequest?.("sign-up"));

  const guestBtn = el("button", { class: "btn primary", text: "Continue as guest →", type: "button" });

  ctas.appendChild(signInBtn);
  ctas.appendChild(signUpBtn);
  ctas.appendChild(guestBtn);

  // ===== Guest name input (optional) =====
  const nameWrap = el("label", { class: "share-landing-name" },
    el("span", { class: "share-landing-name-label", text: "Your name (optional)" }),
  );
  const nameInput = el("input", {
    type: "text",
    class: "share-landing-name-input",
    placeholder: "Helps the team know who you are",
    autocomplete: "given-name",
    maxlength: "40",
  });
  nameWrap.appendChild(nameInput);
  card.appendChild(nameWrap);

  // Disclosure line under the CTAs.
  card.appendChild(el("p", { class: "share-landing-note muted",
    text: "Guests can edit but trips won't save to your list. You can register anytime to keep this trip." }));

  const statusEl = el("p", { class: "share-landing-status muted", hidden: true });
  card.appendChild(statusEl);

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || "";
    statusEl.hidden = !msg;
    statusEl.classList.toggle("error", !!isError);
  }

  guestBtn.addEventListener("click", async () => {
    if (guestBtn.disabled) return;
    guestBtn.disabled = true;
    signInBtn.disabled = true;
    signUpBtn.disabled = true;
    setStatus("Joining…");
    try {
      await auth.signInAnonymously();
      const tripId = await share.redeem(token, nameInput.value || null);
      share.stripTokenFromUrl();
      onRedeemed?.(tripId);
    } catch (e) {
      setStatus(e.message || String(e), true);
      guestBtn.disabled = false;
      signInBtn.disabled = false;
      signUpBtn.disabled = false;
      onError?.(e);
    }
  });

  return card;
}

function formatDateRange(start, end) {
  if (!start && !end) return "";
  const sd = start ? new Date(start) : null;
  const ed = end ? new Date(end) : null;
  const fmt = (d) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (sd && ed) {
    if (start === end) return fmt(sd);
    return `${fmt(sd)} – ${fmt(ed)}`;
  }
  return fmt(sd || ed);
}
