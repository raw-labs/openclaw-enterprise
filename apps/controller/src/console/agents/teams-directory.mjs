import { button, element } from "../dom.mjs";
import { namespacePath } from "./list.mjs";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_TEAM = /^19:[^\s]{1,170}@thread\.(?:tacv2|skype)$/;

export function teamsReference(value) {
  const text = value.trim();
  if (GUID.test(text)) {
    return { groupId: text };
  }
  if (NATIVE_TEAM.test(text)) {
    return { nativeId: text };
  }
  try {
    const url = new URL(text);
    const nativeId = decodeURIComponent(
      /^\/l\/team\/([^/]+)\/conversations\/?$/.exec(url.pathname)?.[1] ?? "",
    );
    const groupId = url.searchParams.get("groupId");
    if (
      url.origin === "https://teams.microsoft.com" &&
      !url.username &&
      !url.password &&
      GUID.test(groupId ?? "") &&
      NATIVE_TEAM.test(nativeId)
    ) {
      return { nativeId, groupId };
    }
  } catch {
    // Exact native IDs remain usable without Graph consent or a Team link.
  }
  return null;
}

function lookupError(error) {
  return (
    {
      CHANNEL_DIRECTORY_MISSING_SCOPE:
        "Directory consent is missing. Reinstall the app in this Team with ChannelSettings.Read.Group and TeamMember.Read.Group, or enter exact IDs.",
      CHANNEL_DIRECTORY_CREDENTIALS_REJECTED:
        "Microsoft rejected the app credentials. Check the app, tenant and selected password Secret.",
      CHANNEL_DIRECTORY_RATE_LIMITED: "Microsoft rate limited the directory. Try again shortly.",
      CHANNEL_DIRECTORY_INVALID_RESPONSE:
        "Check the Team reference. Microsoft returned an unexpected directory response.",
      CHANNEL_DIRECTORY_UNAVAILABLE:
        "Teams directory is unavailable. Try again or enter exact IDs.",
    }[error.code] ??
    (error.status === 403
      ? "You need permission to edit this configuration and use its password Secret."
      : "Teams directory is unavailable. Enter exact IDs or ask your operator to check directory egress.")
  );
}

/** Names are transient; the regular Configuration save owns only exact selected IDs. */
export function createTeamsDirectoryField({
  context,
  control,
  label,
  kind,
  getLookup,
  onWorkspace,
}) {
  const search = element("input", {
    id: `${control.id}-search`,
    className: "slack-directory-search",
    type: "text",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": `${control.id}-results`,
    autocomplete: "off",
  });
  const results = element("div", {
    id: `${control.id}-results`,
    className: "slack-directory-results",
    role: "listbox",
    hidden: true,
    "aria-label": `${label} results`,
  });
  const status = element("p", { className: "hint", role: "status", "aria-live": "polite" });
  const selected = element("div", { className: "slack-directory-chips" });
  const more = button("Load more", () => lookup(false, nextCursor), {
    className: "button-secondary",
  });
  more.hidden = true;
  const field = element(
    "div",
    { className: "channel-field slack-directory-field teams-directory-field" },
    element("label", { for: search.id }, label),
    search,
    selected,
    results,
    more,
    status,
    element("label", { for: control.id }, `${label} — exact IDs`),
    control,
  );
  let active = 0;
  let timer;
  let abort;
  let nextCursor;
  let scope;
  let candidates = [];
  let names = new Map();
  const ids = () => [
    ...new Set(
      control.value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const close = () => {
    results.hidden = true;
    search.setAttribute("aria-expanded", "false");
  };
  const renderNames = () => {
    selected.replaceChildren(
      ...ids().map((id) =>
        element(
          "span",
          { className: "slack-directory-chip", title: id },
          names.get(id)?.name ?? id,
        ),
      ),
    );
  };
  const current = (generation, key) =>
    control.isConnected &&
    context.isCurrent() &&
    active === generation &&
    JSON.stringify(getLookup()) === key;
  const choose = (candidate) => {
    control.value = [...new Set([...ids(), candidate.id])].join(", ");
    names.set(candidate.id, candidate);
    renderNames();
    search.value = "";
    close();
    control.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const lookup = async (hydrate = false, cursor) => {
    clearTimeout(timer);
    abort?.abort();
    const generation = ++active;
    const input = getLookup();
    const key = JSON.stringify(input);
    if (!control.isConnected || control.disabled || !input || (hydrate && !ids().length)) {
      return;
    }
    abort = new AbortController();
    status.textContent = "Loading Teams directory…";
    try {
      const page = await context.request(
        `${namespacePath(context.namespaceId)}/channel-directory/lookup`,
        {
          method: "POST",
          readOnly: true,
          signal: abort.signal,
          body: {
            ...input,
            provider: "msteams",
            kind,
            ...(hydrate
              ? { ids: ids().slice(0, 20) }
              : { query: search.value.trim(), ...(cursor ? { cursor } : {}) }),
            ...(context.configurationId ? { configurationId: context.configurationId } : {}),
          },
        },
      );
      if (!current(generation, key)) {
        return;
      }
      if (onWorkspace(page.workspaceId) === false) {
        const error = new Error("Mismatched Team identity");
        error.code = "CHANNEL_DIRECTORY_INVALID_RESPONSE";
        throw error;
      }
      for (const candidate of page.candidates) {
        names.set(candidate.id, candidate);
      }
      renderNames();
      if (!hydrate) {
        candidates = cursor ? [...candidates, ...page.candidates] : page.candidates;
        results.replaceChildren(
          ...candidates.map((candidate) => {
            const option = element(
              "button",
              {
                type: "button",
                role: "option",
                className: "slack-directory-result",
                "aria-selected": String(ids().includes(candidate.id)),
              },
              candidate.name,
              element("small", {}, candidate.id),
            );
            option.addEventListener("click", () => choose(candidate));
            return option;
          }),
        );
        results.hidden = false;
        search.setAttribute("aria-expanded", "true");
        nextCursor = page.nextCursor;
        more.hidden = !nextCursor;
      }
      status.textContent = hydrate
        ? "Names resolved for selected Team members and channels."
        : candidates.length
          ? "Select a result; only its exact ID will be saved."
          : page.complete
            ? "No matching results in this Team."
            : "No matches in this page. Load more to continue.";
    } catch (error) {
      if (!current(generation, key)) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      close();
      more.hidden = true;
      status.textContent = lookupError(error);
    }
  };
  const refresh = () => {
    clearTimeout(timer);
    abort?.abort();
    active += 1;
    close();
    more.hidden = true;
    nextCursor = undefined;
    const input = getLookup();
    const key = JSON.stringify(input);
    if (key !== scope) {
      scope = key;
      names = new Map();
      candidates = [];
      search.value = "";
    }
    search.disabled = !input || control.disabled;
    status.textContent = input
      ? "Search this Team, or enter comma-separated exact IDs below."
      : "Enter app and tenant IDs, select a password Secret, and paste a Team link or group UUID to search. Exact IDs remain available.";
    renderNames();
    if (input && !control.disabled && ids().length) {
      timer = setTimeout(() => lookup(true), 300);
    }
  };
  search.addEventListener("input", () => {
    active += 1;
    abort?.abort();
    close();
    more.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(() => lookup(), 300);
  });
  search.addEventListener("focus", () => {
    if (!search.disabled && results.hidden) {
      lookup();
    }
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      results.querySelector("button")?.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (candidates.length === 1 && !results.hidden) {
        choose(candidates[0]);
      } else {
        lookup();
      }
    }
  });
  results.addEventListener("keydown", (event) => {
    const options = [...results.querySelectorAll("button")];
    const index = options.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      options[
        (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length
      ]?.focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      search.focus();
      close();
    }
  });
  field.addEventListener("focusout", (event) => {
    if (!field.contains(event.relatedTarget)) {
      clearTimeout(timer);
      abort?.abort();
      active += 1;
      close();
      more.hidden = true;
    }
  });
  control.addEventListener("input", renderNames);
  field.refreshValue = refresh;
  field.refreshNames = refresh;
  queueMicrotask(refresh);
  return field;
}
