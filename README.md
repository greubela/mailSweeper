# Mail Sweeper 1.1

Thunderbird 128 or later. Scan the folder displayed in the active mail tab to see
senders sorted by message count. Two number spinners above the table control visibility:
at least 50 total messages OR at least 10 messages dated within the last 72 hours,
by default. Both minimums accept positive whole numbers and update the list immediately
without rescanning. Counts and the 72-hour window reflect the last scan; rescan to
refresh them. Missing or invalid message dates count toward the total only.
Actions still apply to all messages from a qualifying sender in the scanned folder,
including older messages when the sender qualifies through the recent-message minimum.

Each table row offers:

- **Set to read:** mark that sender's messages in the scanned folder as read.
- **Delete:** finish marking those messages read, then delete them using the account's deletion settings.
- **Add to spam filter:** add the exact address to `mailSweeperSpam` on the scanned folder's account. This does not process existing mail. The enabled native filter runs on incoming mail and is also available for manual execution in Thunderbird's Message Filters dialog.

The filter matches ANY of its addresses and has Mark Read followed by Delete actions.
Adding the same address twice does not duplicate it. An existing filter with custom
conditions is left alone and reported as an error. The native filter persists if
the extension is uninstalled; manage or remove it in Thunderbird's Message Filters.

Keep the popup open while an action runs. Rescan after an error or external mail
changes. Actions use the IDs captured by the scan, so they apply to that folder
even if the active tab changes afterward. Messages with unusable sender addresses
are skipped and counted in the status.

## Installation

Install `mailSweeper-1.1.0.xpi` using Thunderbird's Add-ons Manager gear menu →
Install Add-on From File. The extension uses a privileged Thunderbird Experiment
API to edit native message filters, so Thunderbird requests full access. Manifest
V2 is used for this implementation; no background worker is needed.

## Fixes

The original code queried generic tabs and read `tab.folder`, which is not the
current mail folder. The scan now uses `mailTabs.query()` and `displayedFolder.id`.
The old update call passed an array where one message ID is required, omitted the
update/delete permissions, and never executed deletion. The manifest also referenced
a missing background.js. These issues are corrected.

## Validation

Run `node --test tests/sweeper.test.cjs` for mocked API regression tests, including
pagination, sender grouping, action order, failure handling, filter OR conditions,
duplicate prevention, and rollback when saving fails.

Run `python tests/ui-smoke.py` with Playwright and Chromium at `/usr/bin/chromium`
for the browser UI check. Both test suites use synthetic messages and do not access
real accounts. Native Thunderbird integration could not be tested in this workspace;
verify filter behavior with a test account before relying on automatic filtering.
