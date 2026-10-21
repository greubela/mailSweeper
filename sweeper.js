/* Shared logic, also exercised with a mocked Thunderbird API in tests. */
var Sweeper = (() => {
  function emailAddress(author) {
    const raw = (author || "").trim();
    const match = raw.match(/<([^<>]+)>\s*$/);
    const email = (match ? match[1] : raw).trim().toLowerCase();
    return /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(email) ? email : null;
  }

  async function scan(api, now = Date.now()) {
    const [tab] = await api.mailTabs.query({ active: true, currentWindow: true });
    if (!tab?.displayedFolder) {
      throw new Error("Please navigate to a mail folder in the active mail tab, then scan again.");
    }
    const folder = tab.displayedFolder;
    const senders = new Map();
    const cutoff = now - 72 * 60 * 60 * 1000;
    let skipped = 0;
    let page = await api.messages.list(folder.id);
    while (true) {
      for (const message of page.messages) {
        const email = emailAddress(message.author);
        if (!email) { skipped++; continue; }
        if (!senders.has(email)) senders.set(email, { email, ids: [], recentCount: 0, filtered: false });
        const sender = senders.get(email);
        sender.ids.push(message.id);
        const date = message.date == null ? NaN : new Date(message.date).getTime();
        if (date >= cutoff && date <= now) sender.recentCount++;
      }
      if (!page.id) break;
      page = await api.messages.continueList(page.id);
    }
    return { folder, skipped, senders: [...senders.values()].sort((a, b) =>
      b.ids.length - a.ids.length || a.email.localeCompare(b.email)) };
  }

  function visibleSenders(senders, minTotal = 50, minRecent = 10) {
    if (![minTotal, minRecent].every(value => Number.isSafeInteger(value) && value >= 1)) {
      throw new Error("Enter a whole number of at least 1 for each minimum.");
    }
    return senders.filter(sender => sender.ids.length > 0 &&
      (sender.ids.length >= minTotal || sender.recentCount >= minRecent));
  }

  async function act(api, action, sender, folder) {
    if (action === "spam") {
      await api.spamFilter.addSender(folder.accountId, sender.email);
      sender.filtered = true;
      return;
    }
    if (!["read", "delete"].includes(action)) throw new Error("Unknown action");
    // Finish every read update before issuing any deletion. Stop on failure.
    for (const id of sender.ids) await api.messages.update(id, { read: true });
    if (action === "delete" && sender.ids.length) {
      await api.messages.delete(sender.ids, false);
      sender.ids = [];
    }
  }
  return { emailAddress, scan, visibleSenders, act };
})();
if (typeof module !== "undefined") module.exports = Sweeper;
