function initializePopup() {
  const scanBtn = document.getElementById("scanBtn");
  const list = document.getElementById("senderList");
  const status = document.getElementById("status");
  const folderName = document.getElementById("folderName");
  const minTotal = document.getElementById("minTotal");
  const minRecent = document.getElementById("minRecent");
  const groupByDomain = document.getElementById("groupByDomain");
  const unreadOnly = document.getElementById("unreadOnly");
  const showAllBtn = document.getElementById("showAllBtn");
  const scanSummary = document.getElementById("scanSummary");
  const filterInputs = [minTotal, minRecent, groupByDomain, unreadOnly];
  const actionLabels = { read: "Set to read", delete: "Delete", spam: "Add to spam filter" };
  let result;
  let busy = false;

  function setBusy(value) {
    busy = value;
    for (const input of filterInputs) input.disabled = value;
    for (const button of document.querySelectorAll("button")) {
      button.disabled = value || button.dataset.done === "true";
    }
    showAllBtn.disabled = value || !result;
  }

  function updateSummary(groups, senders) {
    const hidden = groups.length - senders.length;
    const skipped = result.skipped
      ? ` ${result.skipped} message${result.skipped === 1 ? "" : "s"} skipped: missing or ambiguous sender address.`
      : "";
    scanSummary.textContent = `Scanned ${result.total} messages (${result.unread} unread at scan time). ` +
      `${hidden} ${groupByDomain.checked ? "domains" : "addresses"} hidden by the current filters.${skipped}`;
    status.textContent = `Showing ${senders.length} of ${groups.length} ${groupByDomain.checked ? "domains" : "sender addresses"}.`;
  }

  function createTableHeader(table) {
    const row = table.createTHead().insertRow();
    const labels = [
      unreadOnly.checked ? "Unread mails" : "Nr of mails",
      groupByDomain.checked ? "Sender domain" : "Mail address",
      ...Object.values(actionLabels)
    ];
    for (const label of labels) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      row.append(th);
    }
  }

  function createActionButton(action, sender) {
    const label = actionLabels[action];
    const button = document.createElement("button");
    const done = action === "spam" ? sender.filtered : sender.ids.length === 0;
    button.type = "button";
    button.className = action;
    button.textContent = action === "spam" && sender.filtered ? "Added" : label;
    button.setAttribute("aria-label", `${label}: ${sender.email}`);
    button.dataset.done = String(done);
    button.disabled = done;
    button.addEventListener("click", () => runAction(action, sender));
    return button;
  }

  function appendSenderRow(body, sender) {
    const row = body.insertRow();
    row.insertCell().textContent = unreadOnly.checked ? sender.unreadIds.size : sender.ids.length;
    row.insertCell().textContent = sender.email;
    for (const action of Object.keys(actionLabels)) {
      row.insertCell().append(createActionButton(action, sender));
    }
  }

  function render() {
    list.replaceChildren();
    const groups = Sweeper.groupSenders(result.senders, groupByDomain.checked).filter(sender => sender.ids.length);
    const senders = Sweeper.visibleSenders(groups, minTotal.valueAsNumber, minRecent.valueAsNumber, unreadOnly.checked);
    updateSummary(groups, senders);
    if (!senders.length) {
      list.textContent = "No senders meet either minimum in this folder.";
      return;
    }
    const table = document.createElement("table");
    createTableHeader(table);
    const body = table.createTBody();
    for (const sender of senders) appendSenderRow(body, sender);
    list.append(table);
  }

  function actionSuccessMessage(action, sender, count) {
    if (action === "spam") {
      return `Added ${sender.email} to mailSweeperSpam for this account. Future matching mail will be marked read and deleted.`;
    }
    if (action === "delete") return `Marked read and deleted ${count} messages from ${sender.email}.`;
    return `Marked ${count} messages from ${sender.email} as read.`;
  }

  async function runAction(action, sender) {
    if (busy) return;
    setBusy(true);
    const label = actionLabels[action];
    const count = sender.ids.length;
    status.textContent = `${label}: ${sender.email}… Keep this popup open until finished.`;
    try {
      await Sweeper.act(messenger, action, sender, result.folder);
      render();
      status.textContent = actionSuccessMessage(action, sender, count);
    } catch (error) {
      render();
      status.textContent = `${label} failed: ${error.message}. Some messages may already have changed; scan again to refresh.`;
    } finally {
      setBusy(false);
    }
  }

  function showAllSenders() {
    if (busy || !result) return;
    minTotal.value = "1";
    minRecent.value = "1";
    unreadOnly.checked = false;
    render();
  }

  function updateFilters() {
    if (busy || !result) return;
    try {
      render();
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function resetScanView() {
    result = null;
    showAllBtn.disabled = true;
    list.replaceChildren();
    folderName.textContent = "";
    scanSummary.textContent = "";
    status.textContent = "Reading the current folder…";
  }

  async function scanCurrentFolder() {
    if (busy) return;
    setBusy(true);
    resetScanView();
    try {
      result = await Sweeper.scan(messenger);
      folderName.textContent = `Folder: ${result.folder.path || result.folder.name}`;
      render();
    } catch (error) {
      list.textContent = "Scan unavailable.";
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  }

  showAllBtn.addEventListener("click", showAllSenders);
  scanBtn.addEventListener("click", scanCurrentFolder);
  for (const input of filterInputs) input.addEventListener("input", updateFilters);
}

document.addEventListener("DOMContentLoaded", initializePopup);
