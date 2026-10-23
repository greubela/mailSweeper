var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

var spamFilter = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return {
      spamFilter: {
        async addSender(accountId, email, byDomain = false) {
          email = email.trim().toLowerCase();
          const validDomain = domain => /^[^\s<>@,;*.]+(?:\.[^\s<>@,;*.]+)*$/.test(domain);
          if (byDomain ? !email.startsWith("*@") || !validDomain(email.slice(2))
            : !/^(?:"(?:[^"\\\r\n]|\\.)+"|[^\s<>@,;"()]+)@[^\s<>@,;"()]+$/.test(email)) {
            throw new Error("A valid single sender address is required");
          }
          // Include @ so web.de cannot also match otherweb.de or sub.web.de.
          const matchValue = byDomain ? email.slice(1) : email;
          const operator = byDomain ? Ci.nsMsgSearchOp.EndsWith : Ci.nsMsgSearchOp.Is;
          const account = MailServices.accounts.getAccount(accountId);
          if (!account || !account.incomingServer.canHaveFilters) {
            throw new Error("This account does not support message filters");
          }
          const list = account.incomingServer.getFilterList(null);
          const name = "mailSweeperSpam";
          const old = list.getFilterNamed(name);
          const terms = old ? Array.from(old.searchTerms) : [];
          // Refuse to broaden a same-named filter with unrelated or grouped rules.
          if (old && (old.unparseable || !terms.length || terms.some(term =>
            term.attrib !== Ci.nsMsgSearchAttrib.Sender ||
            !(term.op === Ci.nsMsgSearchOp.Is ||
              (term.op === Ci.nsMsgSearchOp.EndsWith && term.value.str.startsWith("@") &&
                validDomain(term.value.str.slice(1)))) || term.booleanAnd ||
            term.matchAll || term.beginsGrouping || term.endsGrouping))) {
            throw new Error("Existing mailSweeperSpam has custom conditions. Use Thunderbird’s Message Filters to resolve them first");
          }
          const filter = list.createFilter(name);
          filter.enabled = true;
          filter.filterType = Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual;
          filter.filterDesc = "Mail Sweeper: sender addresses or domains; mark read, then delete.";
          for (const term of terms) filter.appendTerm(term);
          if (!terms.some(term => term.op === operator && term.value.str.toLowerCase() === matchValue)) {
            const term = filter.createTerm();
            term.attrib = Ci.nsMsgSearchAttrib.Sender;
            term.op = operator;
            term.booleanAnd = false; // Match ANY of the listed addresses.
            const value = term.value;
            value.str = matchValue;
            term.value = value;
            filter.appendTerm(term);
          }
          for (const type of [Ci.nsMsgFilterAction.MarkRead, Ci.nsMsgFilterAction.Delete]) {
            const action = filter.createAction();
            action.type = type;
            filter.appendAction(action);
          }
          let index = 0;
          if (old) {
            while (list.getFilterAt(index) !== old) index++;
            list.setFilterAt(index, filter);
          } else {
            // Place before other filters that could move messages away first.
            list.insertFilterAt(0, filter);
          }
          try {
            list.saveToDefaultFile();
          } catch (error) {
            if (old) list.setFilterAt(index, old);
            else list.removeFilter(filter);
            throw error;
          }
        }
      }
    };
  }
};
