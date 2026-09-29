// CensorSearch settings. This is the only file to edit when pointing the page at another sheet.
// Anyone can also try another sheet without editing it: add ?sheet=<Google Sheets link> or ?script=<Apps Script /exec link>
// to the page address. The search text itself never goes into the address.
window.CENSORSEARCH_CONFIG = {
  // The Google Sheet read by link (the default path). It must be shared "Anyone with the link can view".
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1fnfj7W8ZZvBSFNTfkyqPKupGUrvw79etZYF_ZHWVhzo/edit?gid=0#gid=0',
  // Tabs to search, by tab id (the number after gid= in the tab's link), which survives renames; `name` is how results cite the tab.
  tabs: [{ gid: '0', name: 'Sheet1' }],         // v1: main tab only; add { gid: '1111920478', name: 'Other Materials' } to search it too
  // Apps Script web app URL (https://script.google.com/macros/s/<id>/exec). When set, the page reads through it instead of the CSV
  // link above, and the script's own tab list decides which tabs are searched (see apps-script/README.md).
  scriptUrl: '',
  // This school's own code in the Banned By column; rows with it show "Banned by UAS".
  schoolCode: 'UAS',
  // The alias list (pen names, acronyms, alternate titles), fetched from the same site as the page.
  aliasesUrl: 'aliases.json',
  // Where the page's source code lives; linked in the footer.
  repoUrl: 'https://github.com/mi3law/censorsearch',
};
