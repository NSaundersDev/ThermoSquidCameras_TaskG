const SESSION_DATA_BASENAME = /^(\d{6})--([A-Za-z0-9][A-Za-z0-9_-]{0,80})--shot-data$/;

function sessionDataStoredName(fileName) {
  if (typeof fileName !== 'string' || !SESSION_DATA_BASENAME.test(fileName)) return '';
  return `${fileName}.csv`;
}

function isSessionDataFile(fileName) {
  return /^(\d{6})--([A-Za-z0-9][A-Za-z0-9_-]{0,80})--shot-data\.csv$/i.test(String(fileName || ''));
}

module.exports = { sessionDataStoredName, isSessionDataFile };
