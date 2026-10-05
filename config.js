// CensorSearch settings. This is the only file to edit when pointing the page at another sheet.
// Anyone can also try another sheet without editing it: add ?sheet=<Google Sheets link> or ?script=<Apps Script /exec link>
// to the page address. The search text itself never goes into the address.
window.CENSORSEARCH_CONFIG = {
  // The Google Sheet. Read by link (the default path), it must be shared "Anyone with the link can view"; signed in (see
  // googleClientId), each visitor reads it with their own Google account instead.
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1LIUGEVFv4hLN2JTn2OASTBKW5mr0oXl8pWSQNGFkHck/edit?gid=0#gid=0',
  // Tabs to search, by tab id (the number after gid= in the tab's link), which survives renames; `name` is how results cite the tab.
  tabs: [{ gid: '0', name: 'Sheet1' }],
  // Google sign-in: the OAuth client ID (…apps.googleusercontent.com; public, not a secret). When set, each visitor signs in
  // with Google and the page reads sheetUrl's tabs with their own access, so only people who can view the sheet can search it.
  // It takes precedence over scriptUrl. Setting it up: README.md, "Signing in".
  googleClientId: '',
  // Apps Script web app URL (https://script.google.com/macros/s/<id>/exec). When set, the page reads through it instead of the CSV
  // link above, and the script's own tab list decides which tabs are searched (see apps-script/README.md). sheetUrl should
  // then still name the same sheet: it is the "Open the sheet" link when the script can't be reached.
  scriptUrl: 'https://script.google.com/macros/s/AKfycbx2qUWY6M585ZRUEF4uiDU0Wh9Ntwx0E5PGqZ8Pi8gsrEJ91O3q3bjyp7Tdp9c9MuRncg/exec',
  // The school's own Apps Script, when it is shared as a ?script= link instead of scriptUrl (keeping its address out of this
  // public file): list the code the page shows under "Notes for the list's maintainers" when opened with that link. Any other
  // ?script= link is marked on the page as not its usual list, with no links to the sheet it claims to read.
  trustedScripts: [],
  // This school's own code in the Banned By column; rows with it show "Banned by UAS".
  schoolCode: 'UAS',
  // The alias list (pen names, acronyms, alternate titles), fetched from the same site as the page.
  aliasesUrl: 'aliases.json',
  // Where the page's source code lives; linked in the footer.
  repoUrl: 'https://github.com/mi3law/censorsearch',
};
