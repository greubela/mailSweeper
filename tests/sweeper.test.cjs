const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sweeper = require('../sweeper.js');

test('mailTabs displayedFolder, pagination, normalization, all senders and malformed author', async () => {
  const api = {
    mailTabs: { query: async query => {
      assert.deepEqual(query, { active: true, currentWindow: true });
      return [{ displayedFolder: { id: 'folder', accountId: 'account1' } }];
    } },
    messages: {
      list: async id => { assert.equal(id, 'folder'); return { messages: [{ id: 1, author: 'Bulk <BULK@example.test>' }], id: 'page2' }; },
      continueList: async id => {
        assert.equal(id, 'page2');
        return { messages: [{ id: 2, author: 'bulk@example.test' }, { id: 3, author: 'small@example.test' }, { id: 4 }] };
      }
    }
  };
  const result = await Sweeper.scan(api);
  assert.deepEqual(result.senders.map(s => [s.email, s.ids]), [['bulk@example.test', [1, 2]], ['small@example.test', [3]]]);
  assert.equal(result.skipped, 1);
});

test('missing folder and pagination failures propagate', async () => {
  await assert.rejects(Sweeper.scan({ mailTabs: { query: async () => [] } }), /navigate/);
  await assert.rejects(Sweeper.scan({
    mailTabs: { query: async () => [{ displayedFolder: { id: 'f' } }] },
    messages: { list: async () => ({ messages: [], id: 'next' }), continueList: async () => { throw Error('offline'); } }
  }), /offline/);
});

test('delete updates single IDs, completes reads first, and uses account deletion policy', async () => {
  const calls = [];
  const sender = { ids: [11, 12] };
  await Sweeper.act({ messages: {
    update: async (...args) => calls.push(['update', ...args]),
    delete: async (...args) => calls.push(['delete', ...args])
  } }, 'delete', sender, {});
  assert.deepEqual(calls, [['update', 11, { read: true }], ['update', 12, { read: true }], ['delete', [11, 12], false]]);
  assert.deepEqual(sender.ids, []);
});

test('failed read prevents deletion; failed delete retains row IDs', async () => {
  const sender = { ids: [1, 2] };
  const api = { messages: { update: async () => { throw Error('read failed'); }, delete: async () => assert.fail('must not delete') } };
  await assert.rejects(Sweeper.act(api, 'delete', sender, {}), /read failed/);
  assert.deepEqual(sender.ids, [1, 2]);
  api.messages.update = async () => {};
  api.messages.delete = async () => { throw Error('delete failed'); };
  await assert.rejects(Sweeper.act(api, 'delete', sender, {}), /delete failed/);
  assert.deepEqual(sender.ids, [1, 2]);
});

test('read and filter buttons do not delete existing mail', async () => {
  const calls = [];
  const sender = { ids: [1], email: 'a@example.test' };
  const api = { messages: { update: async id => calls.push(id) }, spamFilter: { addSender: async (...args) => calls.push(args) } };
  await Sweeper.act(api, 'read', sender, {});
  await Sweeper.act(api, 'spam', sender, { accountId: 'account1' });
  assert.deepEqual(calls, [1, ['account1', 'a@example.test']]);
  assert.equal(sender.filtered, true);
});

function filterHarness() {
  const Ci = { nsMsgSearchAttrib: { Sender: 1 }, nsMsgSearchOp: { Is: 2, EndsWith: 3 }, nsMsgFilterType: { InboxRule: 1, Manual: 16 }, nsMsgFilterAction: { MarkRead: 4, Delete: 3 } };
  const filters = [];
  let failSave = false;
  const list = {
    getFilterNamed: name => filters.find(f => f.filterName === name),
    createFilter: filterName => ({ filterName, searchTerms: [], actions: [],
      createTerm: () => ({ value: {}, booleanAnd: false }),
      appendTerm(term) { this.searchTerms.push(term); },
      createAction: () => ({}), appendAction(action) { this.actions.push(action); }
    }),
    getFilterAt: i => filters[i], setFilterAt: (i, f) => { filters[i] = f; },
    insertFilterAt: (i, f) => filters.splice(i, 0, f), removeFilter: f => filters.splice(filters.indexOf(f), 1),
    saveToDefaultFile: () => { if (failSave) throw Error('disk full'); }
  };
  const context = { Ci, ChromeUtils: { importESModule: path => path.includes('ExtensionCommon')
    ? { ExtensionCommon: { ExtensionAPI: class {} } }
    : { MailServices: { accounts: { getAccount: id => id === 'account1' ? { incomingServer: { canHaveFilters: true, getFilterList: () => list } } : null } } }
  } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../experiments/spamFilter/api.js'), 'utf8'), context);
  return { filters, add: new context.spamFilter().getAPI().spamFilter.addSender, failSave: () => { failSave = true; } };
}

test('native filter exact OR matches, account scope, action order and duplicate handling', async () => {
  const h = filterHarness();
  await h.add('account1', 'ONE@example.test');
  await h.add('account1', 'two@example.test');
  await h.add('account1', 'one@example.test');
  assert.equal(h.filters.length, 1);
  const f = h.filters[0];
  assert.equal(f.filterName, 'mailSweeperSpam');
  assert.equal(f.enabled, true);
  assert.equal(f.filterType, 17);
  assert.deepEqual(Array.from(f.searchTerms, t => t.value.str), ['one@example.test', 'two@example.test']);
  assert.ok(f.searchTerms.every(t => t.attrib === 1 && t.op === 2 && !t.booleanAnd));
  assert.deepEqual(Array.from(f.actions, a => a.type), [4, 3]);
  await assert.rejects(h.add('other-account', 'one@example.test'), /support/);
});

test('native filter protects custom rules and rolls back failed persistence', async () => {
  const h = filterHarness();
  await h.add('account1', 'one@example.test');
  const old = h.filters[0];
  h.failSave();
  await assert.rejects(h.add('account1', 'two@example.test'), /disk full/);
  assert.equal(h.filters[0], old);
  old.searchTerms[0].booleanAnd = true;
  await assert.rejects(h.add('account1', 'two@example.test'), /custom conditions/);
  assert.equal(h.filters[0], old);
  const fresh = filterHarness();
  fresh.failSave();
  await assert.rejects(fresh.add('account1', 'one@example.test'), /disk full/);
  assert.equal(fresh.filters.length, 0);
});

test('72-hour window includes the cutoff and excludes older, future and invalid dates across pages', async () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const cutoff = now - 72 * 3600000;
  const dates = [new Date(cutoff), new Date(cutoff - 1), new Date(now), new Date(now + 1), undefined, 'invalid'];
  const messages = dates.map((date, i) => ({ id: i + 1, author: 'sender@example.test', date }));
  const result = await Sweeper.scan({
    mailTabs: { query: async () => [{ displayedFolder: { id: 'folder' } }] },
    messages: {
      list: async () => ({ messages: messages.slice(0, 2), id: 'next' }),
      continueList: async () => ({ messages: messages.slice(2) })
    }
  }, now);
  assert.equal(result.senders[0].ids.length, 6);
  assert.equal(result.senders[0].recentCount, 2);
});

test('default thresholds match total OR recent minimum inclusively, retaining all message IDs', () => {
  const senders = [
    { email: 'total', ids: Array.from({ length: 50 }, (_, i) => i), recentCount: 0 },
    { email: 'recent', ids: Array.from({ length: 12 }, (_, i) => i), recentCount: 10 },
    { email: 'hidden', ids: Array(49).fill(1), recentCount: 9 },
    { email: 'deleted', ids: [], recentCount: 10 }
  ];
  assert.deepEqual(Sweeper.visibleSenders(senders).map(s => s.email), ['total', 'recent']);
  assert.equal(Sweeper.visibleSenders(senders)[1].ids.length, 12);
  assert.deepEqual(Sweeper.visibleSenders(senders, 51, 11), []);
  assert.deepEqual(Sweeper.visibleSenders(senders, 49, 11).map(s => s.email), ['total', 'hidden']);
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => Sweeper.visibleSenders(senders, value, 10), /whole number/);
    assert.throws(() => Sweeper.visibleSenders(senders, 50, value), /whole number/);
  }
});

test('domain grouping combines total and recent counts before filtering and keeps exact domains separate', () => {
  const senders = [
    { email: 'alice@web.de', ids: Array.from({length: 25}, (_, i) => i + 1), recentCount: 5 },
    { email: 'bob@web.de', ids: Array.from({length: 25}, (_, i) => i + 26), recentCount: 5 },
    { email: 'other@otherweb.de', ids: [51], recentCount: 1 },
    { email: 'sub@sub.web.de', ids: [52], recentCount: 1 }
  ];
  assert.equal(Sweeper.groupSenders(senders), senders);
  assert.equal(Sweeper.visibleSenders(senders).length, 0);
  const groups = Sweeper.groupSenders(senders, true);
  assert.deepEqual(groups.map(g => g.email), ['*@web.de', '*@otherweb.de', '*@sub.web.de']);
  assert.equal(groups[0].recentCount, 10);
  assert.deepEqual(groups[0].ids, Array.from({length: 50}, (_, i) => i + 1));
  assert.deepEqual(Sweeper.visibleSenders(groups).map(g => g.email), ['*@web.de']);
  assert.deepEqual(Sweeper.visibleSenders(groups, 51, 10).map(g => g.email), ['*@web.de']);
  assert.equal(Sweeper.visibleSenders(groups, 51, 11).length, 0);
});

test('domain deletion marks every member read, deletes only that domain and stays deleted after toggling modes', async () => {
  const senders = [
    { email: 'a@web.de', ids: [1], recentCount: 1 },
    { email: 'b@web.de', ids: [2], recentCount: 1 },
    { email: 'c@otherweb.de', ids: [3], recentCount: 1 }
  ];
  const calls = [];
  const api = { messages: {
    update: async (...args) => calls.push(['update', ...args]),
    delete: async (...args) => calls.push(['delete', ...args])
  } };
  await Sweeper.act(api, 'delete', Sweeper.groupSenders(senders, true)[0], {});
  assert.deepEqual(calls, [['update', 1, {read:true}], ['update', 2, {read:true}], ['delete', [1, 2], false]]);
  assert.deepEqual(Sweeper.visibleSenders(senders, 1, 1).map(s => s.email), ['c@otherweb.de']);
  assert.deepEqual(Sweeper.groupSenders(senders, true).map(s => s.email), ['*@otherweb.de']);
});

test('individual deletion updates domain counts; domain read failures prevent deletion and preserve members', async () => {
  const senders = [
    { email: 'a@web.de', ids: [1], recentCount: 1 },
    { email: 'b@web.de', ids: [2, 3], recentCount: 2 }
  ];
  const api = { messages: { update: async () => {}, delete: async () => {} } };
  await Sweeper.act(api, 'delete', senders[0], {});
  let group = Sweeper.groupSenders(senders, true)[0];
  assert.deepEqual(group.ids, [2, 3]);
  assert.equal(group.recentCount, 2);
  api.messages.update = async id => { if (id === 3) throw Error('read failed'); };
  api.messages.delete = async () => assert.fail('must not delete');
  await assert.rejects(Sweeper.act(api, 'delete', group, {}), /read failed/);
  group = Sweeper.groupSenders(senders, true)[0];
  assert.deepEqual(group.ids, [2, 3]);
  assert.equal(group.recentCount, 2);
});

test('domain spam action persists across toggles without claiming an individual rule blocks its entire domain', async () => {
  const senders = [
    { email: 'a@web.de', ids: [1], recentCount: 1 },
    { email: 'b@web.de', ids: [2], recentCount: 1 }
  ];
  const calls = [];
  const api = { spamFilter: { addSender: async (...args) => calls.push(args) } };
  await Sweeper.act(api, 'spam', senders[0], {accountId:'account1'});
  assert.equal(Sweeper.groupSenders(senders, true)[0].filtered, false);
  await Sweeper.act(api, 'spam', Sweeper.groupSenders(senders, true)[0], {accountId:'account1'});
  assert.deepEqual(calls, [['account1', 'a@web.de'], ['account1', '*@web.de', true]]);
  assert.equal(Sweeper.groupSenders(senders, true)[0].filtered, true);
  assert.ok(senders.every(s => s.filtered));
});

test('native filter mixes exact addresses and domain suffixes, preserving rules without duplicates', async () => {
  const h = filterHarness();
  await h.add('account1', 'a@example.test');
  await h.add('account1', '*@WEB.DE', true);
  await h.add('account1', '*@web.de', true);
  await h.add('account1', 'b@example.test');
  const f = h.filters[0];
  assert.deepEqual(Array.from(f.searchTerms, t => [t.op, t.value.str]), [
    [2, 'a@example.test'], [3, '@web.de'], [2, 'b@example.test']
  ]);
  assert.ok(f.searchTerms.every(t => !t.booleanAnd && t.attrib === 1));
  assert.deepEqual(Array.from(f.actions, a => a.type), [4, 3]);
  for (const target of ['web.de', '*@', '*@web.de,other.de', '*@*.web.de', '*@web.de\nother']) {
    await assert.rejects(h.add('account1', target, true), /valid/);
  }
});

test('native domain filter rejects unrelated suffix rules and rolls back failed saves', async () => {
  const h = filterHarness();
  await h.add('account1', '*@web.de', true);
  const old = h.filters[0];
  h.failSave();
  await assert.rejects(h.add('account1', '*@example.test', true), /disk full/);
  assert.equal(h.filters[0], old);
  old.searchTerms[0].value.str = 'de';
  await assert.rejects(h.add('account1', '*@example.test', true), /custom conditions/);
  assert.equal(h.filters[0], old);
});

test('unread thresholds use only unread messages, combining recent unread counts by domain', async () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const recent = new Date(now - 3600000);
  const old = new Date(now - 73 * 3600000);
  let id = 0;
  const messages = [];
  const add = (author, count, read, date) => {
    for (let i = 0; i < count; i++) messages.push({id:++id, author, read, date});
  };
  add('readheavy@example.test', 100, true, recent);
  add('readheavy@example.test', 9, false, recent);
  add('oldunread@example.test', 50, false, old);
  add('a@web.de', 5, false, recent);
  add('b@web.de', 5, false, recent);
  add('b@web.de', 40, true, recent);
  const result = await Sweeper.scan({
    mailTabs: {query:async () => [{displayedFolder:{id:'f'}}]},
    messages: {list:async () => ({messages})}
  }, now);
  assert.deepEqual(Sweeper.visibleSenders(result.senders, 50, 10, true).map(s => s.email), ['oldunread@example.test']);
  assert.equal(Sweeper.visibleSenders(result.senders).length, 3);
  const groups = Sweeper.groupSenders(result.senders, true);
  assert.deepEqual(Sweeper.visibleSenders(groups, 50, 10, true).map(s => s.email), ['*@example.test', '*@web.de']);
  const web = groups.find(g => g.email === '*@web.de');
  assert.equal(web.ids.length, 50);
  assert.equal(web.unreadIds.size, 10);
  assert.equal(web.recentUnreadIds.size, 10);
  assert.deepEqual(Sweeper.visibleSenders(groups, 60, 10, true).map(s => s.email), ['*@web.de']);
});

test('only unread messages within the inclusive 72-hour window count toward the recent unread minimum', async () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const cutoff = now - 72 * 3600000;
  const messages = [
    {id:1, read:false, date:new Date(cutoff)},
    {id:2, read:false, date:new Date(cutoff - 1)},
    {id:3, read:false, date:new Date(now)},
    {id:4, read:true, date:new Date(now)},
    {id:5, read:false, date:new Date(now + 1)},
    {id:6, read:false, date:'invalid'}
  ].map(m => ({...m, author:'a@web.de'}));
  const result = await Sweeper.scan({
    mailTabs: {query:async () => [{displayedFolder:{id:'f'}}]},
    messages: {
      list:async () => ({messages:messages.slice(0,3), id:'next'}),
      continueList:async () => ({messages:messages.slice(3)})
    }
  }, now);
  assert.deepEqual([...result.senders[0].unreadIds], [1,2,3,5,6]);
  assert.deepEqual([...result.senders[0].recentUnreadIds], [1,3]);
  assert.equal(Sweeper.visibleSenders(result.senders, 6, 3, true).length, 0);
  assert.equal(Sweeper.visibleSenders(result.senders, 6, 2, true).length, 1);
});

function unreadSenders() {
  return [
    {email:'a@web.de', ids:[1], recentCount:1, unreadIds:new Set([1]), recentUnreadIds:new Set([1])},
    {email:'b@web.de', ids:[2], recentCount:1, unreadIds:new Set([2]), recentUnreadIds:new Set([2])}
  ];
}

test('marking a domain read clears unread counts in both modes without changing total counts', async () => {
  const senders = unreadSenders();
  const calls = [];
  await Sweeper.act({messages:{update:async id => calls.push(id)}}, 'read', Sweeper.groupSenders(senders, true)[0], {});
  assert.deepEqual(calls, [1,2]);
  assert.equal(Sweeper.visibleSenders(senders, 1, 1, true).length, 0);
  assert.equal(Sweeper.visibleSenders(Sweeper.groupSenders(senders,true), 1, 1, true).length, 0);
  assert.equal(Sweeper.groupSenders(senders,true)[0].ids.length, 2);
  assert.equal(Sweeper.groupSenders(senders,true)[0].recentCount, 2);
});

test('a partial read failure updates only successful unread counts and prevents deletion', async () => {
  const senders = unreadSenders();
  await assert.rejects(Sweeper.act({messages:{
    update:async id => {if (id === 2) throw Error('read failed');},
    delete:async () => assert.fail('must not delete')
  }}, 'delete', Sweeper.groupSenders(senders,true)[0], {}), /read failed/);
  assert.equal(senders[0].unreadIds.size, 0);
  assert.deepEqual([...senders[1].unreadIds], [2]);
  const group = Sweeper.groupSenders(senders,true)[0];
  assert.equal(group.unreadIds.size, 1);
  assert.equal(group.recentUnreadIds.size, 1);
  assert.equal(group.ids.length, 2);
});

test('a failed delete retains messages while reflecting that they were marked read first', async () => {
  const senders = unreadSenders();
  await assert.rejects(Sweeper.act({messages:{
    update:async () => {}, delete:async () => {throw Error('delete failed');}
  }}, 'delete', senders[0], {}), /delete failed/);
  assert.deepEqual(senders[0].ids, [1]);
  assert.equal(senders[0].unreadIds.size, 0);
  assert.equal(Sweeper.groupSenders(senders,true)[0].unreadIds.size, 1);
});

test('Thunderbird mailbox parsing recovers comment-formatted authors across pages and reports skipped messages', async () => {
  const calls = [];
  const api = {
    mailTabs: {query:async () => [{displayedFolder:{id:'folder'}}]},
    messengerUtilities: {parseMailboxString:async author => {
      calls.push(author);
      if (author === 'Alice <alice@web.de> (work)') return [{email:'alice@web.de'}];
      if (author === 'bob@web.de(comment)') return [{email:'bob@web.de'}];
      return [{email:'one@web.de'}, {email:'two@web.de'}];
    }},
    messages: {
      list:async () => ({messages:[
        {id:1, author:'Alice <alice@web.de> (work)', read:false},
        {id:2, author:'bob@web.de(comment)', read:true}
      ], id:'next'}),
      continueList:async () => ({messages:[
        {id:3, author:'Alice <alice@web.de> (work)', read:false},
        {id:4, author:'one@web.de, two@web.de', read:true},
        {id:5, read:false}
      ]})
    }
  };
  const result = await Sweeper.scan(api);
  assert.equal(result.total, 5);
  assert.equal(result.unread, 3);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.senders.map(s => [s.email,s.ids]), [
    ['alice@web.de', [1,3]], ['bob@web.de', [2]]
  ]);
  assert.deepEqual(calls, ['Alice <alice@web.de> (work)', 'bob@web.de(comment)', 'one@web.de, two@web.de']);
});

test('an invalid sender parse does not stop scanning other messages', async () => {
  const result = await Sweeper.scan({
    mailTabs: {query:async () => [{displayedFolder:{id:'folder'}}]},
    messengerUtilities: {parseMailboxString:async () => {throw Error('bad header');}},
    messages:{list:async () => ({messages:[{id:1,author:'bad header'}, {id:2,author:'a@web.de'}]})}
  });
  assert.equal(result.total, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.senders[0].ids, [2]);
});

test('quoted local parts remain individual addresses and group under the correct domain', async () => {
  const author = '"Team" <"sales team@office"@web.de>';
  assert.equal(Sweeper.emailAddress(author), '"sales team@office"@web.de');
  const result = await Sweeper.scan({
    mailTabs:{query:async () => [{displayedFolder:{id:'folder'}}]},
    messages:{list:async () => ({messages:[{id:1,author,read:false}]})}
  });
  assert.equal(result.skipped, 0);
  assert.equal(Sweeper.groupSenders(result.senders,true)[0].email, '*@web.de');
  const h = filterHarness();
  await h.add('account1', result.senders[0].email);
  assert.equal(h.filters[0].searchTerms[0].value.str, '"sales team@office"@web.de');
});

test('the simple sender parser does not select an arbitrary address from a multi-author header', () => {
  assert.equal(Sweeper.emailAddress('One <one@web.de>, Two <two@web.de>'), null);
  assert.equal(Sweeper.emailAddress('one@web.de, Two <two@web.de>'), null);
  assert.equal(Sweeper.emailAddress('"Doe, Jane" <jane@web.de>'), 'jane@web.de');
});
