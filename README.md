# TMC Contract Dashboard

A live dashboard for tracking TMC contracts: upload a contract and it reads the key facts
(parties, start date, closing date, tenure, value, notice period, renewal terms, governing law and
dated milestones), which you check and save. It then shows every contract's status, how much of its
tenure has passed and what deadlines are coming up.

## Categories

Every item belongs to one of three categories, each with its own tab:

| Category | Sub-types |
|---|---|
| **B2B** | Client · Consultant / Teacher · Vendor |
| **RTD** | Client · Sourcing partner |
| **Compliance** | GST · Income tax / TDS · ROC / MCA · Licence / registration · Other |

The category and sub-type are suggested from the document's wording when it is uploaded. Compliance
documents use their own fields (period, reference no. such as ARN / SRN, GSTIN / PAN / CIN, filed
date, next due date, amount paid) and show "Due soon" / "Overdue" instead of contract statuses. For
monthly GSTR-3B and GSTR-1 returns the next due date (20th / 11th) is suggested from the return period.

## Google Calendar reminders

Give each contract / document an **Owner email**. Its key dates then go to Google Calendar with the
owner invited:

- the closing / due date
- the last day to give notice (contract end minus notice period)
- a "Start renewal" / "Prepare filing" heads-up (14–90 days before, set in Settings)
- open milestones

**Automatic (recommended):** Settings → Google Calendar → Set up. You paste the script from
`apps-script/Code.gs` (the dashboard fills in a private key) into a new Google Apps Script project
and deploy it as a web app ("Execute as: Me", "Who has access: Anyone"). It runs under your Google
account, so the events sit in your calendar for follow-up and owners receive invitations. Events are
updated when dates change and removed when a milestone is ticked off or an item is deleted.

**Manual:** without the set-up, the calendar icon next to each date opens Google Calendar with the
event pre-filled and the owner added as a guest.

## How it is put together

| Piece | Where it lives | Who can see it |
|---|---|---|
| The website (this repository) | `tmc-contract-dashboard`, published with GitHub Pages | Public code; contains **no contract data** |
| Contracts and their facts | A separate **private** repository, `tmc-contracts-data` | Only you and people you invite |

The website talks straight to GitHub from your browser using an access token you paste in once per
device. Uploaded files go to `files/<id>/` in the data repository and the facts go to
`contracts.json`, so every change is versioned in Git history.

## Using it

1. Open the site and connect it with your GitHub username, `tmc-contracts-data` and an access token
   (fine-grained, **Contents: Read and write**, on `tmc-contracts-data` only).
2. Click **Upload contract**, then drop in a PDF, Word (.docx) or text file.
3. Check the facts that were filled in, tick the milestones you want to track and click **Save**.
4. Click any contract to see its facts, tick off milestones, add new ones, open the original
   document, edit or delete it.

The page refreshes from GitHub every 2 minutes and whenever you come back to the tab, so changes
made on another device show up automatically.

Notes:
- Scanned (image-only) PDFs contain no text to read; they are still stored, but type the facts in.
- Facts are found by pattern matching, so always check them before saving.
- To give a colleague access, invite them to `tmc-contracts-data` and have them create their own token.

## Files

- `index.html`: page layout
- `css/styles.css`: styling (light and dark mode)
- `js/store.js`: reading and writing the private data repository through the GitHub API
- `js/extract.js`: text extraction and fact detection
- `js/app.js`: dashboard behaviour
- `js/calendar.js`: Google Calendar events and links
- `apps-script/Code.gs`: the Google Apps Script that writes calendar events
- `vendor/`: PDF.js 3.11.174 and Mammoth 1.6.0, served locally
