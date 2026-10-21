from pathlib import Path
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(Path(__file__).resolve().parents[1])))
Thread(target=server.serve_forever, daemon=True).start()
bootstrap = '''
window.calls = [];
window.messenger = {
 mailTabs: { query: async () => [{displayedFolder: {id:'folder', accountId:'account1', path:'/Inbox'}}] },
 messages: {
  list: async () => ({messages: [{id:1,author:'Bulk <BULK@example.test>'},{id:2,author:'bulk@example.test'},{id:3,author:'small@example.test'}]}),
  update: async (...args) => { calls.push(['update', ...args]); },
  delete: async (...args) => { calls.push(['delete', ...args]); }
 },
 spamFilter: { addSender: async (...args) => { calls.push(['filter', ...args]); } }
};
'''
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
    page = browser.new_page(viewport={'width':800, 'height':650})
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(bootstrap)
    page.goto(f'http://127.0.0.1:{server.server_port}/popup.html')
    assert page.get_by_role('spinbutton', name='Minimum messages (total)', exact=True).input_value() == '50'
    assert page.get_by_role('spinbutton', name='Minimum messages (last 72 hours)', exact=True).input_value() == '10'
    page.locator('#scanBtn').click()
    page.wait_for_function("document.querySelector('#senderList').textContent.includes('No senders meet')")
    page.locator('#minTotal').fill('2')
    page.wait_for_function("document.querySelectorAll('tbody tr').length === 1")
    page.locator('#minTotal').fill('1')
    page.wait_for_function("document.querySelectorAll('tbody tr').length === 2")
    page.locator('#minRecent').fill('')
    assert page.locator('tbody tr').count() == 0
    assert 'whole number' in page.locator('#status').inner_text()
    page.locator('#minRecent').fill('10')
    page.wait_for_function("document.querySelectorAll('tbody tr').length === 2")
    assert page.locator('thead th').all_text_contents() == ['Nr of mails','Mail address','Set to read','Delete','Add to spam filter']
    assert page.locator('tbody tr').first.locator('td').first.inner_text() == '2'
    page.get_by_role('button', name='Set to read: bulk@example.test', exact=True).click()
    page.wait_for_function("document.querySelector('#status').textContent.includes('Marked 2')")
    page.get_by_role('button', name='Add to spam filter: bulk@example.test', exact=True).click()
    page.wait_for_function("document.querySelector('#status').textContent.includes('mailSweeperSpam')")
    assert page.get_by_role('button', name='Add to spam filter: bulk@example.test', exact=True).is_disabled()
    page.get_by_role('button', name='Delete: bulk@example.test', exact=True).click()
    page.wait_for_function("document.querySelector('#status').textContent.includes('deleted 2')")
    assert page.locator('tbody tr').count() == 1
    assert page.get_by_role('button', name='Delete: bulk@example.test', exact=True).count() == 0
    assert page.evaluate('calls') == [ ['update',1,{'read':True}], ['update',2,{'read':True}], ['filter','account1','bulk@example.test'], ['update',1,{'read':True}], ['update',2,{'read':True}], ['delete',[1,2],False] ]
    page.evaluate("messenger.mailTabs.query = async () => []")
    page.locator('#scanBtn').click()
    page.wait_for_function("document.querySelector('#status').textContent.includes('navigate')")
    assert page.locator('tbody tr').count() == 0
    assert page.locator('#scanBtn').is_enabled()
    page.evaluate('''() => {
      const now = Date.now();
      const old = new Date(now - 73 * 3600000);
      const recent = new Date(now - 3600000);
      const messages = [
        ...Array.from({length:50}, (_,i) => ({id:i+1,author:'total@example.test',date:old})),
        ...Array.from({length:10}, (_,i) => ({id:i+51,author:'recent@example.test',date:recent})),
        ...Array.from({length:9}, (_,i) => ({id:i+61,author:'hidden@example.test',date:recent}))
      ];
      messenger.mailTabs.query = async () => [{displayedFolder:{id:'folder',accountId:'account1'}}];
      messenger.messages.list = async () => ({messages});
    }''')
    page.locator('#minTotal').fill('50')
    page.locator('#scanBtn').click()
    page.wait_for_function("document.querySelectorAll('tbody tr').length === 2")
    assert page.locator('tbody tr td:nth-child(2)').all_text_contents() == ['total@example.test','recent@example.test']
    page.locator('#minRecent').fill('9')
    page.wait_for_function("document.querySelectorAll('tbody tr').length === 3")
    page.locator('#minTotal').fill('51')
    page.wait_for_function("document.querySelectorAll('tbody tr').length === 2")
    assert page.locator('tbody tr td:nth-child(2)').all_text_contents() == ['recent@example.test','hidden@example.test']
    assert not errors, errors
    browser.close()
server.shutdown()
print('PASS: default thresholds, live OR filtering, invalid input, table actions, read-before-delete, filter button, missing folder and rescan')
