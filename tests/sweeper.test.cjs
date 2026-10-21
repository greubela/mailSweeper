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
  const Ci = { nsMsgSearchAttrib: { Sender: 1 }, nsMsgSearchOp: { Is: 2 }, nsMsgFilterType: { InboxRule: 1, Manual: 16 }, nsMsgFilterAction: { MarkRead: 4, Delete: 3 } };
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
