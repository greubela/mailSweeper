document.addEventListener("DOMContentLoaded", () => {
  const scanBtn = document.getElementById("scanBtn");
  const list = document.getElementById("senderList");
  const status = document.getElementById("status");
  const folderName = document.getElementById("folderName");
  const minTotal = document.getElementById("minTotal");
  const minRecent = document.getElementById("minRecent");
  const groupByDomain = document.getElementById("groupByDomain");
  const unreadOnly = document.getElementById("unreadOnly");
  let result;
  let busy = false;

  function setBusy(value) {
    busy = value;
    minTotal.disabled = value;
    minRecent.disabled = value;
    groupByDomain.disabled = value;
    unreadOnly.disabled = value;
    for (const button of document.querySelectorAll("button")) {
      button.disabled = value || button.dataset.done === "true";
    }
  }

  function render() {
    list.replaceChildren();
    const groups = Sweeper.groupSenders(result.senders, groupByDomain.checked);
    const senders = Sweeper.visibleSenders(groups, minTotal.valueAsNumber, minRecent.valueAsNumber, unreadOnly.checked);
    status.textContent = `Showing ${senders.length} of ${groups.length} ${groupByDomain.checked ? "domains" : "sender addresses"}.${result.skipped ? ` Skipped ${result.skipped} messages without a usable sender address.` : ""}`;
    if (!senders.length) {
      list.textContent = "No senders meet either minimum in this folder.";
      return;
    }
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const label of [unreadOnly.checked ? "Unread mails" : "Nr of mails", groupByDomain.checked ? "Sender domain" : "Mail address", "Set to read", "Delete", "Add to spam filter"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      head.append(th);
    }
    const body = table.createTBody();
    for (const sender of senders) {
      const row = body.insertRow();
      row.insertCell().textContent = unreadOnly.checked ? sender.unreadIds.size : sender.ids.length;
      row.insertCell().textContent = sender.email;
      for (const [action, label] of [["read", "Set to read"], ["delete", "Delete"], ["spam", "Add to spam filter"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = action;
        button.textContent = action === "spam" && sender.filtered ? "Added" : label;
        button.setAttribute("aria-label", `${label}: ${sender.email}`);
        button.dataset.done = String(action === "spam" ? sender.filtered : sender.ids.length === 0);
        button.disabled = button.dataset.done === "true";
        button.addEventListener("click", async () => {
          if (busy) return;
          setBusy(true);
          const count = sender.ids.length;
          status.textContent = `${label}: ${sender.email}… Keep this popup open until finished.`;
          try {
            await Sweeper.act(messenger, action, sender, result.folder);
            render();
            status.textContent = action === "spam"
              ? `Added ${sender.email} to mailSweeperSpam for this account. Future matching mail will be marked read and deleted.`
              : action === "delete" ? `Marked read and deleted ${count} messages from ${sender.email}.`
              : `Marked ${count} messages from ${sender.email} as read.`;
          } catch (error) {
            render();
            status.textContent = `${label} failed: ${error.message}. Some messages may already have changed; scan again to refresh.`;
          } finally {
            setBusy(false);
          }
        });
        row.insertCell().append(button);
      }
    }
    list.append(table);
  }

  for (const input of [minTotal, minRecent, groupByDomain, unreadOnly]) {
    input.addEventListener("input", () => {
      if (busy || !result) return;
      try {
        render();
      } catch (error) {
        status.textContent = error.message;
      }
    });
  }

  scanBtn.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    result = null;
    list.replaceChildren();
    folderName.textContent = "";
    status.textContent = "Reading the current folder…";
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
  });
});
