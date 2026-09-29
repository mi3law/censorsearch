# CensorSearch

A single static web page that searches a school's banned-materials list, kept in a Google Sheet, more reliably than Ctrl+F. It tolerates moved articles ("Alchemist, The"), missing authors, typos, word order, punctuation and number variants, and links every result to its row in the sheet.

No backend, no stored data, no accounts: the page reads the live sheet (read-only) each time it loads.

Status: PRD under review; development has not started.
