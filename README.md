# TMC Contract Dashboard

A live dashboard for tracking TMC contracts: upload a contract and it reads the key facts
(parties, start date, closing date, tenure, value, notice period, renewal terms, governing law and
dated milestones), which you check and save. It then shows every contract's status, how much of its
tenure has passed and what deadlines are coming up.

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
- `vendor/`: PDF.js 3.11.174 and Mammoth 1.6.0, served locally
