var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

const FILTER_NAME = "mailSweeperSpam";

function validDomain(domain) {
  return /^[^\s<>@,;*.]+(?:\.[^\s<>@,;*.]+)*$/.test(domain);
}

function senderCondition(email, byDomain) {
  email = email.trim().toLowerCase();
  const valid = byDomain
    ? email.startsWith("*@") && validDomain(email.slice(2))
    : /^(?:"(?:[^"\\\r\n]|\\.)+"|[^\s<>@,;"()]+)@[^\s<>@,;"()]+$/.test(email);
  if (!valid) throw new Error("A valid single sender address is required");
  // Include @ so web.de cannot also match otherweb.de or sub.web.de.
  return {
    value: byDomain ? email.slice(1) : email,
    operator: byDomain ? Ci.nsMsgSearchOp.EndsWith : Ci.nsMsgSearchOp.Is
  };
}

function getAccountFilterList(accountId) {
  const account = MailServices.accounts.getAccount(accountId);
  if (!account || !account.incomingServer.canHaveFilters) {
    throw new Error("This account does not support message filters");
  }
  return account.incomingServer.getFilterList(null);
}

function isSupportedTerm(term) {
  if (term.attrib !== Ci.nsMsgSearchAttrib.Sender || term.booleanAnd ||
      term.matchAll || term.beginsGrouping || term.endsGrouping) return false;
  if (term.op === Ci.nsMsgSearchOp.Is) return true;
  return term.op === Ci.nsMsgSearchOp.EndsWith &&
    term.value.str.startsWith("@") && validDomain(term.value.str.slice(1));
}

function getExistingTerms(filter) {
  if (!filter) return [];
  const terms = Array.from(filter.searchTerms);
  // Refuse to broaden a same-named filter with unrelated or grouped rules.
  if (filter.unparseable || !terms.length || !terms.every(isSupportedTerm)) {
    throw new Error("Existing mailSweeperSpam has custom conditions. Use Thunderbird’s Message Filters to resolve them first");
  }
  return terms;
}

function appendSenderTerm(filter, terms, condition) {
  const duplicate = terms.some(term =>
    term.op === condition.operator && term.value.str.toLowerCase() === condition.value);
  if (duplicate) return;
  const term = filter.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Sender;
  term.op = condition.operator;
  term.booleanAnd = false; // Match ANY of the listed addresses or domains.
  const value = term.value;
  value.str = condition.value;
  term.value = value;
  filter.appendTerm(term);
}

function createSpamFilter(list, terms, condition) {
  const filter = list.createFilter(FILTER_NAME);
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual;
  filter.filterDesc = "Mail Sweeper: sender addresses or domains; mark read, then delete.";
  for (const term of terms) filter.appendTerm(term);
  appendSenderTerm(filter, terms, condition);
  for (const type of [Ci.nsMsgFilterAction.MarkRead, Ci.nsMsgFilterAction.Delete]) {
    const action = filter.createAction();
    action.type = type;
    filter.appendAction(action);
  }
  return filter;
}

function saveFilter(list, oldFilter, newFilter) {
  let index = 0;
  if (oldFilter) {
    while (list.getFilterAt(index) !== oldFilter) index++;
    list.setFilterAt(index, newFilter);
  } else {
    // Place before other filters that could move messages away first.
    list.insertFilterAt(0, newFilter);
  }
  try {
    list.saveToDefaultFile();
  } catch (error) {
    if (oldFilter) list.setFilterAt(index, oldFilter);
    else list.removeFilter(newFilter);
    throw error;
  }
}

async function addSender(accountId, email, byDomain = false) {
  const condition = senderCondition(email, byDomain);
  const list = getAccountFilterList(accountId);
  const oldFilter = list.getFilterNamed(FILTER_NAME);
  const terms = getExistingTerms(oldFilter);
  const newFilter = createSpamFilter(list, terms, condition);
  saveFilter(list, oldFilter, newFilter);
}

var spamFilter = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return { spamFilter: { addSender } };
  }
};
