/* Shared logic, also exercised with a mocked Thunderbird API in tests. */
var Sweeper = (() => {
  const RECENT_HOURS = 72;

  function emailAddress(author) {
    const raw = (author || "").trim();
    const match = raw.match(/^(?:"(?:[^"\\]|\\.)*"|[^<>,;"]*)\s*<([^<>]+)>\s*$/);
    const email = (match ? match[1] : raw).trim().toLowerCase();
    return /^(?:"(?:[^"\\\r\n]|\\.)+"|[^\s<>@,;"()]+)@[^\s<>@,;"()]+$/.test(email) ? email : null;
  }

  async function getCurrentFolder(api) {
    const [tab] = await api.mailTabs.query({ active: true, currentWindow: true });
    if (!tab?.displayedFolder) {
      throw new Error("Please navigate to a mail folder in the active mail tab, then scan again.");
    }
    return tab.displayedFolder;
  }

  async function* folderMessages(api, folder) {
    let page = await api.messages.list(folder.id);
    while (true) {
      yield* page.messages;
      if (!page.id) return;
      page = await api.messages.continueList(page.id);
    }
  }

  async function resolveSenderAddress(api, author, cache) {
    if (cache.has(author)) return cache.get(author);
    let email = emailAddress(author);
    if (!email && author && api.messengerUtilities?.parseMailboxString) {
      try {
        const mailboxes = await api.messengerUtilities.parseMailboxString(author);
        if (mailboxes.length === 1) email = emailAddress(mailboxes[0].email);
      } catch {
        // Invalid/ambiguous headers are included in the skipped count.
      }
    }
    cache.set(author, email);
    return email;
  }

  function createSender(email) {
    return {
      email, ids: [], recentCount: 0, unreadIds: new Set(), recentUnreadIds: new Set(), filtered: false
    };
  }

  function addMessage(sender, message, now) {
    const date = message.date == null ? NaN : new Date(message.date).getTime();
    const recent = date >= now - RECENT_HOURS * 60 * 60 * 1000 && date <= now;
    sender.ids.push(message.id);
    if (recent) sender.recentCount++;
    if (message.read === false) {
      sender.unreadIds.add(message.id);
      if (recent) sender.recentUnreadIds.add(message.id);
    }
  }

  function compareSenders(a, b) {
    return b.ids.length - a.ids.length || a.email.localeCompare(b.email);
  }

  async function scan(api, now = Date.now()) {
    const folder = await getCurrentFolder(api);
    const senders = new Map();
    const parsedAuthors = new Map();
    const result = { folder, total: 0, unread: 0, skipped: 0 };
    for await (const message of folderMessages(api, folder)) {
      result.total++;
      if (message.read === false) result.unread++;
      const email = await resolveSenderAddress(api, message.author || "", parsedAuthors);
      if (!email) { result.skipped++; continue; }
      if (!senders.has(email)) senders.set(email, createSender(email));
      addMessage(senders.get(email), message, now);
    }
    result.senders = [...senders.values()].sort(compareSenders);
    return result;
  }

  function validateMinimums(minTotal, minRecent) {
    if (![minTotal, minRecent].every(value => Number.isSafeInteger(value) && value >= 1)) {
      throw new Error("Enter a whole number of at least 1 for each minimum.");
    }
  }

  function visibleSenders(senders, minTotal = 50, minRecent = 10, unreadOnly = false) {
    validateMinimums(minTotal, minRecent);
    return senders.filter(sender => {
      if (!sender.ids.length) return false;
      const total = unreadOnly ? sender.unreadIds.size : sender.ids.length;
      const recent = unreadOnly ? sender.recentUnreadIds.size : sender.recentCount;
      return total >= minTotal || recent >= minRecent;
    });
  }

  function addDomainMember(group, sender) {
    for (const id of sender.ids) group.ids.push(id);
    group.recentCount += sender.recentCount;
    for (const id of sender.unreadIds || []) group.unreadIds.add(id);
    for (const id of sender.recentUnreadIds || []) group.recentUnreadIds.add(id);
    group.members.push(sender);
  }

  function groupSenders(senders, byDomain = false) {
    if (!byDomain) return senders;
    const groups = new Map();
    for (const sender of senders) {
      if (!sender.ids.length) continue;
      const email = `*@${sender.email.slice(sender.email.lastIndexOf("@") + 1)}`;
      if (!groups.has(email)) {
        groups.set(email, { ...createSender(email), byDomain: true, members: [] });
      }
      addDomainMember(groups.get(email), sender);
    }
    for (const group of groups.values()) {
      group.filtered = group.members.every(sender => sender.domainFiltered);
    }
    return [...groups.values()].sort(compareSenders);
  }

  async function addSpamRule(api, sender, folder) {
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
  }

  function clearUnreadCounts(sender, markedRead) {
    for (const member of [sender, ...(sender.members || [])]) {
      for (const id of member.unreadIds || []) {
        if (markedRead.has(id)) {
          member.unreadIds.delete(id);
          member.recentUnreadIds.delete(id);
        }
      }
    }
  }

  async function markSenderRead(api, sender) {
    const markedRead = new Set();
    try {
      for (const id of sender.ids) {
        await api.messages.update(id, { read: true });
        markedRead.add(id);
      }
    } finally {
      // Reflect successful updates even if a later update fails.
      clearUnreadCounts(sender, markedRead);
    }
  }

  async function deleteSender(api, sender) {
    if (!sender.ids.length) return;
    await api.messages.delete(sender.ids, false);
    for (const member of [sender, ...(sender.members || [])]) {
      member.ids = [];
      member.recentCount = 0;
    }
  }

  async function act(api, action, sender, folder) {
    if (action === "spam") return addSpamRule(api, sender, folder);
    if (!["read", "delete"].includes(action)) throw new Error("Unknown action");
    // Finish every read update before issuing any deletion. Stop on failure.
    await markSenderRead(api, sender);
    if (action === "delete") await deleteSender(api, sender);
  }

  return { emailAddress, scan, visibleSenders, groupSenders, act };
})();
if (typeof module !== "undefined") module.exports = Sweeper;
