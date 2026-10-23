# Mail Sweeper

Thunderbird 128 or later. Scan the folder displayed in the active mail tab to see
senders sorted by message count. Two number spinners above the table control visibility:
at least 50 total messages OR at least 10 messages dated within the last 72 hours,
by default. Both minimums accept positive whole numbers and update the list immediately
without rescanning. Counts and the 72-hour window reflect the last scan; rescan to
refresh them. Missing or invalid message dates count toward the total only.
The scan includes only the selected folder, excluding subfolders. The summary shows
messages scanned, unread messages at scan time, groups hidden by the filters, and
messages skipped because their sender is missing or ambiguous. **Show all senders**
sets both minimums to 1 and turns off unread-only counting, preserving domain grouping.
Actions still apply to all messages from a qualifying sender in the scanned folder,
including older messages when the sender qualifies through the recent-message minimum.

**Group by domain** is unchecked by default, so each address has its own row.
Check it to combine all addresses at the same domain into a row such as `*@web.de`.
Both thresholds use the combined counts, and read/delete actions affect all messages
in that domain group. Switching modes regroups the last scan immediately.
Domains are exact: `web.de`, `sub.web.de`, and `otherweb.de` remain separate.

**Count only unread mail** is also unchecked by default. Enable it to apply both
minimums to unread messages only, including the unread count within the last 72
hours. This works for individual addresses and combined domains. The table shows
unread counts in this mode. Read/delete actions still apply to all mail in the row;
after marking mail read, its unread counts update immediately.

Each table row offers:

- **Set to read:** mark that sender's messages in the scanned folder as read.
- **Delete:** finish marking those messages read, then delete them using the account's deletion settings.
- **Add to spam filter:** add the address, or the whole domain when grouping is enabled, to `mailSweeperSpam` on the scanned folder's account. This does not process existing mail. The enabled native filter runs on incoming mail and is also available for manual execution in Thunderbird's Message Filters dialog.

The filter matches ANY of its addresses or domains and has Mark Read followed by Delete actions.
Domain rules use Thunderbird's sender “ends with” condition, e.g. `@web.de`.
Adding the same address twice does not duplicate it. An existing filter with custom
conditions is left alone and reported as an error. The native filter persists if
the extension is uninstalled; manage or remove it in Thunderbird's Message Filters.

Keep the popup open while an action runs. Rescan after an error or external mail
changes. Actions use the IDs captured by the scan, so they apply to that folder
even if the active tab changes afterward. Messages with unusable sender addresses
are skipped and counted in the summary. Thunderbird's mailbox parser is used for
sender formats with comments; quoted local parts are also supported. A message
with multiple From addresses is counted as skipped rather than assigned arbitrarily.

## Installation

Zip `manifest.json`, `popup.html`, `popup.css`, `popup.js`, `sweeper.js`, and the
`experiments/` directory at the archive root, then rename the archive to `.xpi`.
Install it using Thunderbird's Add-ons Manager gear menu → Install Add-on From File.
The extension uses a privileged Thunderbird Experiment
API to edit native message filters, so Thunderbird requests full access. Manifest
V2 is used for this implementation; no background worker is needed.

## Fixes

The original code queried generic tabs and read `tab.folder`, which is not the
current mail folder. The scan now uses `mailTabs.query()` and `displayedFolder.id`.
The old update call passed an array where one message ID is required, omitted the
update/delete permissions, and never executed deletion. The manifest also referenced
a missing background.js. These issues are corrected.

## Validation

The only test setup is Node's built-in test runner; no packages need installing.
Run `node --test tests/sweeper.test.cjs` for mocked API regression tests, including
pagination, address/domain grouping, action order, failure handling, filter OR conditions,
duplicate prevention, and rollback when saving fails.

Tests use synthetic messages and do not access real accounts. For a manual check
in Thunderbird, open the toolbar popup, scan a test folder, adjust both minimums,
and try each sender action. Check `mailSweeperSpam` in Message Filters.

The popup establishes a 760 × 580px size on both the document and body before the
external stylesheet loads. The table fills the remaining space and scrolls inside
the popup; it does not depend on Thunderbird resizing the panel after a scan.
