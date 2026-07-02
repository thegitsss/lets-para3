const states = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia",
  "Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts",
  "Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
  "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island",
  "South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming"
];

const selectedStates = new Set();
const stateInput = document.getElementById("stateInput");
const stateList = document.getElementById("stateList");
const specialtyList = document.getElementById("specialtyList");

function slugify(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function updateStateInput() {
  if (!stateInput) return;
  stateInput.value = [...selectedStates].join(", ");
}

function getStateQuery() {
  return [...selectedStates].join("|");
}

function renderStateList(query = "") {
  if (!stateList) return;
  const cleanQuery = String(query || "").trim().toLowerCase();
  const matches = states.filter((state) => state.toLowerCase().startsWith(cleanQuery));
  stateList.innerHTML = matches
    .map((state) => {
      const id = `state-${slugify(state)}`;
      return `
        <li>
          <input type="checkbox" id="${id}" value="${state}" ${selectedStates.has(state) ? "checked" : ""}>
          <label for="${id}">${state}</label>
        </li>`;
    })
    .join("");
  stateList.classList.toggle("show", matches.length > 0);
}

function openStateList() {
  specialtyList?.classList.remove("show");
  renderStateList("");
}

function closeStateList() {
  stateList?.classList.remove("show");
}

function applySelectedStates() {
  const applyFilters = document.getElementById("applyFilters");
  applyFilters?.click();
}

if (stateInput && stateList) {
  stateInput.readOnly = true;
  stateInput.placeholder = "States";

  stateInput.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openStateList();
  }, true);

  stateInput.addEventListener("focus", () => {
    window.requestAnimationFrame(openStateList);
  });

  stateInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeStateList();
      stateInput.blur();
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openStateList();
    }
  });

  stateList.addEventListener(
    "click",
    (event) => {
      const row = event.target.closest("li");
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const checkbox = row.querySelector("input[type='checkbox']");
      if (!checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    },
    true
  );

  stateList.addEventListener("change", (event) => {
    const value = event.target?.value;
    if (!value) return;
    if (event.target.checked) selectedStates.add(value);
    else selectedStates.delete(value);
    updateStateInput();
    renderStateList("");
  });

  document.addEventListener("click", (event) => {
    const wrapper = stateInput.closest(".dropdown-wrapper");
    if (!wrapper?.contains(event.target)) closeStateList();
  });

  document.getElementById("applyFilters")?.addEventListener("click", () => {
    updateStateInput();
  }, true);

  document.getElementById("clearFilters")?.addEventListener("click", () => {
    selectedStates.clear();
    updateStateInput();
    renderStateList("");
  }, true);

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const selectedStateQuery = getStateQuery();
    if (!selectedStateQuery) return originalFetch(input, init);

    const rawUrl = typeof input === "string" ? input : input?.url;
    if (!rawUrl || !rawUrl.includes("/public/paralegals")) return originalFetch(input, init);

    const url = new URL(rawUrl, window.location.origin);
    url.searchParams.set("location", selectedStateQuery);

    if (typeof input === "string") {
      return originalFetch(`${url.pathname}${url.search}`, init);
    }

    return originalFetch(new Request(url.href, input), init);
  };
}
