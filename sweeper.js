/* Shared logic, also exercised with a mocked Thunderbird API in tests. */
var Sweeper = (() => {
  function emailAddress(author) {
    const raw = (author || "").trim();
    const match = raw.match(/^(?:"(?:[^"\\]|\\.)*"|[^<>,;"]*)\s*<([^<>]+)>\s*$/);
    const email = (match ? match[1] : raw).trim().toLowerCase();
    return /^(?:"(?:[^"\\\r\n]|\\.)+"|[^\s<>@,;"()]+)@[^\s<>@,;"()]+$/.test(email) ? email : null;
  }

  async function scan(api, now = Date.now()) {
    const [tab] = await api.mailTabs.query({ active: true, currentWindow: true });
    if (!tab?.displayedFolder) {
      throw new Error("Please navigate to a mail folder in the active mail tab, then scan again.");
    }
    const folder = tab.displayedFolder;
    const senders = new Map();
    const cutoff = now - 72 * 60 * 60 * 1000;
    const parsedAuthors = new Map();
    let total = 0;
    let unread = 0;
    let skipped = 0;
    let page = await api.messages.list(folder.id);
    while (true) {
      for (const message of page.messages) {
        total++;
        if (message.read === false) unread++;
        const author = message.author || "";
        if (!parsedAuthors.has(author)) {
          let email = emailAddress(author);
          if (!email && author && api.messengerUtilities?.parseMailboxString) {
            try {
              const mailboxes = await api.messengerUtilities.parseMailboxString(author);
              if (mailboxes.length === 1) email = emailAddress(mailboxes[0].email);
            } catch {
              // Invalid/ambiguous headers are included in the skipped count.
            }
          }
          parsedAuthors.set(author, email);
        }
        const email = parsedAuthors.get(author);
        if (!email) { skipped++; continue; }
        if (!senders.has(email)) senders.set(email, {
          email, ids: [], recentCount: 0, unreadIds: new Set(), recentUnreadIds: new Set(), filtered: false
        });
        const sender = senders.get(email);
        sender.ids.push(message.id);
        const date = message.date == null ? NaN : new Date(message.date).getTime();
        if (date >= cutoff && date <= now) sender.recentCount++;
        if (message.read === false) {
          sender.unreadIds.add(message.id);
          if (date >= cutoff && date <= now) sender.recentUnreadIds.add(message.id);
        }
      }
      if (!page.id) break;
      page = await api.messages.continueList(page.id);
    }
    return { folder, total, unread, skipped, senders: [...senders.values()].sort((a, b) =>
      b.ids.length - a.ids.length || a.email.localeCompare(b.email)) };
  }

  function visibleSenders(senders, minTotal = 50, minRecent = 10, unreadOnly = false) {
    if (![minTotal, minRecent].every(value => Number.isSafeInteger(value) && value >= 1)) {
      throw new Error("Enter a whole number of at least 1 for each minimum.");
    }
    return senders.filter(sender => sender.ids.length > 0 && (unreadOnly
      ? sender.unreadIds.size >= minTotal || sender.recentUnreadIds.size >= minRecent
      : sender.ids.length >= minTotal || sender.recentCount >= minRecent));
  }

  function groupSenders(senders, byDomain = false) {
    if (!byDomain) return senders;
    const groups = new Map();
    for (const sender of senders) {
      if (!sender.ids.length) continue;
      const email = `*@${sender.email.slice(sender.email.lastIndexOf("@") + 1)}`;
      if (!groups.has(email)) groups.set(email, {
        email, byDomain: true, ids: [], recentCount: 0, unreadIds: new Set(), recentUnreadIds: new Set(), members: []
      });
      const group = groups.get(email);
      for (const id of sender.ids) group.ids.push(id);
      group.recentCount += sender.recentCount;
      for (const id of sender.unreadIds || []) group.unreadIds.add(id);
      for (const id of sender.recentUnreadIds || []) group.recentUnreadIds.add(id);
      group.members.push(sender);
    }
    for (const group of groups.values()) {
      group.filtered = group.members.every(sender => sender.domainFiltered);
    }
    return [...groups.values()].sort((a, b) =>
      b.ids.length - a.ids.length || a.email.localeCompare(b.email));
  }

  async function act(api, action, sender, folder) {
    if (action === "spam") {
      if (sender.byDomain) {
        await api.spamFilter.addSender(folder.accountId, sender.email, true);
        for (const member of sender.members) {
          member.domainFiltered = true;
          member.filtered = true;
        }
      } else {
        await api.spamFilter.addSender(folder.accountId, sender.email);
      }
      sender.filtered = true;
      return;
    }
    if (!["read", "delete"].includes(action)) throw new Error("Unknown action");
    // Finish every read update before issuing any deletion. Stop on failure.
    const markedRead = new Set();
    try {
      for (const id of sender.ids) {
        await api.messages.update(id, { read: true });
        markedRead.add(id);
      }
    } finally {
      // Keep cached unread counts accurate, including when an update partly fails.
      for (const member of [sender, ...(sender.members || [])]) {
        for (const id of member.unreadIds || []) {
          if (markedRead.has(id)) {
            member.unreadIds.delete(id);
            member.recentUnreadIds.delete(id);
          }
        }
      }
    }
    if (action === "delete" && sender.ids.length) {
      await api.messages.delete(sender.ids, false);
      sender.ids = [];
      sender.recentCount = 0;
      for (const member of sender.members || []) {
        member.ids = [];
        member.recentCount = 0;
      }
    }
  }
  return { emailAddress, scan, visibleSenders, groupSenders, act };
})();
if (typeof module !== "undefined") module.exports = Sweeper;
